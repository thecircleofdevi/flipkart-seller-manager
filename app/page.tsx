import { createClient } from "@/lib/supabase/server";
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

  if (!user) {
    return <main className="auth-gate"><div className="auth-card"><div className="brand-mark">FK</div><h1>Seller Manager</h1><p>Sign in to view your Flipkart operations workspace.</p></div></main>;
  }

  const [metricResults, recentSyncs, openReturns, activeShipments, inventory] = await Promise.all([
    Promise.all(metricTables.map(({ table }) => countRows(supabase, table))),
    supabase.from("sync_runs").select("id,sync_type,status,started_at,finished_at,records_written,error_message").order("started_at", { ascending: false }).limit(12),
    supabase.from("returns").select("id,status,return_reason,created_at").in("status", ["CREATED", "created", "OPEN", "open"]).order("created_at", { ascending: false }).limit(12),
    supabase.from("shipments").select("id,flipkart_shipment_id,state,dispatch_by,tracking_id,courier_name").in("state", ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]).order("dispatch_by", { ascending: true }).limit(12),
    supabase.from("listing_inventory").select("id,quantity").order("quantity", { ascending: true }).limit(50),
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
    />
  );
}
