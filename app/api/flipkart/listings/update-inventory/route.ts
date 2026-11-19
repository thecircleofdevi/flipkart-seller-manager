import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, assertNonNegativeInteger } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Update = { sku: string; locationId?: string; inventory: number };
type Result = { status?: string; errors?: unknown[]; attribute_errors?: unknown[] };

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    if (!Array.isArray(body?.updates) || body.updates.length < 1 || body.updates.length > 10) {
      throw new Error("updates must contain 1 to 10 items.");
    }

    const updates: Update[] = body.updates.map((item: unknown, index: number) => {
      const row = item as Partial<Update>;
      if (typeof row.sku !== "string" || !row.sku.trim()) throw new Error(`updates[${index}].sku is required.`);
      const locationId = typeof row.locationId === "string" && row.locationId.trim() ? row.locationId.trim() : undefined;
      return { sku: row.sku.trim(), locationId, inventory: assertNonNegativeInteger(row.inventory, `updates[${index}].inventory`) };
    });

    const skus = [...new Set(updates.map((u) => u.sku))];
    const { data: listings, error: listingError } = await supabaseAdmin
      .from("listings").select("id,sku,flipkart_product_id").eq("user_id", userId).in("sku", skus);
    if (listingError) throw listingError;

    const listingMap = new Map((listings ?? []).map((row) => [row.sku, row]));
    for (const update of updates) {
      if (!listingMap.get(update.sku)?.flipkart_product_id) throw new Error(`Listing ${update.sku} has no Flipkart product_id. Sync the catalogue first.`);
      if (!update.locationId) {
        const { data: locations, error: locationError } = await supabaseAdmin
          .from("listing_locations")
          .select("locations:location_id(flipkart_location_id)")
          .eq("user_id", userId)
          .eq("listing_id", listingMap.get(update.sku)!.id);
        if (locationError) throw locationError;
        const ids = Array.from(new Set((locations ?? []).map((row) => {
          const location = Array.isArray(row.locations) ? row.locations[0] : row.locations;
          return location?.flipkart_location_id ?? null;
        }).filter(Boolean))) as string[];
        if (ids.length !== 1) throw new Error(`Listing ${update.sku} has multiple or unknown locations. Supply locationId explicitly.`);
        update.locationId = ids[0];
      }
    }

    const payload: Record<string, unknown> = {};
    for (const update of updates) {
      payload[update.sku] = {
        product_id: listingMap.get(update.sku)!.flipkart_product_id,
        locations: [{ id: update.locationId, inventory: update.inventory }],
      };
    }

    const result = await flipkartRequest<Record<string, Result>>("/sellers/listings/v3/update/inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const succeeded: string[] = [];
    const failed: Record<string, Result> = {};
    for (const update of updates) {
      const response = result.data[update.sku];
      if (response && String(response.status ?? "").toUpperCase() === "SUCCESS") succeeded.push(update.sku);
      else failed[update.sku] = response ?? { status: "UNKNOWN" };
    }

    for (const sku of succeeded) {
      const update = updates.find((item) => item.sku === sku)!;
      const listing = listingMap.get(sku)!;
      const locationId = update.locationId;
      if (!locationId) throw new Error(`No location resolved for ${sku}.`);
      const { data: location } = await supabaseAdmin.from("locations").select("id").eq("user_id", userId).eq("flipkart_location_id", locationId).maybeSingle();
      if (!location) continue;
      await supabaseAdmin.from("listing_inventory").upsert({
        user_id: userId, listing_id: listing.id, location_id: location.id,
        quantity: update.inventory, effective_at: new Date().toISOString(), raw: { source: "mutation", flipkart: result.data[sku] ?? {} },
      }, { onConflict: "listing_id,location_id" });
    }

    await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/listings/v3/update/inventory", requestMeta: { skus }, responseMeta: { succeeded, failed }, statusCode: result.status, startedAt });
    return NextResponse.json({ ok: true, succeeded, failed, response: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inventory update failed.";
    if (userId) await logFlipkartMutation({ userId, method: "POST", endpoint: "/sellers/listings/v3/update/inventory", requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502, errorMessage: message, startedAt });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
