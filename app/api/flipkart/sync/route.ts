import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

type PriceComponents = {
  sellingPrice?: number;
  totalPrice?: number;
  shippingCharge?: number;
  customerPrice?: number;
  flipkartDiscount?: number;
};

type OrderItemPayload = {
  orderItemId: string;
  orderId: string;
  cancellationGroupId?: string;
  orderDate?: string;
  paymentType?: string;
  status?: string;
  quantity?: number;
  fsn?: string;
  sku?: string;
  listingId?: string;
  hsn?: string;
  title?: string;
  packageIds?: string[];
  priceComponents?: PriceComponents;
  serviceProfile?: string;
  is_replacement?: boolean;
};

type ShipmentPayload = {
  shipmentId: string;
  dispatchByDate?: string;
  dispatchAfterDate?: string;
  updatedAt?: string;
  locationId?: string;
  hold?: boolean;
  mps?: boolean;
  packagingPolicy?: string;
  subShipments?: Array<{
    subShipmentId?: string;
    packages?: Array<{
      packageId?: string;
      packageSku?: string;
      dimensions?: { length?: number; breadth?: number; height?: number; weight?: number };
    }>;
  }>;
  orderItems?: OrderItemPayload[];
  forms?: unknown[];
  shipmentType?: string;
  logistics_partner?: string;
  order_type?: string;
};

type ShipmentFilterResponse = {
  shipments?: ShipmentPayload[];
  hasMore?: boolean;
  nextPageUrl?: string;
};

const states = {
  preDispatch: ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "FORM_FAILED", "READY_TO_DISPATCH"],
  postDispatch: ["SHIPPED", "DELIVERED", "PICKUP_COMPLETE"],
  cancelled: ["CANCELLED"],
} as const;

function ownerId() {
  const id = process.env.FLIPKART_OWNER_USER_ID;
  if (!id) throw new Error("Missing FLIPKART_OWNER_USER_ID.");
  return id;
}

async function upsertShipmentGraph(userId: string, shipment: ShipmentPayload) {
  const firstItem = shipment.orderItems?.[0];

  let locationDbId: string | null = null;
  if (shipment.locationId) {
    const { data, error } = await supabaseAdmin.from("locations").upsert(
      {
        user_id: userId,
        flipkart_location_id: shipment.locationId,
        status: "active",
        raw: { locationId: shipment.locationId },
      },
      { onConflict: "user_id,flipkart_location_id" },
    ).select("id").single();
    if (error) throw error;
    locationDbId = data.id;
  }

  for (const item of shipment.orderItems ?? []) {
    if (item.fsn) {
      const { error } = await supabaseAdmin.from("products").upsert(
        {
          user_id: userId,
          fsn: item.fsn,
          title: item.title ?? null,
          raw: item,
        },
        { onConflict: "user_id,fsn" },
      );
      if (error) throw error;
    }

    let listingDbId: string | null = null;
    if (item.sku) {
      const { data, error } = await supabaseAdmin
        .from("listings")
        .upsert(
          {
            user_id: userId,
            flipkart_listing_id: item.listingId ?? null,
            sku: item.sku,
            fsn: item.fsn ?? null,
            status: item.status ?? null,
            fulfillment_profile: item.serviceProfile ?? null,
            hsn: item.hsn ?? null,
            listing_data: item,
            raw: item,
          },
          { onConflict: "user_id,sku" },
        )
        .select("id")
        .single();
      if (error) throw error;
      listingDbId = data.id;
    }

    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .upsert(
        {
          user_id: userId,
          flipkart_order_id: item.orderId,
          order_date: item.orderDate ?? null,
          status: item.status ?? null,
          raw: item,
        },
        { onConflict: "user_id,flipkart_order_id" },
      )
      .select("id")
      .single();
    if (orderError) throw orderError;

    const price = item.priceComponents ?? {};
    const { data: orderItem, error: itemError } = await supabaseAdmin
      .from("order_items")
      .upsert(
        {
          user_id: userId,
          order_id: order.id,
          flipkart_order_item_id: item.orderItemId,
          sku: item.sku ?? null,
          fsn: item.fsn ?? null,
          listing_id: listingDbId,
          quantity: item.quantity ?? null,
          cancellation_group_id: item.cancellationGroupId ?? null,
          is_replacement: item.is_replacement ?? false,
          selling_price: price.sellingPrice ?? null,
          total_price: price.totalPrice ?? null,
          shipping_charge: price.shippingCharge ?? null,
          customer_price: price.customerPrice ?? null,
          status: item.status ?? null,
          raw: item,
        },
        { onConflict: "user_id,flipkart_order_item_id" },
      )
      .select("id")
      .single();
    if (itemError) throw itemError;

    for (const packageId of item.packageIds ?? []) {
      void packageId;
    }

    if (shipment.shipmentId) {
      const { data: shipmentRow, error: shipmentError } = await supabaseAdmin
        .from("shipments")
        .upsert(
          {
            user_id: userId,
            flipkart_shipment_id: shipment.shipmentId,
            order_id: order.id,
            location_id: locationDbId,
            state: item.status ?? null,
            shipment_type: shipment.shipmentType ?? null,
            service_profile: item.serviceProfile ?? null,
            hold: shipment.hold ?? false,
            mps: shipment.mps ?? false,
            dispatch_after: shipment.dispatchAfterDate ?? null,
            dispatch_by: shipment.dispatchByDate ?? null,
            invoice_data: {},
            address_data: {},
            raw: shipment,
          },
          { onConflict: "user_id,flipkart_shipment_id" },
        )
        .select("id")
        .single();
      if (shipmentError) throw shipmentError;

      const { error: shipmentItemError } = await supabaseAdmin
        .from("shipment_items")
        .upsert(
          {
            user_id: userId,
            shipment_id: shipmentRow.id,
            order_item_id: orderItem.id,
            quantity: item.quantity ?? 1,
            raw: item,
          },
          { onConflict: "shipment_id,order_item_id" },
        );
      if (shipmentItemError) throw shipmentItemError;

      const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").insert({
        user_id: userId,
        source_type: "shipment_filter",
        external_id: shipment.shipmentId,
        payload: shipment,
      });
      if (rawError) throw rawError;
    }
  }

  if (!firstItem) {
    const { error } = await supabaseAdmin.from("shipments").upsert(
      {
        user_id: userId,
        flipkart_shipment_id: shipment.shipmentId,
        location_id: locationDbId,
        state: null,
        shipment_type: shipment.shipmentType ?? null,
        hold: shipment.hold ?? false,
        mps: shipment.mps ?? false,
        dispatch_after: shipment.dispatchAfterDate ?? null,
        dispatch_by: shipment.dispatchByDate ?? null,
        invoice_data: {},
        address_data: {},
        raw: shipment,
      },
      { onConflict: "user_id,flipkart_shipment_id" },
    );
    if (error) throw error;
  }
}

export async function POST() {
  const startedAt = new Date().toISOString();

  try {
    const userId = ownerId();

    const { data: run, error: runError } = await supabaseAdmin
      .from("sync_runs")
      .insert({
        user_id: userId,
        sync_type: "shipments",
        status: "running",
        started_at: startedAt,
      })
      .select("id")
      .single();
    if (runError) throw runError;

    let totalSeen = 0;
    let totalWritten = 0;

    for (const [type, typeStates] of Object.entries(states)) {
      let nextPath = "/sellers/v3/shipments/filter/";
      let page = 0;

      while (nextPath) {
        const body = {
          filter: { type, states: typeStates },
          pagination: { pageSize: 20 },
          sort: { field: "orderDate", order: "desc" },
        };

        const requestStarted = Date.now();
        const result = await flipkartRequest<ShipmentFilterResponse>(nextPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const shipments = result.data.shipments ?? [];
        totalSeen += shipments.length;

        await supabaseAdmin.from("api_requests").insert({
          user_id: userId,
          method: "POST",
          endpoint: nextPath,
          status_code: result.status,
          started_at: new Date(requestStarted).toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - requestStarted,
          request_meta: { filterType: type, page },
          response_meta: { shipmentCount: shipments.length, hasMore: result.data.hasMore ?? false },
        });

        for (const shipment of shipments) {
          await upsertShipmentGraph(userId, shipment);
          totalWritten++;
        }

        nextPath = result.data.hasMore && result.data.nextPageUrl
          ? new URL(result.data.nextPageUrl).pathname + new URL(result.data.nextPageUrl).search
          : "";
        page++;
        if (page > 250) throw new Error("Shipment pagination safety limit reached.");
      }
    }

    await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        records_seen: totalSeen,
        records_written: totalWritten,
      })
      .eq("id", run.id);

    return NextResponse.json({ ok: true, recordsSeen: totalSeen, recordsWritten: totalWritten });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}


export async function GET() {
  return POST();
}
