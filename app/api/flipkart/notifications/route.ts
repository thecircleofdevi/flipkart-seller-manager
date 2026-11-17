import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function verifyNotification(request: Request, body: string) {
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
    .update(
      date +
        request.url +
        request.method +
        requiredEnv("FLIPKART_APP_SECRET"),
      "utf8",
    )
    .digest("hex");

  const left = Buffer.from(signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  const body = await request.text();

  if (!verifyNotification(request, body)) {
    return NextResponse.json({ ok: false, error: "Invalid notification signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const eventType = typeof payload.eventType === "string" ? payload.eventType : "unknown";
  const source = typeof payload.source === "string" ? payload.source : "flipkart";
  const timestamp =
    typeof payload.timestamp === "string" ? payload.timestamp : null;
  const attributes =
    payload.attributes && typeof payload.attributes === "object"
      ? (payload.attributes as Record<string, unknown>)
      : {};

  const shipmentId =
    typeof payload.shipmentId === "string"
      ? payload.shipmentId
      : typeof attributes.shipmentId === "string"
        ? attributes.shipmentId
        : null;

  const locationId =
    typeof payload.locationId === "string"
      ? payload.locationId
      : typeof attributes.locationId === "string"
        ? attributes.locationId
        : null;

  const userId = requiredEnv("FLIPKART_OWNER_USER_ID");

  const { error } = await supabaseAdmin.from("notifications").insert({
    user_id: userId,
    event_type: eventType,
    shipment_id: shipmentId,
    location_id: locationId,
    event_timestamp: timestamp,
    received_at: new Date().toISOString(),
    payload: { source, ...payload },
    processing_status: "received",
  });

  if (error) {
    return NextResponse.json(
      { ok: false, error: "Notification storage failed." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
