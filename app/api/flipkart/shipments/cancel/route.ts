import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

const REASONS = new Set(["cannot_procure_item", "not_enough_inventory", "b2b_order"]);

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const shipmentIds = parseStringList(body?.shipmentIds, "shipmentIds", 100);
    const requestedLocationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!REASONS.has(reason)) throw new Error("reason must be cannot_procure_item, not_enough_inventory, or b2b_order.");

    const { data: owned, error } = await supabaseAdmin.from("shipments")
      .select("id,flipkart_shipment_id,location_id,order_id,locations:location_id(flipkart_location_id)")
      .eq("user_id", userId).in("flipkart_shipment_id", shipmentIds);
    if (error) throw error;
    if ((owned ?? []).length !== shipmentIds.length) throw new Error("One or more shipment IDs are not present in the seller account.");

    let cancellationGroupIds: string[] = Array.isArray(body?.cancellationGroupIds) && body.cancellationGroupIds.length
      ? parseStringList(body.cancellationGroupIds, "cancellationGroupIds", 100)
      : [];
    if (!cancellationGroupIds.length) {
      const shipmentDbIds = (owned ?? []).map((row) => row.id);
      const { data: shipmentItems, error: shipmentItemError } = await supabaseAdmin
        .from("shipment_items").select("order_item_id").in("shipment_id", shipmentDbIds);
      if (shipmentItemError) throw shipmentItemError;
      const orderItemIds = [...new Set((shipmentItems ?? []).map((row) => row.order_item_id).filter((value): value is string => Boolean(value)))];
      if (!orderItemIds.length) throw new Error("No order items are linked to the shipment. Supply cancellationGroupIds explicitly.");
      const { data: items, error: itemError } = await supabaseAdmin.from("order_items")
        .select("cancellation_group_id").eq("user_id", userId).in("id", orderItemIds);
      if (itemError) throw itemError;
      cancellationGroupIds = [...new Set((items ?? []).map((row) => row.cancellation_group_id).filter((value): value is string => Boolean(value)))];
      if (!cancellationGroupIds.length) throw new Error("No cancellation group IDs are available. Supply cancellationGroupIds explicitly.");
    }

    const derivedLocations = Array.from(new Set((owned ?? []).map((row) => {
      const location = Array.isArray(row.locations) ? row.locations[0] : row.locations;
      return location?.flipkart_location_id ?? null;
    }).filter(Boolean))) as string[];
    const locationId = requestedLocationId || (derivedLocations.length === 1 ? derivedLocations[0] : "");
    if (!locationId) throw new Error("locationId is required when shipments span multiple or unknown dispatch locations.");

    const result = await flipkartRequest<{ shipments?: Array<{ shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }> }>("/sellers/v3/shipments/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipments: shipmentIds.map((shipmentId) => ({ shipmentId, locationId, cancellationGroupIds, reason })) }),
    });

    const rows = result.data.shipments ?? [];
    const succeeded = rows.filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS").map((row) => row.shipmentId).filter((id): id is string => Boolean(id));
    if (succeeded.length) {
      const { data: shipmentRows, error: shipmentLookupError } = await supabaseAdmin
        .from("shipments")
        .select("id,flipkart_shipment_id")
        .eq("user_id", userId)
        .in("flipkart_shipment_id", succeeded);
      if (shipmentLookupError) throw shipmentLookupError;
      const { error: updateError } = await supabaseAdmin.from("shipments").update({ state: "CANCELLED" }).eq("user_id", userId).in("flipkart_shipment_id", succeeded);
      if (updateError) throw updateError;
      const { error: eventError } = await supabaseAdmin.from("shipment_events").insert((shipmentRows ?? []).map((row) => ({ user_id: userId, shipment_id: row.id, event_type: "CANCELLED", event_timestamp: new Date().toISOString(), source: "seller_action", payload: { action: "cancel", flipkart_shipment_id: row.flipkart_shipment_id, reason, cancellationGroupIds } })));
      if (eventError) throw eventError;
    }

    await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/cancel", requestMeta: { shipmentIds, locationId, reason, cancellationGroupIds }, responseMeta: { succeeded, rows }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment cancellation failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/cancel", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
