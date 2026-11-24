import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const q = request.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const page = Math.max(1, Number(request.nextUrl.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get("pageSize") ?? "50") || 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (!q) {
    const { data, count, error } = await supabase
      .from("orders")
      .select("id,flipkart_order_id,order_date,status", { count: "exact" })
      .order("order_date", { ascending: false })
      .range(from, to);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ orders: data ?? [], total: count ?? 0, page, pageSize });
  }

  const like = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const [orders, orderStatus, items, itemSku, itemFsn, itemCancel, shipments, shipmentTracking, shipmentCourier, returns] = await Promise.all([
    supabase.from("orders").select("id").ilike("flipkart_order_id", like).limit(5000),
    supabase.from("orders").select("id").ilike("status", like).limit(5000),
    supabase.from("order_items").select("order_id").ilike("flipkart_order_item_id", like).limit(5000),
    supabase.from("order_items").select("order_id").ilike("sku", like).limit(5000),
    supabase.from("order_items").select("order_id").ilike("fsn", like).limit(5000),
    supabase.from("order_items").select("order_id").ilike("cancellation_group_id", like).limit(5000),
    supabase.from("shipments").select("order_id").ilike("flipkart_shipment_id", like).limit(5000),
    supabase.from("shipments").select("order_id").ilike("tracking_id", like).limit(5000),
    supabase.from("shipments").select("order_id").ilike("courier_name", like).limit(5000),
    supabase.from("returns").select("order_item_id,shipment_id").ilike("flipkart_return_id", like).limit(5000),
  ]);

  const firstError = [orders, orderStatus, items, itemSku, itemFsn, itemCancel, shipments, shipmentTracking, shipmentCourier, returns].find((r) => r.error)?.error;
  if (firstError) return NextResponse.json({ error: firstError.message }, { status: 500 });

  const itemIds = (returns.data ?? []).map((r) => r.order_item_id).filter((id): id is string => Boolean(id));
  const shipmentIds = (returns.data ?? []).map((r) => r.shipment_id).filter((id): id is string => Boolean(id));
  let returnOrderIds: string[] = [];
  if (itemIds.length || shipmentIds.length) {
    const [returnItems, returnShipments] = await Promise.all([
      itemIds.length ? supabase.from("order_items").select("order_id").in("id", itemIds) : Promise.resolve({ data: [], error: null }),
      shipmentIds.length ? supabase.from("shipments").select("order_id").in("id", shipmentIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const returnError = returnItems.error ?? returnShipments.error;
    if (returnError) return NextResponse.json({ error: returnError.message }, { status: 500 });
    returnOrderIds = [...(returnItems.data ?? []).map((r) => r.order_id), ...(returnShipments.data ?? []).map((r) => r.order_id)];
  }

  const ids = [...new Set([
    ...(orders.data ?? []).map((r) => r.id),
    ...(orderStatus.data ?? []).map((r) => r.id),
    ...(items.data ?? []).map((r) => r.order_id),
    ...(itemSku.data ?? []).map((r) => r.order_id),
    ...(itemFsn.data ?? []).map((r) => r.order_id),
    ...(itemCancel.data ?? []).map((r) => r.order_id),
    ...(shipments.data ?? []).map((r) => r.order_id),
    ...(shipmentTracking.data ?? []).map((r) => r.order_id),
    ...(shipmentCourier.data ?? []).map((r) => r.order_id),
    ...returnOrderIds,
  ])].filter((id): id is string => Boolean(id));

  if (!ids.length) return NextResponse.json({ orders: [], total: 0, page, pageSize });

  const { data, count, error } = await supabase
    .from("orders")
    .select("id,flipkart_order_id,order_date,status", { count: "exact" })
    .in("id", ids)
    .order("order_date", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ orders: data ?? [], total: count ?? 0, page, pageSize });
}
