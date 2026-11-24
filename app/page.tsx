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

  const [metricResults, recentSyncs, openReturns, activeShipments, inventory, recentOrders, listings, failedNotifications, orderItems, shipmentRows, shipmentEvents, orderReturns, returnEvents] = await Promise.all([
    Promise.all(metricTables.map(({ table }) => countRows(supabase, table))),
    supabase.from("sync_runs").select("id,sync_type,status,started_at,finished_at,records_written,error_message").order("started_at", { ascending: false }).limit(12),
    supabase.from("returns").select("id,flipkart_return_id,status,return_reason,created_at").in("status", ["CREATED", "created", "OPEN", "open"]).order("created_at", { ascending: false }).limit(12),
    supabase.from("shipments").select("id,flipkart_shipment_id,state,dispatch_by,tracking_id,courier_name,shipment_type").in("state", ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]).order("dispatch_by", { ascending: true }).limit(12),
    supabase.from("listing_inventory").select("id,listing_id,quantity,effective_at").order("quantity", { ascending: true }).limit(50),
    supabase.from("orders").select("id,flipkart_order_id,order_date,status").order("order_date", { ascending: false }).limit(1000),
    supabase.from("listings").select("id,sku,fsn,status,procurement_type,shipping_provider,updated_at").order("updated_at", { ascending: false }).limit(1000),
    supabase.from("notifications").select("id,event_type,processing_status,processing_error,received_at").eq("processing_status", "failed").order("received_at", { ascending: false }).limit(12),
    supabase.from("order_items").select("id,order_id,flipkart_order_item_id,sku,fsn,quantity,cancellation_group_id,is_replacement,selling_price,total_price,shipping_charge,customer_price,status,updated_at").order("created_at", { ascending: false }).limit(1000),
    supabase.from("shipments").select("id,flipkart_shipment_id,order_id,state,dispatch_after,dispatch_by,tracking_id,tracking_url,courier_name,hold,shipment_type,service_profile,updated_at").order("updated_at", { ascending: false }).limit(1000),
    supabase.from("shipment_events").select("id,shipment_id,event_type,event_timestamp,source").order("event_timestamp", { ascending: false }).limit(2000),
    supabase.from("returns").select("id,flipkart_return_id,order_item_id,shipment_id,status,return_reason,source,created_at,updated_at").order("updated_at", { ascending: false }).limit(2000),
    supabase.from("return_events").select("id,return_id,event_type,event_timestamp").order("event_timestamp", { ascending: false }).limit(2000),
  ]);

  const failed = [...metricResults, { error: recentSyncs.error }, { error: openReturns.error }, { error: activeShipments.error }, { error: inventory.error }, { error: failedNotifications.error }, { error: orderReturns.error }, { error: returnEvents.error }].some((result) => result.error);
  const syncFailureCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const failedSyncs = (recentSyncs.data ?? []).filter((r) => r.status === "failed" && new Date(r.started_at).getTime() >= syncFailureCutoff);
  const overdueShipments = (activeShipments.data ?? []).filter((s) => s.dispatch_by && new Date(s.dispatch_by).getTime() < Date.now());
  const lowStock = (inventory.data ?? []).filter((row) => (row.quantity ?? 0) <= 3).length;

  return (
    <DashboardClient
      userEmail={user.email ?? "Seller account"}
      loginKey={user.last_sign_in_at ?? user.id}
      metrics={metricTables.map((m, i) => ({ label: m.label, icon: m.icon, caption: m.caption, value: metricResults[i].count }))}
      syncRows={(recentSyncs.data ?? []).map((r) => ({ id: r.id, sync_type: r.sync_type, status: r.status, started_at: r.started_at, finished_at: r.finished_at, records_written: r.records_written, error_message: r.error_message }))}
      returns={(openReturns.data ?? []).map((r) => ({ id: r.id, flipkart_return_id: r.flipkart_return_id, status: r.status, return_reason: r.return_reason, created_at: r.created_at }))}
      shipments={(activeShipments.data ?? []).map((s) => ({ id: s.id, flipkart_shipment_id: s.flipkart_shipment_id, state: s.state, dispatch_by: s.dispatch_by, tracking_id: s.tracking_id, courier_name: s.courier_name, shipment_type: s.shipment_type }))}
      lowStock={lowStock}
      systemHealthy={!failed}
      orders={(recentOrders.data ?? []).map((o) => ({ id: o.id, flipkart_order_id: o.flipkart_order_id, order_date: o.order_date, status: o.status }))}
      listings={(listings.data ?? []).map((l) => ({ id: l.id, sku: l.sku, fsn: l.fsn, status: l.status, procurement_type: l.procurement_type, shipping_provider: l.shipping_provider, updated_at: l.updated_at }))}
      attention={{ overdueShipments: overdueShipments.length, failedSyncs: failedSyncs.length, failedNotifications: failedNotifications.data?.length ?? 0 }}
      orderDetails={(recentOrders.data ?? []).map((o) => {
        const items = (orderItems.data ?? []).filter((i) => i.order_id === o.id);
        const shipments = (shipmentRows.data ?? []).filter((s) => s.order_id === o.id);
        const itemIds = new Set(items.map((i) => i.id));
        const shipmentIds = new Set(shipments.map((s) => s.id));
        const returns = (orderReturns.data ?? []).filter((r) => (r.order_item_id ? itemIds.has(r.order_item_id) : false) || (r.shipment_id ? shipmentIds.has(r.shipment_id) : false));
        const cancellations = items.filter((i) => i.status?.toLowerCase().includes("cancel"));
        const timeline = [
          ...(o.order_date ? [{ id: `order-${o.id}`, kind: "order", label: "Order created", timestamp: o.order_date, source: "orders" }] : []),
          ...cancellations.map((i) => ({ id: `cancel-${i.id}`, kind: "cancellation", label: `Cancellation: ${i.status ?? "cancelled"}`, timestamp: i.updated_at, source: "order_items" })),
          ...shipments.flatMap((s) => (shipmentEvents.data ?? []).filter((e) => e.shipment_id === s.id).map((e) => ({ id: e.id, kind: "shipment", label: e.event_type, timestamp: e.event_timestamp, source: e.source ?? "shipment_events" }))),
          ...returns.flatMap((r) => (returnEvents.data ?? []).filter((e) => e.return_id === r.id).map((e) => ({ id: e.id, kind: "return", label: e.event_type, timestamp: e.event_timestamp, source: "return_events" }))),
          ...returns.map((r) => ({ id: `return-${r.id}`, kind: "return", label: `Return ${r.status ?? "created"}`, timestamp: r.updated_at ?? r.created_at, source: r.source ?? "returns" })),
        ].filter((e) => e.timestamp).map((e) => ({ ...e, timestamp: e.timestamp! })).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 40);
        const searchText = [
          o.flipkart_order_id,
          ...items.flatMap((i) => [i.flipkart_order_item_id, i.sku, i.fsn, i.cancellation_group_id]),
          ...shipments.flatMap((s) => [s.flipkart_shipment_id, s.tracking_id, s.courier_name]),
          ...returns.map((r) => r.flipkart_return_id),
        ].filter(Boolean).join(" ").toLowerCase();
        return {
          id: o.id,
          flipkart_order_id: o.flipkart_order_id,
          order_date: o.order_date,
          status: o.status,
          searchText,
          items: items.map((i) => ({ id: i.id, flipkart_order_item_id: i.flipkart_order_item_id, sku: i.sku, fsn: i.fsn, quantity: i.quantity, cancellation_group_id: i.cancellation_group_id, is_replacement: i.is_replacement, selling_price: i.selling_price, total_price: i.total_price, shipping_charge: i.shipping_charge, customer_price: i.customer_price, status: i.status })),
          shipments: shipments.map((s) => ({ id: s.id, flipkart_shipment_id: s.flipkart_shipment_id, state: s.state, dispatch_after: s.dispatch_after, dispatch_by: s.dispatch_by, tracking_id: s.tracking_id, tracking_url: s.tracking_url, courier_name: s.courier_name, hold: s.hold, shipment_type: s.shipment_type, service_profile: s.service_profile, updated_at: s.updated_at, events: (shipmentEvents.data ?? []).filter((e) => e.shipment_id === s.id).slice(0, 12).map((e) => ({ id: e.id, event_type: e.event_type, event_timestamp: e.event_timestamp, source: e.source })) })),
          returns: returns.map((r) => ({ id: r.id, flipkart_return_id: r.flipkart_return_id, status: r.status, return_reason: r.return_reason, source: r.source, created_at: r.created_at, updated_at: r.updated_at })),
          cancellations: cancellations.map((i) => ({ id: i.id, order_item_id: i.flipkart_order_item_id, cancellation_group_id: i.cancellation_group_id, status: i.status, updated_at: i.updated_at })),
          timeline,
        };
      })}
    />
  );
}
