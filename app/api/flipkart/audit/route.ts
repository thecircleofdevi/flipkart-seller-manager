import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  if (user.id !== process.env.FLIPKART_OWNER_USER_ID) throw new Error("Forbidden");
  return user;
}

export async function GET() {
  try {
    const user = await getUser();
    const uid = user.id;

    const count = async (table: string, extra?: (q: any) => any) => {
      let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true }).eq("user_id", uid);
      if (extra) q = extra(q);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    };

    const [
      orders,
      orderItems,
      shipments,
      shipmentItems,
      shipmentEvents,
      returns,
      returnEvents,
      listings,
      rawPayloads,
      syncRuns,
    ] = await Promise.all([
      count("orders"),
      count("order_items"),
      count("shipments"),
      count("shipment_items"),
      count("shipment_events"),
      count("returns"),
      count("return_events"),
      count("listings"),
      count("raw_flipkart_payloads"),
      count("sync_runs"),
    ]);

    const [
      duplicateOrders,
      duplicateOrderItems,
      duplicateShipments,
      duplicateReturns,
      duplicateListings,
      orphanOrderItems,
      orphanShipments,
      orphanShipmentItems,
      orphanShipmentEvents,
      orphanReturnEvents,
      returnsMissingRelations,
      shipmentsMissingDetails,
      unfinishedSyncs,
    ] = await Promise.all([
      duplicateCount("orders", "flipkart_order_id", uid),
      duplicateCount("order_items", "flipkart_order_item_id", uid),
      duplicateCount("shipments", "flipkart_shipment_id", uid),
      duplicateCount("returns", "flipkart_return_id", uid),
      duplicateCount("listings", "flipkart_listing_id", uid),
      relationCount("order_items", "order_id", "orders", uid),
      relationCount("shipments", "order_id", "orders", uid),
      relationCount("shipment_items", "shipment_id", "shipments", uid),
      relationCount("shipment_events", "shipment_id", "shipments", uid),
      relationCount("return_events", "return_id", "returns", uid),
      relationCountOrNull("returns", "shipment_id", "shipments", uid, "order_item_id", "order_items"),
      missingShipmentDetailCount(uid),
      count("sync_runs", (q: any) => q.in("status", ["running", "pending"])),
    ]);

    const { data: backfillJob } = await supabaseAdmin
      .from("backfill_jobs")
      .select("id,status,start_at,end_at,completed_windows,total_windows,last_error,updated_at,completed_at")
      .eq("user_id", uid)
      .eq("job_key", "historical:2025-03-01:present:v1")
      .maybeSingle();

    let backfill = null;
    if (backfillJob) {
      const { data: windows } = await supabaseAdmin
        .from("backfill_windows")
        .select("status,orders_status,shipments_status,returns_status,window_start,window_end,last_error")
        .eq("backfill_job_id", backfillJob.id)
        .order("window_start", { ascending: true });
      const failed = (windows ?? []).filter((w) => w.status === "failed");
      const incomplete = (windows ?? []).filter((w) => w.status !== "completed");
      backfill = {
        ...backfillJob,
        failedWindows: failed.length,
        incompleteWindows: incomplete.length,
        firstIncompleteWindow: incomplete[0] ?? null,
      };
    }

    const warnings: string[] = [];
    const critical: string[] = [];
    if (backfill && backfill.status !== "completed") warnings.push("Historical backfill is not complete.");
    if (unfinishedSyncs > 0) critical.push(`${unfinishedSyncs} sync run(s) are still marked running/pending.`);
    if (duplicateOrders + duplicateOrderItems + duplicateShipments + duplicateReturns + duplicateListings > 0) critical.push("Duplicate external identifiers exist.");
    if (orphanOrderItems + orphanShipments + orphanShipmentItems + orphanShipmentEvents + orphanReturnEvents > 0) critical.push("Relational orphan records exist.");
    if (shipmentsMissingDetails > 0) warnings.push(`${shipmentsMissingDetails} shipment(s) have incomplete detail enrichment.`);
    warnings.push("Orders API coverage excludes Flipkart Advantage orders and is limited to seller-fulfilment orders.");
    warnings.push("Shipment search has a documented maximum retrieval limit of 5,000 results, so a very large historical shipment population needs additional reconciliation.");
    if (rawPayloads === 0 && (orders + shipments + returns + listings) > 0) warnings.push("No raw Flipkart payloads are stored even though normalized records exist.");

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: { orders, orderItems, shipments, shipmentItems, shipmentEvents, returns, returnEvents, listings, rawPayloads, syncRuns },
      integrity: {
        duplicateOrders,
        duplicateOrderItems,
        duplicateShipments,
        duplicateReturns,
        duplicateListings,
        orphanOrderItems,
        orphanShipments,
        orphanShipmentItems,
        orphanShipmentEvents,
        orphanReturnEvents,
        returnsMissingRelations,
        shipmentsMissingDetails,
      },
      backfill,
      unfinishedSyncs,
      critical,
      warnings,
      overall: critical.length ? "critical" : warnings.length ? "warning" : "healthy",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Audit failed.";
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

async function duplicateCount(table: string, column: string, uid: string) {
  const { data, error } = await supabaseAdmin.from(table).select(column).eq("user_id", uid).not(column, "is", null);
  if (error) throw error;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of data ?? []) {
    const value = String((row as any)[column]);
    if (seen.has(value)) duplicates++;
    else seen.add(value);
  }
  return duplicates;
}

async function relationCount(table: string, fk: string, parent: string, uid: string) {
  const { data, error } = await supabaseAdmin.from(table).select(fk).eq("user_id", uid).not(fk, "is", null);
  if (error) throw error;
  const ids = [...new Set((data ?? []).map((r: any) => r[fk]).filter(Boolean))];
  if (!ids.length) return 0;
  const { data: parents, error: parentError } = await supabaseAdmin.from(parent).select("id").eq("user_id", uid).in("id", ids);
  if (parentError) throw parentError;
  const existing = new Set((parents ?? []).map((r: any) => r.id));
  return ids.filter((id) => !existing.has(id)).length;
}

async function relationCountOrNull(table: string, fk1: string, parent1: string, uid: string, fk2: string, parent2: string) {
  const { data, error } = await supabaseAdmin.from(table).select(`${fk1},${fk2}`).eq("user_id", uid);
  if (error) throw error;
  let missing = 0;
  const ids1 = [...new Set((data ?? []).map((r: any) => r[fk1]).filter(Boolean))];
  const ids2 = [...new Set((data ?? []).map((r: any) => r[fk2]).filter(Boolean))];
  const [p1, p2] = await Promise.all([
    ids1.length ? supabaseAdmin.from(parent1).select("id").eq("user_id", uid).in("id", ids1) : Promise.resolve({ data: [], error: null } as any),
    ids2.length ? supabaseAdmin.from(parent2).select("id").eq("user_id", uid).in("id", ids2) : Promise.resolve({ data: [], error: null } as any),
  ]);
  if (p1.error) throw p1.error;
  if (p2.error) throw p2.error;
  const e1 = new Set((p1.data ?? []).map((r: any) => r.id));
  const e2 = new Set((p2.data ?? []).map((r: any) => r.id));
  const rows: any[] = (data ?? []) as any[];\n  for (const row of rows) if ((row[fk1] && !e1.has(row[fk1])) || (row[fk2] && !e2.has(row[fk2]))) missing++;
  return missing;
}

async function missingShipmentDetailCount(uid: string) {
  const { data, error } = await supabaseAdmin.from("shipments").select("id,address_data,buyer_data,packages_data,forms_data,invoice_data").eq("user_id", uid);
  if (error) throw error;
  return (data ?? []).filter((s: any) => !s.address_data || !s.buyer_data || !s.packages_data).length;
}
