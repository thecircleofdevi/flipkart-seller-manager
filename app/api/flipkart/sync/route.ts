import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type PriceComponents = {
  sellingPrice?: number;
  totalPrice?: number;
  shippingCharge?: number;
  customerPrice?: number;
};

type OrderItemPayload = {
  orderItemId: string;
  orderId: string;
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
      dimensions?: {
        length?: number;
        breadth?: number;
        height?: number;
        weight?: number;
      };
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

type FilterType = "preDispatch" | "postDispatch" | "cancelled";

const states: Record<FilterType, readonly string[]> = {
  preDispatch: [
    "APPROVED",
    "PACKING_IN_PROGRESS",
    "PACKED",
    "FORM_FAILED",
    "READY_TO_DISPATCH",
  ],
  postDispatch: [
    "SHIPPED",
    "DELIVERED",
    "PICKUP_COMPLETE",
    "RETURN_REQUESTED",
    "RETURNED",
    "COMPLETED",
  ],
  cancelled: ["CANCELLED"],
};

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function assertAuthorized(request: Request) {
  const configured = getRequiredEnv("FLIPKART_SYNC_SECRET");
  const provided = request.headers.get("x-flipkart-sync-secret");
  if (!provided || provided !== configured) {
    throw new Error("Unauthorized sync request.");
  }
}

async function flipkartRequestWithRetry<T>(
  path: string,
  init: RequestInit,
  attempts = 6,
) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await flipkartRequest<T>(path, init);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message.includes("Flipkart API 500") ||
        message.includes("Flipkart API 502") ||
        message.includes("Flipkart API 503") ||
        message.includes("Flipkart API 504");

      if (!retryable || attempt === attempts - 1) throw error;

      const { invalidateFlipkartAccessToken } = await import("@/lib/flipkart/auth");
      invalidateFlipkartAccessToken();

      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * 2 ** attempt),
      );
    }
  }

  throw lastError;
}

async function upsertShipmentGraph(
  userId: string,
  syncRunId: string,
  shipment: ShipmentPayload,
) {
  let locationDbId: string | null = null;

  if (shipment.locationId) {
    const { data, error } = await supabaseAdmin
      .from("locations")
      .upsert(
        {
          user_id: userId,
          flipkart_location_id: shipment.locationId,
          status: "active",
          raw: { locationId: shipment.locationId },
        },
        { onConflict: "user_id,flipkart_location_id" },
      )
      .select("id")
      .single();

    if (error) throw error;
    locationDbId = data.id;
  }

  const items = shipment.orderItems ?? [];
  const firstItem = items[0];

  let orderDbId: string | null = null;

  for (const item of items) {
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

    if (!orderDbId) orderDbId = order.id;

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
          is_replacement: item.isReplacement ?? false,
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

  }

  if (shipment.shipmentId && firstItem) {
    const { data: shipmentRow, error: shipmentError } = await supabaseAdmin
      .from("shipments")
      .upsert(
        {
          user_id: userId,
          flipkart_shipment_id: shipment.shipmentId,
          order_id: orderDbId,
          location_id: locationDbId,
          state: firstItem.status ?? null,
          shipment_type: shipment.shipmentType ?? null,
          service_profile: firstItem.serviceProfile ?? null,
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

    for (const item of items) {
      const { data: orderItem } = await supabaseAdmin
        .from("order_items")
        .select("id,quantity,raw")
        .eq("user_id", userId)
        .eq("flipkart_order_item_id", item.orderItemId)
        .single();

      if (!orderItem) continue;

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
    }
  }

  if (!firstItem && shipment.shipmentId) {
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

  if (shipment.shipmentId) {
    const { error: rawError } = await supabaseAdmin
      .from("raw_flipkart_payloads")
      .insert({
        user_id: userId,
        sync_run_id: syncRunId,
        source_type: "shipment_filter",
        external_id: shipment.shipmentId,
        payload: shipment,
      });

    if (rawError) throw rawError;
  }
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let runId: string | null = null;

  let totalSeen = 0;
  let totalWritten = 0;

  try {
    assertAuthorized(request);

    const userId = getRequiredEnv("FLIPKART_OWNER_USER_ID");

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
    runId = run.id;

    // Flipkart's filter API is paginated and the platform can return a 500 on a
    // large result window. Use modifiedDate windows so one bad page does not
    // prevent the rest of the order history from syncing.
    const now = new Date();
    const syncStart = new Date("2020-01-01T00:00:00.000Z");
    const windowMs = 90 * 24 * 60 * 60 * 1000;

    for (const [type, typeStates] of Object.entries(states) as [
      FilterType,
      readonly string[],
    ][]) {
      let windowFrom = syncStart;

      while (windowFrom < now) {
        const windowTo = new Date(
          Math.min(windowFrom.getTime() + windowMs, now.getTime()),
        );

        const pendingWindows: Array<{
          from: Date;
          to: Date;
          depth: number;
        }> = [{ from: windowFrom, to: windowTo, depth: 0 }];

        while (pendingWindows.length) {
          const current = pendingWindows.pop()!;
          let page = 0;
          let nextPath = "/sellers/v3/shipments/filter";
          let shouldSplit = false;

          try {
            while (nextPath) {
              const isFirstPage = page === 0;
              const body = {
                filter: {
                  type,
                  states: typeStates,
                  modifiedDate: {
                    from: current.from.toISOString(),
                    to: current.to.toISOString(),
                  },
                },
                pagination: { pageSize: 20 },
                sort: { field: "modifiedDate", order: "desc" },
              };

              const requestStarted = Date.now();
              let result;

              try {
                result = await flipkartRequestWithRetry<ShipmentFilterResponse>(
                  nextPath,
                  isFirstPage
                    ? {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                      }
                    : {
                        method: "GET",
                        headers: { "Content-Type": "application/json" },
                      },
                );
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);

                await supabaseAdmin.from("api_requests").insert({
                  user_id: userId,
                  integration_id: null,
                  method: isFirstPage ? "POST" : "GET",
                  endpoint: nextPath,
                  status_code: null,
                  started_at: new Date(requestStarted).toISOString(),
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - requestStarted,
                  request_meta: {
                    filterType: type,
                    page,
                    modifiedFrom: current.from.toISOString(),
                    modifiedTo: current.to.toISOString(),
                  },
                  response_meta: {},
                  error_message: message,
                });

                throw error;
              }

              const shipments = result.data.shipments ?? [];
              totalSeen += shipments.length;

              const { error: apiLogError } = await supabaseAdmin
                .from("api_requests")
                .insert({
                  user_id: userId,
                  integration_id: null,
                  method: isFirstPage ? "POST" : "GET",
                  endpoint: nextPath,
                  status_code: result.status,
                  started_at: new Date(requestStarted).toISOString(),
                  finished_at: new Date().toISOString(),
                  duration_ms: Date.now() - requestStarted,
                  request_meta: {
                    filterType: type,
                    page,
                    modifiedFrom: current.from.toISOString(),
                    modifiedTo: current.to.toISOString(),
                  },
                  response_meta: {
                    shipmentCount: shipments.length,
                    hasMore: result.data.hasMore ?? false,
                    hasNextPageUrl: Boolean(result.data.nextPageUrl),
                  },
                });

              if (apiLogError) throw apiLogError;

              for (const shipment of shipments) {
                await upsertShipmentGraph(userId, run.id, shipment);
                totalWritten++;
              }

              if (!result.data.hasMore) {
                nextPath = "";
                break;
              }

              if (!result.data.nextPageUrl) {
                throw new Error(
                  "Flipkart returned hasMore=true without nextPageUrl.",
                );
              }

              nextPath = normalizeFlipkartPath(result.data.nextPageUrl);
              page++;

              if (page > 250) {
                throw new Error("Shipment pagination safety limit reached.");
              }
            }
          } catch (error) {
            const spanMs = current.to.getTime() - current.from.getTime();
            const minWindowMs = 60 * 60 * 1000;

            if (spanMs > minWindowMs && current.depth < 12) {
              shouldSplit = true;

              const midpoint = new Date(
                current.from.getTime() + Math.floor(spanMs / 2),
              );

              // Re-run the whole window after a pagination failure. Upserts make
              // already-written rows safe to replay, while the smaller windows
              // avoid repeatedly hitting the same failing large result set.
              pendingWindows.push(
                { from: midpoint, to: current.to, depth: current.depth + 1 },
                { from: current.from, to: midpoint, depth: current.depth + 1 },
              );
            } else {
              throw error;
            }
          }

          if (!shouldSplit) continue;
        }

        windowFrom = windowTo;
      }
    }

    const { error: finishError } = await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        records_seen: totalSeen,
        records_written: totalWritten,
      })
      .eq("id", run.id);

    if (finishError) throw finishError;

    return NextResponse.json({
      ok: true,
      recordsSeen: totalSeen,
      recordsWritten: totalWritten,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";

    if (runId) {
      await supabaseAdmin
        .from("sync_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          records_seen: totalSeen,
          records_written: totalWritten,
          error_message: message,
        })
        .eq("id", runId);
    }

    const status = message === "Unauthorized sync request." ? 401 : 500;

    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

function normalizeFlipkartPath(nextPageUrl: string) {
  const url = new URL(nextPageUrl, "https://api.flipkart.net");

  if (url.hostname !== "api.flipkart.net") {
    throw new Error("Flipkart nextPageUrl points to an unexpected host.");
  }

  const pathname = url.pathname.startsWith("/sellers/")
    ? url.pathname
    : `/sellers${url.pathname}`;

  return pathname + url.search;
}
