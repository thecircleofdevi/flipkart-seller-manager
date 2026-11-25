import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SyncAlreadyRunningError, claimSyncRun } from "@/lib/sync-lock";

export const runtime = "nodejs";
export const maxDuration = 300;

type PriceComponents = {
  sellingPrice?: number;
  totalPrice?: number;
  shippingCharge?: number;
  customerPrice?: number;
};

type OrderItemDetail = {
  id?: string;
  orderItemId?: string;
  orderId?: string;
  cancellationGroupId?: string;
  orderDate?: string;
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
  isReplacement?: boolean;
  [key: string]: unknown;
};

type ShipmentDetail = {
  shipmentId?: string;
  orderId?: string;
  orderDate?: string;
  status?: string;
  deliveryAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  sellerAddress?: Record<string, unknown>;
  buyerDetails?: Record<string, unknown>;
  forms?: unknown[];
  orderItems?: OrderItemDetail[];
  subShipments?: Array<{
    subShipmentId?: string;
    packages?: unknown[];
    courierDetails?: {
      pickupDetails?: { vendorName?: string; trackingId?: string };
      deliveryDetails?: { vendorName?: string; trackingId?: string };
    };
  }>;
};

type ShipmentDetailResponse =
  | ShipmentDetail
  | ShipmentDetail[]
  | { shipments?: ShipmentDetail[]; shipmentDetails?: ShipmentDetail[]; data?: ShipmentDetail[] };

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function assertAuthorized(request: Request) {
  if (request.headers.get("x-flipkart-sync-secret") !== requiredEnv("FLIPKART_SYNC_SECRET")) {
    throw new Error("Unauthorized sync request.");
  }
}

async function requestWithRetry<T>(path: string, attempts = 4) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await flipkartRequest<T>(path, { method: "GET" });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Flipkart API (500|502|503|504)/.test(message) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

function asArray(payload: ShipmentDetailResponse): ShipmentDetail[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if ("shipmentId" in payload && typeof payload.shipmentId === "string") return [payload];
  if ("shipments" in payload && Array.isArray(payload.shipments)) return payload.shipments;
  if ("shipmentDetails" in payload && Array.isArray(payload.shipmentDetails)) return payload.shipmentDetails;
  if ("data" in payload && Array.isArray(payload.data)) return payload.data;
  return [];
}

function firstTrackingId(shipment: ShipmentDetail) {
  for (const sub of shipment.subShipments ?? []) {
    const delivery = sub.courierDetails?.deliveryDetails?.trackingId;
    const pickup = sub.courierDetails?.pickupDetails?.trackingId;
    if (delivery) return delivery;
    if (pickup) return pickup;
  }
  return null;
}

function firstCourierName(shipment: ShipmentDetail) {
  for (const sub of shipment.subShipments ?? []) {
    const delivery = sub.courierDetails?.deliveryDetails?.vendorName;
    const pickup = sub.courierDetails?.pickupDetails?.vendorName;
    if (delivery) return delivery;
    if (pickup) return pickup;
  }
  return null;
}

async function persistOrderDetails(userId: string, shipment: ShipmentDetail) {
  let ordersTouched = 0;
  let orderItemsWritten = 0;
  const orderDbIds = new Map<string, string>();

  for (const item of shipment.orderItems ?? []) {
    const orderId = item.orderId ?? shipment.orderId;
    const orderItemId = item.orderItemId ?? item.id;
    if (!orderId || !orderItemId) continue;

    let listingDbId: string | null = null;
    if (item.sku) {
      const { data: listing, error } = await supabaseAdmin
        .from("listings")
        .select("id")
        .eq("user_id", userId)
        .eq("sku", item.sku)
        .maybeSingle();
      if (error) throw error;
      listingDbId = listing?.id ?? null;
    }

    let orderDbId = orderDbIds.get(orderId);
    if (!orderDbId) {
      const { data: order, error } = await supabaseAdmin
        .from("orders")
        .upsert({
          user_id: userId,
          flipkart_order_id: orderId,
          order_date: item.orderDate ?? shipment.orderDate ?? null,
          status: item.status ?? shipment.status ?? null,
          raw: { source: "shipment_details", shipmentId: shipment.shipmentId ?? null, orderId, orderItems: shipment.orderItems ?? [] },
        }, { onConflict: "user_id,flipkart_order_id" })
        .select("id")
        .single();
      if (error) throw error;
      orderDbId = order.id;
      orderDbIds.set(orderId, order.id);
      ordersTouched++;
    }

    const price = item.priceComponents ?? {};
    const { error: orderItemError } = await supabaseAdmin
      .from("order_items")
      .upsert({
        user_id: userId,
        order_id: orderDbId,
        flipkart_order_item_id: orderItemId,
        sku: item.sku ?? null,
        fsn: item.fsn ?? null,
        listing_id: listingDbId,
        quantity: item.quantity ?? null,
        cancellation_group_id: item.cancellationGroupId ?? null,
        is_replacement: item.isReplacement ?? false,
        selling_price: price.sellingPrice ?? null,
        total_price: price.totalPrice ?? null,
        shipping_charge: price.shippingCharge ?? null,
        customer_price: price.customerPrice ?? null,
        status: item.status ?? null,
        raw: item,
      }, { onConflict: "user_id,flipkart_order_item_id" });
    if (orderItemError) throw orderItemError;
    orderItemsWritten++;
  }

  return {
    orderDbId: shipment.orderId ? orderDbIds.get(shipment.orderId) ?? null : null,
    ordersTouched,
    orderItemsWritten,
  };
}

export async function POST(request: Request) {
  let runId: string | null = null;
  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");
    runId = await claimSyncRun(userId, "shipment_details", "shipment_details");

    const { data: rows, error: shipmentError } = await supabaseAdmin
      .from("shipments")
      .select("id,flipkart_shipment_id")
      .eq("user_id", userId)
      .not("flipkart_shipment_id", "is", null);
    if (shipmentError) throw shipmentError;

    const shipments = rows ?? [];
    let updated = 0;
    let ordersTouched = 0;
    let orderItemsWritten = 0;

    for (let i = 0; i < shipments.length; i += 100) {
      const batch = shipments.slice(i, i + 100);
      const ids = batch.map((row) => row.flipkart_shipment_id).join(",");
      const result = await requestWithRetry<ShipmentDetailResponse>(`/sellers/v3/shipments/${encodeURIComponent(ids)}`);
      const details = asArray(result.data);

      if (!details.length && batch.length) {
        throw new Error(`Flipkart shipment detail response contained no shipment records for a batch of ${batch.length}.`);
      }

      for (const detail of details) {
        if (!detail.shipmentId) continue;
        const local = batch.find((row) => row.flipkart_shipment_id === detail.shipmentId);
        if (!local) continue;

        const orderResult = await persistOrderDetails(userId, detail);
        ordersTouched += orderResult.ordersTouched;
        orderItemsWritten += orderResult.orderItemsWritten;

        const trackingId = firstTrackingId(detail);
        const courierName = firstCourierName(detail);
        const { data: orderRow } = detail.orderId
          ? await supabaseAdmin.from("orders").select("id").eq("user_id", userId).eq("flipkart_order_id", detail.orderId).maybeSingle()
          : { data: null };

        const { error } = await supabaseAdmin
          .from("shipments")
          .update({
            order_id: orderRow?.id ?? null,
            tracking_id: trackingId,
            courier_name: courierName,
            address_data: {
              deliveryAddress: detail.deliveryAddress ?? null,
              billingAddress: detail.billingAddress ?? null,
              sellerAddress: detail.sellerAddress ?? null,
            },
            buyer_data: detail.buyerDetails ?? {},
            forms_data: detail.forms ?? [],
            packages_data: (detail.subShipments ?? []).flatMap((sub) => sub.packages ?? []),
            raw: detail,
          })
          .eq("id", local.id)
          .eq("user_id", userId);
        if (error) throw error;

        const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").upsert({
          user_id: userId,
          sync_run_id: runId,
          source_type: "shipment_details",
          external_id: detail.shipmentId,
          payload: detail,
        }, { onConflict: "user_id,source_type,external_id,payload_hash" });
        if (rawError) throw rawError;

        updated++;
      }
    }

    if (shipments.length > 0 && updated === 0) {
      throw new Error("Shipment detail sync completed without updating any shipment records.");
    }

    const { error: finishError } = await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        records_seen: shipments.length,
        records_written: updated + orderItemsWritten,
        metadata: { shipmentsSeen: shipments.length, shipmentsUpdated: updated, ordersTouched, orderItemsWritten, includesOrderDetails: true },
      })
      .eq("id", runId);
    if (finishError) throw finishError;

    return NextResponse.json({
      ok: true,
      shipmentsSeen: shipments.length,
      shipmentsUpdated: updated,
      ordersTouched,
      orderItemsWritten,
      includesOrderDetails: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, error: message, syncRunId: error.syncRunId }, { status: 409 });
    }
    if (runId) {
      await supabaseAdmin.from("sync_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message }).eq("id", runId);
    }
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized sync request." ? 401 : 500 });
  }
}
