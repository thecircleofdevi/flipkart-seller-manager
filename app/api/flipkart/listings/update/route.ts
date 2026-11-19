import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Result = {
  status?: string;
  errors?: unknown[];
  attribute_errors?: unknown[];
};

const ALLOWED_KEYS = new Set([
  "price",
  "tax",
  "listing_status",
  "shipping_fees",
  "fulfillment_profile",
  "fulfillment",
  "packages",
  "locations",
  "address_label",
  "dating_label",
  "archived_status",
]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";

  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();

    if (!Array.isArray(body?.updates) || body.updates.length < 1 || body.updates.length > 10) {
      throw new Error("updates must contain 1 to 10 items.");
    }

    const updates = body.updates.map((item: unknown, index: number) => {
      const row = object(item, `updates[${index}]`);
      const sku = typeof row.sku === "string" ? row.sku.trim() : "";
      if (!sku) throw new Error(`updates[${index}].sku is required.`);

      const patch = object(row.patch, `updates[${index}].patch`);
      for (const key of Object.keys(patch)) {
        if (!ALLOWED_KEYS.has(key)) throw new Error(`updates[${index}].patch.${key} is not supported.`);
      }

      return { sku, patch };
    });

    const skus = [...new Set(updates.map((item) => item.sku))];
    if (skus.length !== updates.length) throw new Error("Duplicate SKUs are not allowed in one update request.");

    const { data: listings, error } = await supabaseAdmin
      .from("listings")
      .select("id,sku,flipkart_product_id,listing_data")
      .eq("user_id", userId)
      .in("sku", skus);

    if (error) throw error;
    const listingMap = new Map((listings ?? []).map((listing) => [listing.sku, listing]));

    for (const update of updates) {
      if (!listingMap.get(update.sku)?.flipkart_product_id) {
        throw new Error(`Listing ${update.sku} has no Flipkart product_id. Sync the catalogue first.`);
      }
    }

    const payload: Record<string, unknown> = {};
    for (const update of updates) {
      payload[update.sku] = {
        product_id: listingMap.get(update.sku)!.flipkart_product_id,
        ...update.patch,
      };
    }

    const result = await flipkartRequest<Record<string, Result>>("/sellers/listings/v3/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const succeeded: string[] = [];
    const failed: Record<string, Result> = {};

    for (const update of updates) {
      const response = result.data[update.sku];
      if (response && ["SUCCESS", "WARNING"].includes(String(response.status ?? "").toUpperCase())) {
        succeeded.push(update.sku);
      } else {
        failed[update.sku] = response ?? { status: "UNKNOWN" };
      }
    }

    for (const sku of succeeded) {
      const update = updates.find((item: { sku: string; patch: Record<string, unknown> }) => item.sku === sku)!;
      const listing = listingMap.get(sku)!;
      const patch = update.patch;
      const fulfillment = patch.fulfillment && typeof patch.fulfillment === "object" ? patch.fulfillment as Record<string, unknown> : {};
      const price = patch.price && typeof patch.price === "object" ? patch.price as Record<string, unknown> : {};

      const localPatch: Record<string, unknown> = {
        raw: { ...(listing.listing_data && typeof listing.listing_data === "object" ? listing.listing_data : {}), ...patch },
        listing_data: { ...(listing.listing_data && typeof listing.listing_data === "object" ? listing.listing_data : {}), ...patch },
        updated_at: new Date().toISOString(),
      };

      if (typeof patch.listing_status === "string") localPatch.status = patch.listing_status;
      if (typeof patch.fulfillment_profile === "string") localPatch.fulfillment_profile = patch.fulfillment_profile;
      if (typeof fulfillment.dispatch_sla === "number") localPatch.dispatch_sla = fulfillment.dispatch_sla;
      if (typeof fulfillment.shipping_provider === "string") localPatch.shipping_provider = fulfillment.shipping_provider;
      if (typeof fulfillment.procurement_type === "string") localPatch.procurement_type = fulfillment.procurement_type;
      if (typeof price.selling_price === "number") localPatch.effective_selling_price = price.selling_price;
      else if (typeof price.sellingPrice === "number") localPatch.effective_selling_price = price.sellingPrice;
      if (typeof patch.archived_status === "string") localPatch.archived_status = patch.archived_status;

      await supabaseAdmin.from("listings").update(localPatch).eq("id", listing.id).eq("user_id", userId);
    }

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: "/sellers/listings/v3/update",
      requestMeta: { skus },
      responseMeta: { succeeded, failed },
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, succeeded, failed, response: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Listing update failed.";
    if (userId) {
      await logFlipkartMutation({
        userId,
        method: "POST",
        endpoint: "/sellers/listings/v3/update",
        requestMeta: {},
        responseMeta: {},
        statusCode: message === "Unauthorized." ? 401 : 502,
        errorMessage: message,
        startedAt,
      });
    }
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
