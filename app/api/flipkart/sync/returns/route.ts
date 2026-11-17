import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

type ReturnItem = {
  returnId?: string;
  return_id?: string;
  orderItemId?: string;
  order_item_id?: string;
  shipmentId?: string;
  shipment_id?: string;
  locationId?: string;
  location_id?: string;
  status?: string;
  returnReason?: unknown;
  return_reason?: unknown;
  createdDate?: string;
  created_date?: string;
  updatedDate?: string;
  updated_date?: string;
  [key: string]: unknown;
};

type ReturnResponse = {
  returns?: ReturnItem[];
  returnItems?: ReturnItem[];
  nextUrl?: string | null;
  next_url?: string | null;
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

function normalizePath(value: string) {
  const url = new URL(value, "https://api.flipkart.net");
  if (url.hostname !== "api.flipkart.net") {
    throw new Error("Invalid Flipkart pagination URL.");
  }
  return url.pathname + url.search;
}

function firstString(item: ReturnItem, keys: string[]) {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function firstReason(item: ReturnItem) {
  const value = item.returnReason ?? item.return_reason;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["reason", "code", "description", "text"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
  }
  return value == null ? null : JSON.stringify(value);
}

async function upsertReturn(userId: string, runId: string, item: ReturnItem) {
  const returnId = firstString(item, ["returnId", "return_id"]);
  if (!returnId) return false;

  const orderItemFlipkartId = firstString(item, ["orderItemId", "order_item_id"]);
  const shipmentFlipkartId = firstString(item, ["shipmentId", "shipment_id"]);
  const locationFlipkartId = firstString(item, ["locationId", "location_id"]);

  let orderItemId: string | null = null;
  if (orderItemFlipkartId) {
    const { data } = await supabaseAdmin
      .from("order_items")
      .select("id")
      .eq("user_id", userId)
      .eq("flipkart_order_item_id", orderItemFlipkartId)
      .maybeSingle();
    orderItemId = data?.id ?? null;
  }

  let shipmentId: string | null = null;
  if (shipmentFlipkartId) {
    const { data } = await supabaseAdmin
      .from("shipments")
      .select("id")
      .eq("user_id", userId)
      .eq("flipkart_shipment_id", shipmentFlipkartId)
      .maybeSingle();
    shipmentId = data?.id ?? null;
  }

  let locationId: string | null = null;
  if (locationFlipkartId) {
    const { data } = await supabaseAdmin
      .from("locations")
      .select("id")
      .eq("user_id", userId)
      .eq("flipkart_location_id", locationFlipkartId)
      .maybeSingle();
    locationId = data?.id ?? null;
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("returns")
    .select("id,status")
    .eq("user_id", userId)
    .eq("flipkart_return_id", returnId)
    .maybeSingle();

  if (existingError) throw existingError;

  const { data: saved, error } = await supabaseAdmin
    .from("returns")
    .upsert(
      {
        user_id: userId,
        flipkart_return_id: returnId,
        shipment_id: shipmentId,
        order_item_id: orderItemId,
        location_id: locationId,
        source: firstString(item, ["source", "returnType", "return_type"]),
        status: firstString(item, ["status", "returnStatus", "return_status"]),
        return_reason: firstReason(item),
        raw: item,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,flipkart_return_id" },
    )
    .select("id,status")
    .single();

  if (error) throw error;

  if (existing?.status && existing.status !== saved.status) {
    const { error: eventError } = await supabaseAdmin.from("return_events").insert({
      user_id: userId,
      return_id: saved.id,
      event_type: saved.status ?? "STATUS_CHANGED",
      event_timestamp: new Date().toISOString(),
      payload: item,
    });
    if (eventError) throw eventError;
  }

  const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").insert({
    user_id: userId,
    sync_run_id: runId,
    source_type: "return",
    external_id: returnId,
    payload: item,
  });

  if (rawError) throw rawError;
  return true;
}

export async function POST(request: Request) {
  let runId: string | null = null;

  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");

    const { data: run, error: runError } = await supabaseAdmin
      .from("sync_runs")
      .insert({ user_id: userId, sync_type: "returns", status: "running" })
      .select("id")
      .single();

    if (runError) throw runError;
    runId = run.id;

    let totalSeen = 0;
    let totalWritten = 0;
    let pages = 0;

    for (const source of ["customer_return", "courier_return"]) {
      let path = `/sellers/v2/returns?source=${encodeURIComponent(source)}`;

      while (path) {
        const result = await requestWithRetry<ReturnResponse>(path, { method: "GET" });
        const items = result.data.returns ?? result.data.returnItems ?? [];
        totalSeen += items.length;

        for (const item of items) {
          if (await upsertReturn(userId, run.id, item)) totalWritten++;
        }

        const next = result.data.nextUrl ?? result.data.next_url ?? null;
        path = next ? normalizePath(next) : "";
        pages++;

        if (pages > 1000) throw new Error("Return pagination safety limit reached.");
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
      returnsSeen: totalSeen,
      returnsWritten: totalWritten,
      pages,
    });
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
