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
    const listings = object(body?.listings, "listings");
    const skus = Object.keys(listings);

    if (skus.length < 1 || skus.length > 10) throw new Error("listings must contain 1 to 10 SKUs.");

    for (const sku of skus) {
      const payload = object(listings[sku], `listings.${sku}`);
      if (typeof payload.product_id !== "string" || !payload.product_id.trim()) {
        throw new Error(`listings.${sku}.product_id is required.`);
      }
    }

    const result = await flipkartRequest<Record<string, Result>>("/sellers/listings/v3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listings),
    });

    const succeeded: string[] = [];
    const failed: Record<string, Result> = {};

    for (const sku of skus) {
      const response = result.data[sku];
      if (response && ["SUCCESS", "WARNING"].includes(String(response.status ?? "").toUpperCase())) {
        succeeded.push(sku);
      } else {
        failed[sku] = response ?? { status: "UNKNOWN" };
      }
    }

    if (succeeded.length) {
      const rows = succeeded.map((sku) => {
        const payload = listings[sku] as Record<string, unknown>;
        const price = payload.price && typeof payload.price === "object" ? payload.price as Record<string, unknown> : {};
        const tax = payload.tax && typeof payload.tax === "object" ? payload.tax as Record<string, unknown> : {};
        const fulfillment = payload.fulfillment && typeof payload.fulfillment === "object" ? payload.fulfillment as Record<string, unknown> : {};
        return {
          user_id: userId,
          sku,
          flipkart_product_id: typeof payload.product_id === "string" ? payload.product_id : null,
          hsn: typeof tax.hsn === "string" ? tax.hsn : null,
          status: typeof payload.listing_status === "string" ? payload.listing_status : null,
          fulfillment_profile: typeof payload.fulfillment_profile === "string" ? payload.fulfillment_profile : null,
          dispatch_sla: typeof fulfillment.dispatch_sla === "number" ? fulfillment.dispatch_sla : null,
          shipping_provider: typeof fulfillment.shipping_provider === "string" ? fulfillment.shipping_provider : null,
          procurement_type: typeof fulfillment.procurement_type === "string" ? fulfillment.procurement_type : null,
          effective_selling_price: typeof price.selling_price === "number" ? price.selling_price : null,
          listing_data: payload,
          raw: { source: "mutation", flipkart: responseForSku(result.data, sku) },
          updated_at: new Date().toISOString(),
        };
      });

      await supabaseAdmin.from("listings").upsert(rows, { onConflict: "user_id,sku" });
    }

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: "/sellers/listings/v3",
      requestMeta: { skus },
      responseMeta: { succeeded, failed },
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, succeeded, failed, response: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Listing creation failed.";
    if (userId) {
      await logFlipkartMutation({
        userId,
        method: "POST",
        endpoint: "/sellers/listings/v3",
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

function responseForSku(response: Record<string, Result>, sku: string) {
  return response[sku] ?? {};
}
