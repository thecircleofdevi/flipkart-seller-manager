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
  emi?: number;
  flipkartDiscount?: number;
};

type OrderItem = {
  orderItemId?: string;
  id?: string;
  orderId?: string;
  orderDate?: string;
  status?: string;
  quantity?: number;
  fsn?: string;
  sku?: string;
  listingId?: string;
  hsn?: string;
  title?: string;
  cancellationGroupId?: string;
  cancellationDate?: string;
  cancellationReason?: string;
  cancellationSubReason?: string;
  courierReturn?: boolean;
  packageIds?: string[];
  priceComponents?: PriceComponents;
  serviceProfile?: string;
  isReplacement?: boolean;
  [key: string]: unknown;
};

type SearchResponse = {
  orderItems?: OrderItem[];
  orders?: OrderItem[];
  nextPageURL?: string | null;
  nextPageUrl?: string | null;
  hasMore?: boolean;
  [key: string]: unknown;
};

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

function normalizePaginationUrl(value: string) {
  const url = new URL(value, "https://api.flipkart.net");
  if (url.hostname !== "api.flipkart.net") throw new Error("Flipkart nextPageURL points to an unexpected host.");
  const pathname = url.pathname.startsWith("/sellers/") ? url.pathname : `/sellers${url.pathname}`;
  return pathname + url.search;
}

async function requestWithRetry<T>(path: string, init: RequestInit, attempts = 5) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await flipkartRequest<T>(path, init);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Flipkart API (429|500|502|503|504)/.test(message) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)));
    }
  }
  throw lastError;
}

async function upsertOrderItem(userId: string, runId: string, item: OrderItem) {
  const orderId = item.orderId;
  const orderItemId = item.orderItemId ?? item.id;
  if (!orderId || !orderItemId) return false;

  let listingDbId: string | null = null;
  if (item.sku) {
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select("id")
      .eq("user_id", userId)
      .eq("sku", item.sku)
      .maybeSingle();
    if (error) throw error;
    listingDbId = data?.id ?? null;
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .upsert({
      user_id: userId,
      flipkart_order_id: orderId,
      order_date: item.orderDate ?? null,
      status: item.status ?? null,
      raw: item,
    }, { onConflict: "user_id,flipkart_order_id" })
    .select("id")
    .single();
  if (orderError) throw orderError;

  const price = item.priceComponents ?? {};
  const { error: itemError } = await supabaseAdmin
    .from("order_items")
    .upsert({
      user_id: userId,
      order_id: order.id,
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
  if (itemError) throw itemError;

  const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").insert({
    user_id: userId,
    sync_run_id: runId,
    source_type: "order_search",
    external_id: orderItemId,
    payload: item,
  });
  if (rawError) throw rawError;

  return true;
}

export async function POST(request: Request) {
  let runId: string | null = null;
  let activeUrl: string | null = null;
  let totalSeen = 0;
  let totalWritten = 0;

  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");
    const body = await request.json().catch(() => ({}));
    const mode = body?.mode === "full" ? "full" : "incremental";

    let modifiedAfter = typeof body?.modifiedAfter === "string" ? body.modifiedAfter : null;
    let modifiedBefore = typeof body?.modifiedBefore === "string" ? body.modifiedBefore : null;

    if (!modifiedAfter || !modifiedBefore) {
      if (mode === "full" && body?.modifiedFrom && body?.modifiedTo) {
        modifiedAfter = new Date(body.modifiedFrom).toISOString();
        modifiedBefore = new Date(body.modifiedTo).toISOString();
      } else {
        const { data: latestSuccess } = await supabaseAdmin
          .from("sync_runs")
          .select("finished_at")
          .eq("user_id", userId)
          .eq("sync_type", "orders")
          .eq("status", "success")
          .not("finished_at", "is", null)
          .order("finished_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const from = latestSuccess?.finished_at
          ? new Date(new Date(latestSuccess.finished_at).getTime() - 2 * 60 * 60 * 1000)
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        modifiedAfter = from.toISOString();
        modifiedBefore = new Date().toISOString();
      }
    }

    if (!modifiedAfter || !modifiedBefore) throw new Error("Order sync date window is required.");

    const checkpointDomain = `orders:${mode}`;
    const { data: checkpoint } = await supabaseAdmin
      .from("sync_checkpoints")
      .select("id,cursor")
      .eq("user_id", userId)
      .eq("domain", checkpointDomain)
      .maybeSingle();

    runId = typeof body?.syncRunId === "string" ? body.syncRunId : null;
    if (!runId && checkpoint?.cursor && typeof checkpoint.cursor === "object") {
      const cursor = checkpoint.cursor as Record<string, unknown>;
      if (cursor.syncRunId && cursor.nextPageURL) {
        const { data: checkpointRun } = await supabaseAdmin
          .from("sync_runs")
          .select("id,status,records_seen,records_written")
          .eq("id", String(cursor.syncRunId))
          .eq("user_id", userId)
          .eq("sync_type", "orders")
          .maybeSingle();
        if (checkpointRun?.status === "running") {
          runId = checkpointRun.id;
          totalSeen = checkpointRun.records_seen ?? 0;
          totalWritten = checkpointRun.records_written ?? 0;
        }
      }
    }

    if (runId) {
      const { data: existingRun, error } = await supabaseAdmin.from("sync_runs")
        .select("id,status,records_seen,records_written")
        .eq("id", runId).eq("user_id", userId).eq("sync_type", "orders").maybeSingle();
      if (error) throw error;
      if (!existingRun) throw new Error("Order sync run was not found.");
      if (existingRun.status === "failed") throw new Error("Order sync run has already failed.");
      totalSeen = existingRun.records_seen ?? totalSeen;
      totalWritten = existingRun.records_written ?? totalWritten;
    } else {
      runId = await claimSyncRun(userId, "orders", checkpointDomain, {
        mode, modifiedAfter, modifiedBefore,
      });
    }

    if (!runId) throw new Error("Order sync run could not be initialized.");

    const checkpointNextPage =
      checkpoint?.cursor && typeof checkpoint.cursor === "object" && typeof (checkpoint.cursor as Record<string, unknown>).nextPageURL === "string"
        ? normalizePaginationUrl(String((checkpoint.cursor as Record<string, unknown>).nextPageURL))
        : null;

    const bodyNextPage = typeof body?.nextPageURL === "string" && body.nextPageURL
      ? normalizePaginationUrl(body.nextPageURL)
      : null;
    const nextPageURL = bodyNextPage ?? checkpointNextPage;

    const isFirstPage = !nextPageURL;
    const path = nextPageURL ?? "/sellers/v2/orders/search";
    activeUrl = path;

    const filter = {
      modifiedDate: { fromDate: modifiedAfter, toDate: modifiedBefore },
    };
    const payload = {
      filter,
      pagination: { pageSize: 20 },
      sort: { field: "orderDate", order: "desc" },
    };

    const result = await requestWithRetry<SearchResponse>(
      path,
      isFirstPage
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        : { method: "GET", headers: { "Content-Type": "application/json" } },
    );

    const items = result.data.orderItems ?? result.data.orders ?? [];
    totalSeen += items.length;

    for (const item of items) {
      if (await upsertOrderItem(userId, runId, item)) totalWritten++;
    }

    const returnedNext = result.data.nextPageURL ?? result.data.nextPageUrl ?? null;
    const hasMore = Boolean(returnedNext);
    const continuation = hasMore ? normalizePaginationUrl(returnedNext!) : null;
    if (hasMore && continuation === path) throw new Error("Flipkart returned the same nextPageURL as the current order page.");

    const finished = !hasMore;
    const { error: progressError } = await supabaseAdmin.from("sync_runs").update({
      status: finished ? "success" : "running",
      finished_at: finished ? new Date().toISOString() : null,
      records_seen: totalSeen,
      records_written: totalWritten,
      error_message: null,
      metadata: {
        mode,
        modifiedAfter,
        modifiedBefore,
        lastPageSize: items.length,
        hasMore,
        lastUrl: path,
        nextPageURL: continuation,
        note: "Flipkart order search only exposes seller-fulfilment orders and documented states APPROVED, PACKED, READY_TO_DISPATCH, CANCELLED.",
      },
    }).eq("id", runId).eq("user_id", userId);
    if (progressError) throw progressError;

    const { error: checkpointError } = await supabaseAdmin.from("sync_checkpoints").upsert({
      user_id: userId,
      domain: checkpointDomain,
      cursor: hasMore
        ? { syncRunId: runId, nextPageURL: continuation, modifiedAfter, modifiedBefore }
        : { lastSuccessAt: new Date().toISOString(), modifiedAfter, modifiedBefore },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,domain" });
    if (checkpointError) throw checkpointError;

    return NextResponse.json({
      ok: true,
      syncRunId: runId,
      mode,
      recordsSeen: totalSeen,
      recordsWritten: totalWritten,
      hasMore,
      nextPageURL: continuation,
      modifiedAfter,
      modifiedBefore,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await supabaseAdmin.from("sync_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        records_seen: totalSeen,
        records_written: totalWritten,
        error_message: activeUrl ? `${message} [url=${activeUrl}]` : message,
      }).eq("id", runId);
    }
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, error: message, syncRunId: error.syncRunId }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized sync request." ? 401 : 500 });
  }
}
