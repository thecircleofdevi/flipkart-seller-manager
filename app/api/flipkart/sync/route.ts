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
type ShipmentType = "NORMAL" | "SELF";

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
    const { data: existingShipment } = await supabaseAdmin
      .from("shipments")
      .select("id,state")
      .eq("user_id", userId)
      .eq("flipkart_shipment_id", shipment.shipmentId)
      .maybeSingle();

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

    const nextState = firstItem.status ?? null;
    if (existingShipment?.id && nextState && existingShipment.state !== nextState) {
      const { error: eventError } = await supabaseAdmin.from("shipment_events").insert({
        user_id: userId,
        shipment_id: shipmentRow.id,
        event_type: nextState,
        event_timestamp: shipment.updatedAt ?? new Date().toISOString(),
        source: "shipment_filter",
        payload: shipment,
      });
      if (eventError) throw eventError;
    }

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
      .upsert(
        {
          user_id: userId,
          sync_run_id: syncRunId,
          source_type: "shipment_filter",
          external_id: shipment.shipmentId,
          payload: shipment,
        },
        { onConflict: "user_id,source_type,external_id,payload_hash" },
      );

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
    const body = await request.json().catch(() => ({}));

    const filterType = body?.filterType as FilterType | undefined;
    const shipmentType = body?.shipmentType as ShipmentType | undefined;
    const mode = body?.mode === "full" ? "full" : "incremental";
    if (!filterType || !states[filterType]) {
      throw new Error("A valid shipment filterType is required.");
    }

    const now = new Date();
    let modifiedFrom: Date;
    let modifiedTo: Date;

    if (mode === "full") {
      if (!body?.modifiedFrom || !body?.modifiedTo) {
        throw new Error("Full shipment sync requires modifiedFrom and modifiedTo.");
      }
      modifiedFrom = new Date(body.modifiedFrom);
      modifiedTo = new Date(body.modifiedTo);
    } else if (body?.modifiedFrom && body?.modifiedTo) {
      modifiedFrom = new Date(body.modifiedFrom);
      modifiedTo = new Date(body.modifiedTo);
    } else {
      const { data: latestSuccess } = await supabaseAdmin
        .from("sync_runs")
        .select("finished_at")
        .eq("user_id", userId)
        .eq("sync_type", "shipments")
        .eq("status", "success")
        .not("finished_at", "is", null)
        .order("finished_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lookbackStart = latestSuccess?.finished_at
        ? new Date(new Date(latestSuccess.finished_at).getTime() - 2 * 60 * 60 * 1000)
        : new Date(now.getTime() - 24 * 60 * 60 * 1000);

      modifiedFrom = new Date(
        Math.max(
          lookbackStart.getTime(),
          now.getTime() - 7 * 24 * 60 * 60 * 1000,
        ),
      );
      modifiedTo = now;
    }

    if (
      !Number.isFinite(modifiedFrom.getTime()) ||
      !Number.isFinite(modifiedTo.getTime()) ||
      modifiedTo <= modifiedFrom
    ) {
      throw new Error("Invalid shipment sync date window.");
    }

    if (modifiedTo.getTime() - modifiedFrom.getTime() > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("Shipment sync window cannot exceed 7 days.");
    }

    const checkpointDomain = mode === "full"
      ? `shipments:full:${filterType}:${shipmentType ?? "ALL"}:${modifiedFrom.toISOString()}`
      : `shipments:incremental:${filterType}:${shipmentType ?? "ALL"}`;
    let checkpoint: { id: string; cursor: Record<string, unknown> } | null = null;

    const { data: checkpointRow, error: checkpointError } = await supabaseAdmin
      .from("sync_checkpoints")
      .select("id,cursor")
      .eq("user_id", userId)
      .eq("domain", checkpointDomain)
      .maybeSingle();

    if (checkpointError) throw checkpointError;
    if (checkpointRow) {
      checkpoint = {
        id: checkpointRow.id,
        cursor: (checkpointRow.cursor ?? {}) as Record<string, unknown>,
      };
    }

    runId = typeof body?.syncRunId === "string" ? body.syncRunId : null;

    const checkpointNextPageUrl =
      typeof checkpoint?.cursor?.nextPageUrl === "string" && checkpoint.cursor.nextPageUrl
        ? normalizeFlipkartPath(checkpoint.cursor.nextPageUrl)
        : null;

    if (!runId && checkpointNextPageUrl && checkpoint?.cursor?.syncRunId) {
      const checkpointRunId = String(checkpoint.cursor.syncRunId);
      const { data: checkpointRun } = await supabaseAdmin
        .from("sync_runs")
        .select("id,status,records_seen,records_written")
        .eq("id", checkpointRunId)
        .eq("user_id", userId)
        .eq("sync_type", "shipments")
        .maybeSingle();

      if (checkpointRun && checkpointRun.status === "running") {
        runId = checkpointRun.id;
        totalSeen = checkpointRun.records_seen ?? 0;
        totalWritten = checkpointRun.records_written ?? 0;
      }
    }

    if (runId) {
      const { data: existingRun, error: existingRunError } = await supabaseAdmin
        .from("sync_runs")
        .select("id,status,records_seen,records_written")
        .eq("id", runId)
        .eq("user_id", userId)
        .eq("sync_type", "shipments")
        .maybeSingle();

      if (existingRunError) throw existingRunError;
      if (!existingRun) throw new Error("Shipment sync run was not found.");
      if (existingRun.status === "failed") {
        throw new Error("Shipment sync run has already failed.");
      }
      totalSeen = existingRun.records_seen ?? totalSeen;
      totalWritten = existingRun.records_written ?? totalWritten;
    } else {
      runId = await claimSyncRun(userId, "shipments", checkpointDomain, {
        mode,
        filterType,
        shipmentType: shipmentType ?? null,
        modifiedFrom: modifiedFrom.toISOString(),
        modifiedTo: modifiedTo.toISOString(),
      });
    }

    if (!runId) throw new Error("Shipment sync run could not be initialized.");
    const shipmentRunId = runId;

    const bodyNextPageUrl =
      typeof body?.nextPageUrl === "string" && body.nextPageUrl
        ? normalizeFlipkartPath(body.nextPageUrl)
        : null;
    const nextPageUrl = bodyNextPageUrl ?? checkpointNextPageUrl;

    const pageSize = 20;
    const filterBody = {
      filter: {
        type: filterType,
        states: states[filterType],
        modifiedDate: {
          from: modifiedFrom.toISOString(),
          to: modifiedTo.toISOString(),
        },
        ...(shipmentType ? { shipmentTypes: [shipmentType] } : {}),
      },
      pagination: { pageSize },
      sort: { field: "orderDate", order: "desc" },
    };

    const isFirstPage = !nextPageUrl;
    const requestPath = nextPageUrl ?? "/sellers/v3/shipments/filter";
    const requestStarted = Date.now();

    let result;
    try {
      result = await flipkartRequestWithRetry<ShipmentFilterResponse>(
        requestPath,
        isFirstPage
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(filterBody),
            }
          : {
              method: "GET",
              headers: { "Content-Type": "application/json" },
            },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabaseAdmin.from("api_requests").insert({
        user_id: userId,
        integration_id: null,
        method: isFirstPage ? "POST" : "GET",
        endpoint: requestPath,
        status_code: null,
        started_at: new Date(requestStarted).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - requestStarted,
        request_meta: {
          filterType,
          shipmentType: shipmentType ?? null,
          modifiedFrom: modifiedFrom.toISOString(),
          modifiedTo: modifiedTo.toISOString(),
          pageSize,
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
        endpoint: requestPath,
        status_code: result.status,
        started_at: new Date(requestStarted).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - requestStarted,
        request_meta: {
          filterType,
          shipmentType: shipmentType ?? null,
          modifiedFrom: modifiedFrom.toISOString(),
          modifiedTo: modifiedTo.toISOString(),
          pageSize,
        },
        response_meta: {
          shipmentCount: shipments.length,
          hasMore: result.data.hasMore ?? false,
          hasNextPageUrl: Boolean(result.data.nextPageUrl),
          pageMethod: isFirstPage ? "POST" : "GET",
          pagePath: requestPath,
        },
      });

    if (apiLogError) throw apiLogError;

    // The Flipkart API caps each page at 20 records. Persist the page in
    // bounded parallel batches instead of serially processing every shipment.
    // The graph upsert still preserves its dependency order within a shipment.
    const writeConcurrency = 4;
    for (let offset = 0; offset < shipments.length; offset += writeConcurrency) {
      const batch = shipments.slice(offset, offset + writeConcurrency);
      const results = await Promise.all(
        batch.map((shipment) => upsertShipmentGraph(userId, shipmentRunId, shipment)),
      );
      totalWritten += results.length;
    }

    const rawNextPageUrl = result.data.nextPageUrl ?? null;
    const hasMore = Boolean(result.data.hasMore);
    const continuationUrl = hasMore
      ? normalizeFlipkartPath(rawNextPageUrl ?? (() => {
          throw new Error("Flipkart indicated more shipment pages but did not provide nextPageUrl.");
        })())
      : null;

    if (hasMore && continuationUrl === requestPath) {
      throw new Error("Flipkart returned the same nextPageUrl as the current shipment page.");
    }

    const { error: progressError } = await supabaseAdmin
      .from("sync_runs")
      .update({
        status: hasMore ? "running" : "success",
        finished_at: hasMore ? null : new Date().toISOString(),
        records_seen: totalSeen,
        records_written: totalWritten,
        error_message: null,
        metadata: {
          mode,
          filterType,
          shipmentType: shipmentType ?? null,
          modifiedFrom: modifiedFrom.toISOString(),
          modifiedTo: modifiedTo.toISOString(),
          lastPageSize: shipments.length,
          hasMore,
          pageMethod: isFirstPage ? "POST" : "GET",
          pagePath: requestPath,
          nextPageUrl: continuationUrl,
        },
      })
      .eq("id", runId)
      .eq("user_id", userId);

    if (progressError) throw progressError;

    const { error: checkpointWriteError } = await supabaseAdmin
      .from("sync_checkpoints")
      .upsert(
        {
          user_id: userId,
          domain: checkpointDomain,
          cursor: hasMore
            ? {
                syncRunId: runId,
                nextPageUrl: continuationUrl,
                modifiedFrom: modifiedFrom.toISOString(),
                modifiedTo: modifiedTo.toISOString(),
              }
            : {
                lastSuccessAt: new Date().toISOString(),
                modifiedFrom: modifiedFrom.toISOString(),
                modifiedTo: modifiedTo.toISOString(),
              },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,domain" },
      );

    if (checkpointWriteError) throw checkpointWriteError;

    return NextResponse.json({
      ok: true,
      filterType,
      shipmentType: shipmentType ?? null,
      mode,
      recordsSeen: totalSeen,
      recordsWritten: totalWritten,
      hasMore,
      nextPageUrl: continuationUrl,
      syncRunId: runId,
      shipmentIds: shipments.map((shipment) => shipment.shipmentId),
      modifiedFrom: modifiedFrom.toISOString(),
      modifiedTo: modifiedTo.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, error: message, syncRunId: error.syncRunId }, { status: 409 });
    }

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
