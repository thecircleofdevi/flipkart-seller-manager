import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import DashboardClient from "./dashboard-client";

const metricTables = [
  { label: "Listings", table: "listings", icon: "◈", caption: "catalogue items" },
  { label: "Orders", table: "orders", icon: "⌁", caption: "orders captured" },
  { label: "Shipments", table: "shipments", icon: "→", caption: "fulfilment records" },
  { label: "Returns", table: "returns", icon: "↺", caption: "return records" },
  { label: "Notifications", table: "notifications", icon: "•", caption: "events received" },
] as const;

type TableName = typeof metricTables[number]["table"];

async function countRows(supabase: Awaited<ReturnType<typeof createClient>>, table: TableName) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  return { count: count ?? 0, error };
}

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [metricResults, recentSyncs, openReturns, activeShipments, inventory, recentOrders, listings] = await Promise.all([
    Promise.all(metricTables.map(({ table }) => countRows(supabase, table))),
    supabase.from("sync_runs").select("id,sync_type,status,started_at,finished_at,records_written,error_message").order("started_at", { ascending: false }).limit(12),
    supabase.from("returns").select("id,status,return_reason,created_at").in("status", ["CREATED", "created", "OPEN", "open"]).order("created_at", { ascending: false }).limit(12),
    supabase.from("shipments").select("id,flipkart_shipment_id,state,dispatch_by,tracking_id,courier_name").in("state", ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]).order("dispatch_by", { ascending: true }).limit(12),
    supabase.from("listing_inventory").select("id,listing_id,quantity,effective_at").order("quantity", { ascending: true }).limit(50),
    supabase.from("orders").select("id,flipkart_order_id,order_date,status").order("order_date", { ascending: false }).limit(20),
    supabase.from("listings").select("id,sku,fsn,status,procurement_type,shipping_provider,updated_at").order("updated_at", { ascending: false }).limit(30),
  ]);

  const failed = [...metricResults, { error: recentSyncs.error }, { error: openReturns.error }, { error: activeShipments.error }, { error: inventory.error }].some((result) => result.error);
  const lowStock = (inventory.data ?? []).filter((row) => (row.quantity ?? 0) <= 3).length;

  return (
    <DashboardClient
      userEmail={user.email ?? "Seller account"}
      metrics={metricTables.map((m, i) => ({ label: m.label, icon: m.icon, caption: m.caption, value: metricResults[i].count }))}
      syncRows={(recentSyncs.data ?? []).map((r) => ({ id: r.id, sync_type: r.sync_type, status: r.status, started_at: r.started_at, finished_at: r.finished_at, records_written: r.records_written, error_message: r.error_message }))}
      returns={(openReturns.data ?? []).map((r) => ({ id: r.id, status: r.status, return_reason: r.return_reason, created_at: r.created_at }))}
      shipments={(activeShipments.data ?? []).map((s) => ({ id: s.id, flipkart_shipment_id: s.flipkart_shipment_id, state: s.state, dispatch_by: s.dispatch_by, tracking_id: s.tracking_id, courier_name: s.courier_name }))}
      lowStock={lowStock}
      systemHealthy={!failed}
      orders={(recentOrders.data ?? []).map((o) => ({ id: o.id, flipkart_order_id: o.flipkart_order_id, order_date: o.order_date, status: o.status }))}
      listings={(listings.data ?? []).map((l) => ({ id: l.id, sku: l.sku, fsn: l.fsn, status: l.status, procurement_type: l.procurement_type, shipping_provider: l.shipping_provider, updated_at: l.updated_at }))}
    />
  );
}
