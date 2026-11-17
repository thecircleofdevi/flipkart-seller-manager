import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type Listing = {
  listing_id?: string;
  product_id?: string;
  sku_id?: string;
  price?: { mrp?: number; selling_price?: number; currency?: string };
  listing_status?: string;
  shipping_fees?: {
    local?: number;
    zonal?: number;
    national?: number;
    currency?: string;
  };
  fulfillment_profile?: string;
  fulfillment?: {
    dispatch_sla?: number;
    shipping_provider?: string;
    procurement_type?: string;
  };
  tax?: { hsn?: string; tax_code?: string };
  locations?: Array<{
    id?: string;
    status?: string;
    inventory?: number;
  }>;
  [key: string]: unknown;
};

type SearchResponse = {
  next_page_id?: string | null;
  has_more?: boolean;
  listings?: Array<{
    listing_id: string;
    product_id: string;
    sku_id: string;
  }>;
};

type DetailResponse = {
  available?: Record<string, Listing>;
  unavailable?: string[];
  invalid?: string[];
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

async function requestWithRetry<T>(path: string, init: RequestInit, attempts = 4) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await flipkartRequest<T>(path, init);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Flipkart API (500|502|503|504)/.test(message) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }

  throw lastError;
}

async function upsertListing(userId: string, runId: string, sku: string, listing: Listing) {
  let listingDbId: string;

  const { data: row, error: listingError } = await supabaseAdmin
    .from("listings")
    .upsert(
      {
        user_id: userId,
        flipkart_listing_id: listing.listing_id ?? null,
        sku,
        status: listing.listing_status ?? null,
        procurement_type: listing.fulfillment?.procurement_type ?? null,
        fulfillment_profile: listing.fulfillment_profile ?? null,
        shipping_provider: listing.fulfillment?.shipping_provider ?? null,
        dispatch_sla: listing.fulfillment?.dispatch_sla ?? null,
        hsn: listing.tax?.hsn ?? null,
        listing_data: listing,
        raw: listing,
      },
      { onConflict: "user_id,sku" },
    )
    .select("id")
    .single();

  if (listingError) throw listingError;
  listingDbId = row.id;

  if (listing.price) {
    const { error } = await supabaseAdmin.from("listing_prices").insert({
      user_id: userId,
      listing_id: listingDbId,
      mrp: listing.price.mrp ?? null,
      selling_price: listing.price.selling_price ?? null,
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

    const { data: locationRow, error: locationError } = await supabaseAdmin
      .from("locations")
      .upsert(
        {
          user_id: userId,
          flipkart_location_id: location.id,
          status: location.status?.toLowerCase() === "disabled" ? "inactive" : "active",
          raw: location,
        },
        { onConflict: "user_id,flipkart_location_id" },
      )
      .select("id")
      .single();

    if (locationError) throw locationError;

    const { error: linkError } = await supabaseAdmin
      .from("listing_locations")
      .upsert(
        {
          user_id: userId,
          listing_id: listingDbId,
          location_id: locationRow.id,
          status: location.status ?? null,
        },
        { onConflict: "listing_id,location_id" },
      );

    if (linkError) throw linkError;

    const { error: inventoryError } = await supabaseAdmin
      .from("listing_inventory")
      .insert({
        user_id: userId,
        listing_id: listingDbId,
        location_id: locationRow.id,
        quantity: location.inventory ?? 0,
        effective_at: new Date().toISOString(),
        raw: location,
      });

    if (inventoryError) throw inventoryError;
  }

  const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").insert({
    user_id: userId,
    sync_run_id: runId,
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

    const { data: run, error: runError } = await supabaseAdmin
      .from("sync_runs")
      .insert({ user_id: userId, sync_type: "listings", status: "running" })
      .select("id")
      .single();

    if (runError) throw runError;
    runId = run.id;

    let pageId: string | null = null;
    let pages = 0;
    let seen = 0;
    let written = 0;

    while (true) {
      const result = await requestWithRetry<SearchResponse>("/sellers/listings/v3/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: {},
          page_id: pageId,
        }),
      });

      const listings = result.data.listings ?? [];
      seen += listings.length;

      for (let i = 0; i < listings.length; i += 10) {
        const batch = listings.slice(i, i + 10);
        const skuIds = batch.map((item) => item.sku_id);
        if (!skuIds.length) continue;

        const detail = await requestWithRetry<DetailResponse>(
          `/sellers/listings/v3/${skuIds.map(encodeURIComponent).join(",")}`,
          { method: "GET" },
        );

        for (const [sku, listing] of Object.entries(detail.data.available ?? {})) {
          await upsertListing(userId, run.id, sku, listing);
          written++;
        }
      }

      pageId = result.data.has_more ? result.data.next_page_id ?? null : null;
      pages++;

      if (!pageId) break;
      if (pages > 1000) throw new Error("Listing pagination safety limit reached.");
    }

    const { error: finishError } = await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        records_seen: seen,
        records_written: written,
      })
      .eq("id", run.id);

    if (finishError) throw finishError;

    return NextResponse.json({ ok: true, listingsSeen: seen, listingsWritten: written, pages });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";

    if (runId) {
      await supabaseAdmin
        .from("sync_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: message,
        })
        .eq("id", runId);
    }

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Unauthorized sync request." ? 401 : 500 },
    );
  }
}
