import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type Listing = {
  listing_id?: string;
  product_id?: string;
  product_title?: string;
  product_url?: string;
  product_image_url?: string;
  price?: { mrp?: number; selling_price?: number; flipkart_selling_price?: number; mop?: number; nlc?: number; dealer_price?: number; currency?: string };
  listing_status?: string;
  shipping_fees?: { local?: number; zonal?: number; national?: number; currency?: string };
  fulfillment_profile?: string;
  fulfillment?: { dispatch_sla?: number; shipping_provider?: string; procurement_type?: string; forbid_shipping?: string };
  tax?: { hsn?: string; tax_code?: string; is_gst_sellable?: boolean; goods_services_rate?: number; luxury_cess_percentage?: number };
  locations?: Array<{ id?: string; status?: string; inventory?: number; pending_inventory?: number }>;
  archived_status?: string;
  [key: string]: unknown;
};

type SearchResponse = {
  next_page_id?: string | null;
  has_more?: boolean;
  listings?: Array<{ listing_id: string; product_id: string; sku_id: string }>;
};

type DetailResponse = {
  available?: Record<string, Listing>;
  unavailable?: string[];
  invalid?: string[];
};

type FlipkartResponse<T> = Awaited<ReturnType<typeof flipkartRequest<T>>>;

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

async function requestWithRetry<T>(path: string, init: RequestInit, attempts = 5): Promise<FlipkartResponse<T>> {
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

async function upsertListing(userId: string, runId: string, sku: string, listing: Listing) {
  let productDbId: string | null = null;

  if (listing.product_id) {
    const { data: existingProduct, error: lookupError } = await supabaseAdmin
      .from("products")
      .select("id")
      .eq("user_id", userId)
      .eq("flipkart_product_id", listing.product_id)
      .maybeSingle();
    if (lookupError) throw lookupError;

    const productValues = {
      user_id: userId,
      flipkart_product_id: listing.product_id,
      fsn: sku,
      title: listing.product_title ?? null,
      attributes: listing,
      product_url: listing.product_url ?? null,
      image_url: listing.product_image_url ?? null,
      vertical: typeof listing.vertical === "string" ? listing.vertical : null,
      raw: listing,
    };

    const productResult = existingProduct
      ? await supabaseAdmin.from("products").update(productValues).eq("id", existingProduct.id).eq("user_id", userId).select("id").single()
      : await supabaseAdmin.from("products").insert(productValues).select("id").single();

    if (productResult.error) throw productResult.error;
    productDbId = productResult.data.id;
  }

  const sellingPrice = listing.price?.selling_price ?? listing.price?.flipkart_selling_price ?? null;
  const { data: row, error: listingError } = await supabaseAdmin.from("listings").upsert({
    user_id: userId,
    product_id: productDbId,
    flipkart_listing_id: listing.listing_id ?? null,
    flipkart_product_id: listing.product_id ?? null,
    sku,
    fsn: sku,
    status: listing.listing_status ?? null,
    procurement_type: listing.fulfillment?.procurement_type ?? null,
    fulfillment_profile: listing.fulfillment_profile ?? null,
    shipping_provider: listing.fulfillment?.shipping_provider ?? null,
    dispatch_sla: listing.fulfillment?.dispatch_sla ?? null,
    hsn: listing.tax?.hsn ?? null,
    product_url: listing.product_url ?? null,
    image_url: listing.product_image_url ?? null,
    vertical: typeof listing.vertical === "string" ? listing.vertical : null,
    archived_status: listing.archived_status ?? null,
    effective_selling_price: sellingPrice,
    listing_data: listing,
    raw: listing,
  }, { onConflict: "user_id,sku" }).select("id").single();
  if (listingError) throw listingError;

  if (listing.price) {
    const { error } = await supabaseAdmin.from("listing_prices").insert({
      user_id: userId,
      listing_id: row.id,
      mrp: listing.price.mrp ?? null,
      selling_price: sellingPrice,
      mop: listing.price.mop ?? null,
      nlc: listing.price.nlc ?? null,
      dealer_price: listing.price.dealer_price ?? null,
      effective_selling_price: sellingPrice,
      local_shipping_fee: listing.shipping_fees?.local ?? null,
      zonal_shipping_fee: listing.shipping_fees?.zonal ?? null,
      national_shipping_fee: listing.shipping_fees?.national ?? null,
      currency: listing.price.currency ?? listing.shipping_fees?.currency ?? "INR",
      effective_at: new Date().toISOString(),
      raw: listing.price,
    });
    if (error) throw error;
  }

  for (const location of listing.locations ?? []) {
    if (!location.id) continue;

    const { data: locationRow, error: locationError } = await supabaseAdmin.from("locations").upsert({
      user_id: userId,
      flipkart_location_id: location.id,
      status: location.status?.toLowerCase() === "disabled" ? "inactive" : "active",
      raw: location,
    }, { onConflict: "user_id,flipkart_location_id" }).select("id").single();
    if (locationError) throw locationError;

    const { error: linkError } = await supabaseAdmin.from("listing_locations").upsert({
      user_id: userId,
      listing_id: row.id,
      location_id: locationRow.id,
      status: location.status ?? null,
    }, { onConflict: "listing_id,location_id" });
    if (linkError) throw linkError;

    const { error: inventoryError } = await supabaseAdmin.from("listing_inventory").upsert({
      user_id: userId,
      listing_id: row.id,
      location_id: locationRow.id,
      quantity: location.inventory ?? 0,
      pending_quantity: location.pending_inventory ?? 0,
      effective_at: new Date().toISOString(),
      raw: location,
    }, { onConflict: "listing_id,location_id" });
    if (inventoryError) throw inventoryError;
  }

  const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").insert({
    user_id: userId,
    sync_run_id: listingRunId,
    source_type: "listing_details",
    external_id: sku,
    payload: listing,
  });
  if (rawError) throw rawError;
}

export async function POST(request: Request) {
  let runId: string | null = null;
  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");
    const body = await request.json().catch(() => ({}));

    const incomingPending = Array.isArray(body?.pendingSkuIds)
      ? body.pendingSkuIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const pageId = typeof body?.pageId === "string" && body.pageId ? body.pageId : null;

    if (typeof body?.syncRunId === "string") {
      runId = body.syncRunId;
      const { data: existingRun, error } = await supabaseAdmin.from("sync_runs")
        .select("id,status,records_seen,records_written")
        .eq("id", runId).eq("user_id", userId).eq("sync_type", "listings").maybeSingle();
      if (error) throw error;
      if (!existingRun) throw new Error("Listing sync run was not found.");
      if (existingRun.status === "failed") throw new Error("Listing sync run has already failed.");
    } else {
      const { data: run, error } = await supabaseAdmin.from("sync_runs").insert({
        user_id: userId,
        sync_type: "listings",
        status: "running",
        metadata: { mode: "paged", pageId },
      }).select("id").single();
      if (error) throw error;
      runId = run.id;
    }

    const listingRunId = runId;
    if (!listingRunId) throw new Error("Listing sync run could not be initialized.");

    const { data: state } = await supabaseAdmin.from("sync_runs")
      .select("records_seen,records_written")
      .eq("id", listingRunId).single();

    let seen = state?.records_seen ?? 0;
    let written = state?.records_written ?? 0;
    let nextPageId: string | null = pageId;
    let pending = incomingPending;

    if (!pending.length) {
      const searchResult = await requestWithRetry<SearchResponse>("/sellers/listings/v3/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters: {}, page_id: pageId }),
      });

      const listings = searchResult.data.listings ?? [];
      seen += listings.length;
      pending = listings.map((item) => item.sku_id).filter(Boolean);

      nextPageId = searchResult.data.has_more ? searchResult.data.next_page_id ?? null : null;

      await supabaseAdmin.from("raw_flipkart_payloads").insert({
        user_id: userId,
        sync_run_id: listingRunId,
        source_type: "listing_search",
        external_id: pageId ?? "first",
        payload: searchResult.data,
      });
    }

    const batch = pending.slice(0, 10);
    const remaining = pending.slice(10);

    if (batch.length) {
      const detailResult = await requestWithRetry<DetailResponse>("/sellers/listings/v3/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku_ids: batch }),
      });

      for (const [sku, listing] of Object.entries(detailResult.data.available ?? {})) {
        await upsertListing(userId, listingRunId, sku, listing);
        written++;
      }

      await supabaseAdmin.from("raw_flipkart_payloads").insert({
        user_id: userId,
        sync_run_id: runId,
        source_type: "listing_details_batch",
        external_id: batch.join(","),
        payload: detailResult.data,
      });
    }

    const hasMore = remaining.length > 0 || nextPageId !== null;
    const complete = !hasMore;

    const { error: progressError } = await supabaseAdmin.from("sync_runs").update({
      status: complete ? "success" : "running",
      finished_at: complete ? new Date().toISOString() : null,
      records_seen: seen,
      records_written: written,
      error_message: null,
      metadata: {
        mode: "paged",
        pageId: nextPageId,
        pendingSkuIds: remaining,
        lastBatchSize: batch.length,
        hasMore,
      },
    }).eq("id", listingRunId).eq("user_id", userId);
    if (progressError) throw progressError;

    return NextResponse.json({
      ok: true,
      syncRunId: listingRunId,
      pageId: nextPageId,
      pendingSkuIds: remaining,
      hasMore,
      listingsSeen: seen,
      listingsWritten: written,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    if (runId) {
      await supabaseAdmin.from("sync_runs").update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: message,
      }).eq("id", runId);
    }
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized sync request." ? 401 : 500 });
  }
}
