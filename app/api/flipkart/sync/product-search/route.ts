import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type ProductSearchItem = {
  listingId?: string;
  sellerId?: string;
  productId?: string;
  sku?: string;
  status?: string;
  product_name?: string;
  product_image_url?: string;
  product_url?: string;
  vertical?: string;
  product_description?: {
    ssp?: number;
    esp?: number | null;
    mrp?: number;
    dimensions?: { breadth?: number; length?: number; height?: number; weight?: number };
  };
  [key: string]: unknown;
};

type ProductSearchResponse = {
  totalListingsCount?: number;
  listingData?: ProductSearchItem[];
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

async function upsertProduct(userId: string, item: ProductSearchItem) {
  if (!item.productId && !item.sku) return;

  const description = item.product_description ?? {};
  const existing = item.productId
    ? await supabaseAdmin.from("products").select("id").eq("user_id", userId).eq("flipkart_product_id", item.productId).maybeSingle()
    : await supabaseAdmin.from("products").select("id").eq("user_id", userId).eq("fsn", item.sku ?? "").maybeSingle();

  if (existing.error) throw existing.error;

  const values = {
    user_id: userId,
    flipkart_product_id: item.productId ?? null,
    fsn: item.sku ?? null,
    title: item.product_name ?? null,
    attributes: item,
    product_url: item.product_url ?? null,
    image_url: item.product_image_url ?? null,
    vertical: item.vertical ?? null,
    raw: item,
  };

  const saved = existing.data
    ? await supabaseAdmin.from("products").update(values).eq("id", existing.data.id).eq("user_id", userId).select("id").single()
    : await supabaseAdmin.from("products").insert(values).select("id").single();

  if (saved.error) throw saved.error;

  if (item.sku) {
    await supabaseAdmin.from("listings").update({
      product_id: saved.data.id,
      flipkart_product_id: item.productId ?? null,
      product_url: item.product_url ?? null,
      image_url: item.product_image_url ?? null,
      vertical: item.vertical ?? null,
      effective_selling_price: description.esp ?? description.ssp ?? null,
    }).eq("user_id", userId).eq("sku", item.sku);
  }

  return saved.data.id;
}

export async function POST(request: Request) {
  let runId: string | null = null;
  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");
    const body = await request.json().catch(() => ({}));

    const states = ["ACTIVE", "INACTIVE", "READY_FOR_ACTIVATION", "ARCHIVED", "INACTIVATED_BY_FLIPKART"] as const;
    const internalState = states.includes(body?.internalState) ? body.internalState : "ACTIVE";
    const batchNo = Number.isInteger(body?.batchNo) && body.batchNo >= 0 ? body.batchNo : 0;

    if (typeof body?.syncRunId === "string") {
      runId = body.syncRunId;
      const { data: existing, error } = await supabaseAdmin.from("sync_runs").select("id,status,records_seen,records_written")
        .eq("id", runId).eq("user_id", userId).eq("sync_type", "product_search").maybeSingle();
      if (error) throw error;
      if (!existing) throw new Error("Product search sync run was not found.");
      if (existing.status === "failed") throw new Error("Product search sync run has already failed.");
    } else {
      const { data: run, error } = await supabaseAdmin.from("sync_runs").insert({
        user_id: userId,
        sync_type: "product_search",
        status: "running",
        metadata: { internalState, batchNo },
      }).select("id").single();
      if (error) throw error;
      runId = run.id;
    }

    const { data: state } = await supabaseAdmin.from("sync_runs").select("records_seen,records_written").eq("id", runId).single();
    const seen = (state?.records_seen ?? 0);
    let written = (state?.records_written ?? 0);

    const result = await requestWithRetry<ProductSearchResponse>("/sellers/listings/v3/product/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchNo, internalState, searchText: body?.searchText ?? "" }),
    });

    const items = result.data.listingData ?? [];
    for (const item of items) {
      await upsertProduct(userId, item);
      written++;
    }

    const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").upsert(
      {
        user_id: userId,
        sync_run_id: runId,
        source_type: "product_search",
        external_id: `${internalState}:${batchNo}`,
        payload: result.data,
      },
      { onConflict: "user_id,source_type,external_id,payload_hash" },
    );
    if (rawError) throw rawError;

    const total = result.data.totalListingsCount ?? 0;
    const hasMore = (batchNo + 1) * 20 < total && items.length > 0;

    const { error: progressError } = await supabaseAdmin.from("sync_runs").update({
      status: hasMore ? "running" : "success",
      finished_at: hasMore ? null : new Date().toISOString(),
      records_seen: seen + items.length,
      records_written: written,
      error_message: null,
      metadata: { internalState, batchNo, totalListingsCount: total, hasMore },
    }).eq("id", runId);
    if (progressError) throw progressError;

    return NextResponse.json({
      ok: true,
      syncRunId: runId,
      internalState,
      batchNo,
      hasMore,
      nextBatchNo: hasMore ? batchNo + 1 : null,
      totalListingsCount: total,
      recordsSeen: seen + items.length,
      recordsWritten: written,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    const capabilityUnavailable = /^Flipkart API 404 on \/sellers\/listings\/v3\/product\/search:/.test(message);

    if (runId) {
      await supabaseAdmin.from("sync_runs").update({
        status: capabilityUnavailable ? "skipped" : "failed",
        finished_at: new Date().toISOString(),
        error_message: capabilityUnavailable
          ? "Flipkart product-search is not available for this seller/app. Listings, inventory and pricing sync can continue without product enrichment."
          : message,
      }).eq("id", runId);
    }

    return NextResponse.json(
      {
        ok: false,
        capabilityUnavailable,
        error: capabilityUnavailable
          ? "Flipkart product-search is not available for this seller/app."
          : message,
      },
      {
        status: message === "Unauthorized sync request." ? 401 : capabilityUnavailable ? 424 : 500,
      },
    );
  }
}
