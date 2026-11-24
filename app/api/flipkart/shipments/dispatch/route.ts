import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Result = { shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string };

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const shipmentIds = parseStringList(body?.shipmentIds, "shipmentIds", 100);
    const requestedLocationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";

    const { data: owned, error } = await supabaseAdmin.from("shipments")
      .select("flipkart_shipment_id,location_id,state,locations:location_id(flipkart_location_id)")
      .eq("user_id", userId).in("flipkart_shipment_id", shipmentIds);
    if (error) throw error;
    if ((owned ?? []).length !== shipmentIds.length) throw new Error("One or more shipment IDs are not present in the seller account.");
    if ((owned ?? []).some((row) => String(row.state ?? "").toUpperCase() !== "PACKED")) throw new Error("Only PACKED shipments can be marked Ready to Dispatch.");

    const derivedLocations = Array.from(new Set((owned ?? []).map((row) => {
      const location = Array.isArray(row.locations) ? row.locations[0] : row.locations;
      return location?.flipkart_location_id ?? null;
    }).filter(Boolean))) as string[];
    const locationId = requestedLocationId || (derivedLocations.length === 1 ? derivedLocations[0] : "");
    if (!locationId) throw new Error("locationId is required when shipments span multiple or unknown dispatch locations.");

    const result = await flipkartRequest<{ shipments?: Result[] }>("/sellers/v3/shipments/dispatch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipmentIds, locationId }),
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
      const { error: updateError } = await supabaseAdmin.from("shipments").update({ state: "READY_TO_DISPATCH" }).eq("user_id", userId).in("flipkart_shipment_id", succeeded);
      if (updateError) throw updateError;
      const { error: eventError } = await supabaseAdmin.from("shipment_events").insert((shipmentRows ?? []).map((row) => ({ user_id: userId, shipment_id: row.id, event_type: "READY_TO_DISPATCH", event_timestamp: new Date().toISOString(), source: "seller_action", payload: { action: "dispatch", flipkart_shipment_id: row.flipkart_shipment_id } })));
      if (eventError) throw eventError;
    }

    await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/dispatch", requestMeta: { shipmentIds, locationId }, responseMeta: { succeeded, rows }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment dispatch failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/dispatch", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
