import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SyncAlreadyRunningError, claimSyncRun } from "@/lib/sync-lock";

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

function normalizePath(value: string) {
  const url = new URL(value, "https://api.flipkart.net");
  if (url.hostname !== "api.flipkart.net") throw new Error("Invalid Flipkart pagination URL.");

  // Flipkart's v2 returns endpoint has been observed returning a legacy
  // pagination path without the /sellers/v2 prefix. The documented endpoint
  // is /sellers/v2/returns, so normalize only this known pagination shape.
  if (url.pathname.startsWith("/returns/search/")) {
    url.pathname = "/sellers/v2" + url.pathname;
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

  const [{ data: orderItem }, { data: shipment }, { data: location }, { data: existing, error: existingError }] =
    await Promise.all([
      orderItemFlipkartId
        ? supabaseAdmin.from("order_items").select("id").eq("user_id", userId).eq("flipkart_order_item_id", orderItemFlipkartId).maybeSingle()
        : Promise.resolve({ data: null }),
      shipmentFlipkartId
        ? supabaseAdmin.from("shipments").select("id").eq("user_id", userId).eq("flipkart_shipment_id", shipmentFlipkartId).maybeSingle()
        : Promise.resolve({ data: null }),
      locationFlipkartId
        ? supabaseAdmin.from("locations").select("id").eq("user_id", userId).eq("flipkart_location_id", locationFlipkartId).maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin.from("returns").select("id,status").eq("user_id", userId).eq("flipkart_return_id", returnId).maybeSingle(),
    ]);

  if (existingError) throw existingError;

  const nextStatus = firstString(item, ["status", "returnStatus", "return_status"]);
  const createdAt = firstString(item, ["createdDate", "created_date"]);
  const updatedAt = firstString(item, ["updatedDate", "updated_date"]);

  const { data: saved, error } = await supabaseAdmin.from("returns").upsert({
    user_id: userId,
    flipkart_return_id: returnId,
    shipment_id: shipment?.id ?? null,
    order_item_id: orderItem?.id ?? null,
    location_id: location?.id ?? null,
    source: firstString(item, ["source", "returnType", "return_type"]),
    status: nextStatus,
    return_reason: firstReason(item),
    raw: item,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : { updated_at: new Date().toISOString() }),
  }, { onConflict: "user_id,flipkart_return_id" }).select("id,status").single();

  if (error) throw error;

  if (existing?.status !== nextStatus && nextStatus) {
    const { error: eventError } = await supabaseAdmin.from("return_events").insert({
      user_id: userId,
      return_id: saved.id,
      event_type: nextStatus,
      event_timestamp: updatedAt ?? createdAt ?? new Date().toISOString(),
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
    const body = await request.json().catch(() => ({}));

    const mode = body?.mode === "full" ? "full" : "incremental";
    const source = body?.source === "courier_return" ? "courier_return" : body?.source === "customer_return" ? "customer_return" : null;
    const sources = source ? [source] : ["customer_return", "courier_return"];

    let nextUrl = typeof body?.nextUrl === "string" && body.nextUrl ? normalizePath(body.nextUrl) : null;
    let currentSource = typeof body?.currentSource === "string" && sources.includes(body.currentSource) ? body.currentSource : sources[0];

    let modifiedAfter: string | null = typeof body?.modifiedAfter === "string" ? body.modifiedAfter : null;
    let modifiedBefore: string | null = typeof body?.modifiedBefore === "string" ? body.modifiedBefore : null;

    if (!modifiedAfter || !modifiedBefore) {
      if (mode === "incremental") {
        const { data: latestSuccess } = await supabaseAdmin.from("sync_runs")
          .select("finished_at")
          .eq("user_id", userId)
          .eq("sync_type", "returns")
          .eq("status", "success")
          .not("finished_at", "is", null)
          .order("finished_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const from = latestSuccess?.finished_at
          ? new Date(new Date(latestSuccess.finished_at).getTime() - 2 * 60 * 60 * 1000)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        modifiedAfter = from.toISOString();
        modifiedBefore = new Date().toISOString();
      }
    }

    if (typeof body?.syncRunId === "string") {
      runId = body.syncRunId;
      const { data: existingRun, error } = await supabaseAdmin.from("sync_runs")
        .select("id,status,records_seen,records_written")
        .eq("id", runId).eq("user_id", userId).eq("sync_type", "returns").maybeSingle();
      if (error) throw error;
      if (!existingRun) throw new Error("Return sync run was not found.");
      if (existingRun.status === "failed") throw new Error("Return sync run has already failed.");
    } else {
      runId = await claimSyncRun(userId, "returns", "returns:" + mode + ":" + sources.join(","), { mode, sources, modifiedAfter, modifiedBefore, currentSource });
    }

    const returnRunId = runId;
    if (!returnRunId) throw new Error("Return sync run could not be initialized.");

    const { data: runState } = await supabaseAdmin.from("sync_runs")
      .select("records_seen,records_written")
      .eq("id", returnRunId).single();

    let totalSeen = runState?.records_seen ?? 0;
    let totalWritten = runState?.records_written ?? 0;

    if (!nextUrl) {
      const params = new URLSearchParams({ source: currentSource });
      if (modifiedAfter) params.set("modifiedAfter", modifiedAfter);
      if (modifiedBefore) params.set("modifiedBefore", modifiedBefore);
      nextUrl = `/sellers/v2/returns?${params.toString()}`;
    }

    const requestStarted = Date.now();
    const result = await requestWithRetry<ReturnResponse>(nextUrl, { method: "GET" });
    const items = result.data.returns ?? result.data.returnItems ?? [];
    totalSeen += items.length;

    for (const item of items) {
      if (await upsertReturn(userId, returnRunId, item)) totalWritten++;
    }

    const returnedNext = result.data.nextUrl ?? result.data.next_url ?? null;
    const hasMore = Boolean(returnedNext);

    let nextSource = currentSource;
    let continuationUrl = hasMore ? normalizePath(returnedNext!) : null;

    if (!hasMore) {
      const index = sources.indexOf(currentSource);
      if (index < sources.length - 1) {
        nextSource = sources[index + 1];
        continuationUrl = null;
      }
    }

    const complete = !hasMore && sources.indexOf(currentSource) === sources.length - 1;

    const { error: progressError } = await supabaseAdmin.from("sync_runs").update({
      status: complete ? "success" : "running",
      finished_at: complete ? new Date().toISOString() : null,
      records_seen: totalSeen,
      records_written: totalWritten,
      error_message: null,
      metadata: {
        mode, sources, currentSource: nextSource, modifiedAfter, modifiedBefore,
        hasMore, lastPageSize: items.length,
        lastRequestDurationMs: Date.now() - requestStarted,
      },
    }).eq("id", returnRunId).eq("user_id", userId);
    if (progressError) throw progressError;

    return NextResponse.json({
      ok: true,
      mode,
      syncRunId: returnRunId,
      currentSource: nextSource,
      nextUrl: continuationUrl,
      hasMore: !complete,
      modifiedAfter,
      modifiedBefore,
      recordsSeen: totalSeen,
      recordsWritten: totalWritten,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync error";
    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json({ ok: false, error: message, syncRunId: error.syncRunId }, { status: 409 });
    }
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
