import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id,flipkart_order_id,order_date,status")
    .eq("id", id)
    .maybeSingle();

  if (orderError) return NextResponse.json({ error: orderError.message }, { status: 500 });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const [itemsResult, shipmentsResult] = await Promise.all([
    supabase.from("order_items").select("id,flipkart_order_item_id,sku,fsn,quantity,cancellation_group_id,is_replacement,selling_price,total_price,shipping_charge,customer_price,status,updated_at").eq("order_id", order.id).order("created_at", { ascending: true }),
    supabase.from("shipments").select("id,flipkart_shipment_id,state,dispatch_after,dispatch_by,tracking_id,tracking_url,courier_name,hold,shipment_type,service_profile,updated_at").eq("order_id", order.id).order("updated_at", { ascending: false }),
  ]);
  if (itemsResult.error) return NextResponse.json({ error: itemsResult.error.message }, { status: 500 });
  if (shipmentsResult.error) return NextResponse.json({ error: shipmentsResult.error.message }, { status: 500 });

  const items = itemsResult.data ?? [];
  const shipments = shipmentsResult.data ?? [];
  const itemIds = items.map((i) => i.id);
  const shipmentIds = shipments.map((s) => s.id);

  const [shipmentEventsResult, returnByItemsResult, returnByShipmentsResult] = await Promise.all([
    shipmentIds.length
      ? supabase.from("shipment_events").select("id,shipment_id,event_type,event_timestamp,source").in("shipment_id", shipmentIds).order("event_timestamp", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    itemIds.length
      ? supabase.from("returns").select("id,flipkart_return_id,order_item_id,shipment_id,status,return_reason,source,created_at,updated_at").in("order_item_id", itemIds).order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    shipmentIds.length
      ? supabase.from("returns").select("id,flipkart_return_id,order_item_id,shipment_id,status,return_reason,source,created_at,updated_at").in("shipment_id", shipmentIds).order("updated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const firstError = [shipmentEventsResult, returnByItemsResult, returnByShipmentsResult].find((r) => r.error)?.error;
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });

  const returns = [...new Map([
    ...(returnByItemsResult.data ?? []),
    ...(returnByShipmentsResult.data ?? []),
  ].map((r) => [r.id, r])).values()];

  const returnIds = returns.map((r) => r.id);
  const returnEventsResult = returnIds.length
    ? await supabase.from("return_events").select("id,return_id,event_type,event_timestamp").in("return_id", returnIds).order("event_timestamp", { ascending: false })
    : { data: [], error: null };
  if (returnEventsResult.error) return NextResponse.json({ error: returnEventsResult.error.message }, { status: 500 });

  const cancellations = items.filter((i) => i.status?.toLowerCase().includes("cancel"));
  const timeline = [
    ...(order.order_date ? [{ id: `order-${order.id}`, kind: "order", label: "Order created", timestamp: order.order_date, source: "orders" }] : []),
    ...cancellations.map((i) => ({ id: `cancel-${i.id}`, kind: "cancellation", label: `Cancellation: ${i.status ?? "cancelled"}`, timestamp: i.updated_at, source: "order_items" })),
    ...(shipmentEventsResult.data ?? []).map((e) => ({ id: e.id, kind: "shipment", label: e.event_type, timestamp: e.event_timestamp, source: e.source ?? "shipment_events" })),
    ...(returnEventsResult.data ?? []).map((e) => ({ id: e.id, kind: "return", label: e.event_type, timestamp: e.event_timestamp, source: "return_events" })),
    ...returns.map((r) => ({ id: `return-${r.id}`, kind: "return", label: `Return ${r.status ?? "created"}`, timestamp: r.updated_at ?? r.created_at, source: r.source ?? "returns" })),
  ].filter((e) => e.timestamp).map((e) => ({ ...e, timestamp: e.timestamp! })).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return NextResponse.json({
    id: order.id,
    flipkart_order_id: order.flipkart_order_id,
    order_date: order.order_date,
    status: order.status,
    items,
    shipments: shipments.map((s) => ({
      ...s,
      events: (shipmentEventsResult.data ?? []).filter((e) => e.shipment_id === s.id).slice(0, 50),
    })),
    returns: returns.map((r) => ({
      ...r,
      events: (returnEventsResult.data ?? []).filter((e) => e.return_id === r.id).slice(0, 50),
    })),
    cancellations: cancellations.map((i) => ({
      id: i.id,
      order_item_id: i.flipkart_order_item_id,
      cancellation_group_id: i.cancellation_group_id,
      status: i.status,
      updated_at: i.updated_at,
    })),
    timeline,
  });
}
