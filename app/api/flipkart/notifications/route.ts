import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function verifyNotification(request: Request) {
  const date = request.headers.get("x_date") ?? request.headers.get("x-date");
  const authorization = request.headers.get("x_authorization") ?? request.headers.get("x-authorization");
  if (!date || !authorization) return false;

  const match = authorization.match(/^FKLOGIN\s+(.+)$/i);
  if (!match) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator <= 0) return false;
  const appId = decoded.slice(0, separator);
  const signature = decoded.slice(separator + 1);
  if (appId !== requiredEnv("FLIPKART_APP_ID")) return false;

  const expected = createHash("sha1")
    .update(date + request.url + request.method + requiredEnv("FLIPKART_APP_SECRET"), "utf8")
    .digest("hex");

  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function findString(payload: Record<string, unknown>, keys: string[]): string | null {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

export async function POST(request: Request) {
  const body = await request.text();

  if (!verifyNotification(request)) {
    return NextResponse.json({ ok: false, error: "Invalid notification signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const eventType =
    typeof payload.eventType === "string"
      ? payload.eventType
      : typeof payload.event_type === "string"
        ? payload.event_type
        : "unknown";

  const timestampValue = findString(payload, ["timestamp", "eventTimestamp", "event_timestamp"]);
  const shipmentId = findString(payload, ["shipmentId", "shipment_id"]);
  const locationId = findString(payload, ["locationId", "location_id"]);
  const returnId = findString(payload, ["returnId", "return_id"]);

  const userId = requiredEnv("FLIPKART_OWNER_USER_ID");
  const eventKey = createHash("sha256").update(body, "utf8").digest("hex");

  const { data: existingNotification } = await supabaseAdmin.from("notifications")
    .select("id,processing_status")
    .eq("user_id", userId)
    .eq("event_key", eventKey)
    .maybeSingle();

  if (existingNotification) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const { data: notification, error } = await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    event_type: eventType,
    shipment_id: shipmentId,
    location_id: locationId,
    event_timestamp: timestampValue,
    received_at: new Date().toISOString(),
    payload,
    processing_status: "received",
    event_key: eventKey,
  }).select("id").single();

  if (error) return NextResponse.json({ ok: false, error: "Notification storage failed." }, { status: 500 });

  try {
    if (shipmentId) {
      const { data: shipment } = await supabaseAdmin.from("shipments")
        .select("id")
        .eq("user_id", userId)
        .eq("flipkart_shipment_id", shipmentId)
        .maybeSingle();

      if (shipment) {
        const { error: eventError } = await supabaseAdmin.from("shipment_events").insert({
          user_id: userId,
          shipment_id: shipment.id,
          event_type: eventType,
          event_timestamp: timestampValue ?? new Date().toISOString(),
          source: "notification",
          payload,
        });
        if (eventError) throw eventError;

        const stateMap: Record<string, string> = {
          "Shipment Created": "APPROVED",
          "Packed": "PACKED",
          "Ready To Dispatch": "READY_TO_DISPATCH",
          "Pickup Complete": "PICKUP_COMPLETE",
          "Shipped": "SHIPPED",
          "Delivered": "DELIVERED",
          "Shipment Cancelled": "CANCELLED",
        };
        const nextState = stateMap[eventType];
        if (nextState) {
          const { error: updateError } = await supabaseAdmin.from("shipments")
            .update({ state: nextState })
            .eq("id", shipment.id)
            .eq("user_id", userId);
          if (updateError) throw updateError;
        }
      }
    }

    if (returnId) {
      const { data: returnRow } = await supabaseAdmin.from("returns")
        .select("id")
        .eq("user_id", userId)
        .eq("flipkart_return_id", returnId)
        .maybeSingle();

      if (returnRow) {
        const returnStateMap: Record<string, string> = {
          "Return Created": "CREATED",
          "Return Completed": "COMPLETED",
          "Return Cancelled": "CANCELLED",
          "Return PickedUp": "PICKED_UP",
        };
        const nextState = returnStateMap[eventType];
        if (nextState) {
          const { error: updateError } = await supabaseAdmin.from("returns")
            .update({ status: nextState })
            .eq("id", returnRow.id)
            .eq("user_id", userId);
          if (updateError) throw updateError;
        }
        const { error: eventError } = await supabaseAdmin.from("return_events").insert({
          user_id: userId,
          return_id: returnRow.id,
          event_type: eventType,
          event_timestamp: timestampValue ?? new Date().toISOString(),
          payload,
        });
        if (eventError) throw eventError;
      }
    }

    const { error: processedError } = await supabaseAdmin.from("notifications")
      .update({ processing_status: "processed", processing_error: null })
      .eq("id", notification.id)
      .eq("user_id", userId);
    if (processedError) throw processedError;

    return NextResponse.json({ ok: true, processed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification processing failed";
    await supabaseAdmin.from("notifications")
      .update({ processing_status: "failed", processing_error: message })
      .eq("id", notification.id)
      .eq("user_id", userId);
    return NextResponse.json({ ok: false, error: "Notification processing failed." }, { status: 500 });
  }
}
