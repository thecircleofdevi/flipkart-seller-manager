import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const shipmentIds = parseStringList(body?.shipmentIds, "shipmentIds", 100);
    if (!Array.isArray(body?.shipments) || body.shipments.length !== shipmentIds.length) {
      throw new Error("shipments must contain one pack payload per shipmentId.");
    }

    const payload = { shipments: body.shipments };
    const suppliedIds = body.shipments.map((item: unknown) => typeof (item as { shipmentId?: unknown })?.shipmentId === "string" ? (item as { shipmentId: string }).shipmentId : "");
    if (suppliedIds.some((id: string) => !shipmentIds.includes(id))) throw new Error("Pack payload shipment IDs do not match shipmentIds.");

    const { data: owned, error } = await supabaseAdmin.from("shipments")
      .select("flipkart_shipment_id").eq("user_id", userId).in("flipkart_shipment_id", shipmentIds);
    if (error) throw error;
    if ((owned ?? []).length !== shipmentIds.length) throw new Error("One or more shipment IDs are not present in the seller account.");

    const result = await flipkartRequest<{ shipments?: Array<{ shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }> }>("/sellers/v3/shipments/labels", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const rows = result.data.shipments ?? [];
    const succeeded = rows.filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS").map((row) => row.shipmentId).filter((id): id is string => Boolean(id));
    if (succeeded.length) await supabaseAdmin.from("shipments").update({ state: "PACKING_IN_PROGRESS" }).eq("user_id", userId).in("flipkart_shipment_id", succeeded);

    await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/labels", requestMeta: { shipmentIds }, responseMeta: { succeeded, rows }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment pack failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/v3/shipments/labels", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
