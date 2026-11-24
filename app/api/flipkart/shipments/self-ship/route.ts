import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

const ACTIONS = {
  delivery: { path: "/sellers/v3/shipments/selfShip/delivery", status: "DELIVERED" },
  deliveryAttempt: { path: "/sellers/v3/shipments/selfShip/deliveryAttempt", status: "DELIVERY_ATTEMPTED" },
} as const;

export const runtime = "nodejs";
export const maxDuration = 60;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function required(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const action = body?.action as keyof typeof ACTIONS;
    if (!(action in ACTIONS)) throw new Error("Unsupported self-ship action.");

    const shipmentIds = parseStringList(body?.shipmentIds, "shipmentIds", 100);
    if (!datePattern.test(String(body?.deliveryDate ?? ""))) throw new Error("deliveryDate must use yyyy-MM-dd format.");
    if (action === "deliveryAttempt" && !datePattern.test(String(body?.newDeliveryDate ?? ""))) throw new Error("newDeliveryDate must use yyyy-MM-dd format.");
    const { data: shipments, error } = await supabaseAdmin
      .from("shipments")
      .select("id,flipkart_shipment_id,location_id,shipment_type,state")
      .eq("user_id", userId)
      .in("flipkart_shipment_id", shipmentIds);
    if (error) throw error;
    if ((shipments ?? []).length !== shipmentIds.length) throw new Error("One or more shipment IDs are not present in the seller account.");

    const requestedLocationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";
    const dbLocationIds = [...new Set((shipments ?? []).map((row) => row.location_id).filter(Boolean))];
    let locationId = requestedLocationId;
    if (!locationId && dbLocationIds.length === 1) {
      const { data: location } = await supabaseAdmin.from("locations").select("flipkart_location_id").eq("user_id", userId).eq("id", dbLocationIds[0]).maybeSingle();
      locationId = location?.flipkart_location_id ?? "";
    }
    if (!locationId) throw new Error("locationId is required when the selected shipments span multiple or unknown locations.");

    const rows = shipmentIds.map((shipmentId) => {
      const row: Record<string, unknown> = {
        shipmentId,
        locationId,
        deliveryDate: required(body?.deliveryDate, "deliveryDate"),
      };
      if (action === "deliveryAttempt") {
        row.failureAttributes = Array.isArray(body?.failureAttributes) ? body.failureAttributes : [];
        if (!row.failureAttributes || (row.failureAttributes as unknown[]).length === 0) throw new Error("failureAttributes is required.");
        row.newDeliveryDate = required(body?.newDeliveryDate, "newDeliveryDate");
        row.reason = required(body?.reason, "reason");
        if (body?.subReason) row.subReason = String(body.subReason);
      }
      return row;
    });

    const result = await flipkartRequest<{ shipments?: Array<{ shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }> }>(ACTIONS[action].path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipments: rows }),
    });

    const responseRows = result.data.shipments ?? [];
    const succeeded = responseRows.filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS").map((row) => row.shipmentId).filter((id): id is string => Boolean(id));

    if (succeeded.length) {
      const { data: shipmentRows, error: shipmentLookupError } = await supabaseAdmin
        .from("shipments")
        .select("id,flipkart_shipment_id")
        .eq("user_id", userId)
        .in("flipkart_shipment_id", succeeded);
      if (shipmentLookupError) throw shipmentLookupError;
      const { error: updateError } = await supabaseAdmin.from("shipments").update({ state: ACTIONS[action].status, updated_at: new Date().toISOString() }).eq("user_id", userId).in("flipkart_shipment_id", succeeded);
      if (updateError) throw updateError;
      const { error: eventError } = await supabaseAdmin.from("shipment_events").insert((shipmentRows ?? []).map((row) => ({ user_id: userId, shipment_id: row.id, event_type: ACTIONS[action].status, event_timestamp: new Date().toISOString(), source: "seller_action", payload: { action, flipkart_shipment_id: row.flipkart_shipment_id } })));
      if (eventError) throw eventError;
    }

    await logFlipkartMutation({ userId, method: "POST", endpoint: ACTIONS[action].path, requestMeta: { action, shipmentIds }, responseMeta: { succeeded, results: responseRows }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, action, succeeded, results: responseRows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Self-ship action failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/selfShip/*", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
