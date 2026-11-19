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
    const locationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const cancellationGroupIds = parseStringList(body?.cancellationGroupIds, "cancellationGroupIds", 100);
    if (!locationId) throw new Error("locationId is required.");
    if (!REASONS.has(reason)) throw new Error("reason must be cannot_procure_item, not_enough_inventory, or b2b_order.");

    const { data: owned, error } = await supabaseAdmin.from("shipments")
      .select("flipkart_shipment_id").eq("user_id", userId).in("flipkart_shipment_id", shipmentIds);
    if (error) throw error;
    if ((owned ?? []).length !== shipmentIds.length) throw new Error("One or more shipment IDs are not present in the seller account.");

    const result = await flipkartRequest<{ shipments?: Array<{ shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }> }>("/sellers/v3/shipments/cancel", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipments: shipmentIds.map((shipmentId) => ({ shipmentId, locationId, cancellationGroupIds, reason })) }),
    });

    const rows = result.data.shipments ?? [];
    const succeeded = rows.filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS").map((row) => row.shipmentId).filter((id): id is string => Boolean(id));
    if (succeeded.length) await supabaseAdmin.from("shipments").update({ state: "CANCELLED" }).eq("user_id", userId).in("flipkart_shipment_id", succeeded);

    await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/cancel", requestMeta: { shipmentIds, locationId, reason, cancellationGroupIds }, responseMeta: { succeeded, rows }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment cancellation failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/cancel", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
