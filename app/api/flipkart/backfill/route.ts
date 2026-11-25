import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { POST as runShipmentSync } from "@/app/api/flipkart/sync/route";
import { POST as runOrderSync } from "@/app/api/flipkart/sync/orders/route";
import { POST as runReturnsSync } from "@/app/api/flipkart/sync/returns/route";
import { POST as runShipmentDetailsSync } from "@/app/api/flipkart/sync/details/route";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB_KEY = "historical:2025-03-01:present:v2";
const SHIPMENT_FILTERS = [
  { filterType: "preDispatch" as const },
  { filterType: "postDispatch" as const, shipmentType: "NORMAL" as const },
  { filterType: "postDispatch" as const, shipmentType: "SELF" as const },
  { filterType: "cancelled" as const },
];

type BackfillMetadata = {
  ordersNextPageURL?: string | null;
  ordersSyncRunId?: string | null;
  shipmentFilterIndex?: number;
  shipmentNextPageUrl?: string | null;
  shipmentSyncRunId?: string | null;
  pendingShipmentIds?: string[];
  shipmentPageComplete?: boolean;
  returnNextUrl?: string | null;
  returnCurrentSource?: string | null;
  returnSyncRunId?: string | null;
};

async function getUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  if (user.id !== process.env.FLIPKART_OWNER_USER_ID) throw new Error("Forbidden");
  return user;
}

function internalRequest(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: {
      "x-flipkart-sync-secret": process.env.FLIPKART_SYNC_SECRET ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function invokeSync(
  request: Request,
  type: "orders" | "shipments" | "returns" | "shipment_details",
  body: Record<string, unknown>,
) {
  const req = internalRequest(request.url, body);
  if (type === "orders") return runOrderSync(req);
  if (type === "shipments") return runShipmentSync(req);
  if (type === "returns") return runReturnsSync(req);
  return runShipmentDetailsSync(req);
}

async function updateWindow(
  id: string,
  patch: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("backfill_windows")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

async function updateJob(
  id: string,
  patch: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("backfill_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function POST(request: Request) {
  try {
    const user = await getUser();
    const body = await request.json().catch(() => ({}));
    const action =
      body?.action === "start" ? "start" :
      body?.action === "status" ? "status" :
      body?.action === "resume" ? "resume" :
      "step";

    if (action === "status") {
      const { data: job, error: jobError } = await supabaseAdmin
        .from("backfill_jobs")
        .select("id,status,start_at,end_at,window_days,current_window_start,current_window_end,completed_windows,total_windows,last_error,updated_at,completed_at")
        .eq("user_id", user.id)
        .eq("job_key", JOB_KEY)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) return NextResponse.json({ ok: true, status: "not_started" });

      const { data: window } = await supabaseAdmin
        .from("backfill_windows")
        .select("id,window_start,window_end,status,orders_status,shipments_status,returns_status,shipment_details_status,last_error,metadata")
        .eq("backfill_job_id", job.id)
        .neq("status", "completed")
        .order("window_start", { ascending: true })
        .limit(1)
        .maybeSingle();

      return NextResponse.json({ ok: true, ...job, currentWindow: window ?? null });
    }

    if (action === "start") {
      const startAt = new Date("2025-03-01T00:00:00+05:30");
      const endAt = new Date();
      const windowMs = 7 * 24 * 60 * 60 * 1000;
      const windows: Array<{ start: string; end: string }> = [];

      for (let cursor = new Date(startAt); cursor < endAt; cursor = new Date(cursor.getTime() + windowMs)) {
        const end = new Date(Math.min(cursor.getTime() + windowMs, endAt.getTime()));
        windows.push({ start: cursor.toISOString(), end: end.toISOString() });
      }

      const { data: job, error: jobError } = await supabaseAdmin
        .from("backfill_jobs")
        .upsert({
          user_id: user.id,
          job_key: JOB_KEY,
          status: "running",
          start_at: startAt.toISOString(),
          end_at: endAt.toISOString(),
          window_days: 7,
          total_windows: windows.length,
          completed_windows: 0,
          last_error: null,
          completed_at: null,
        }, { onConflict: "user_id,job_key" })
        .select("id,status,total_windows,completed_windows")
        .single();
      if (jobError) throw jobError;

      await supabaseAdmin.from("backfill_windows").delete().eq("backfill_job_id", job.id);
      const { error: windowError } = await supabaseAdmin.from("backfill_windows").insert(
        windows.map((w) => ({
          backfill_job_id: job.id,
          window_start: w.start,
          window_end: w.end,
          status: "pending",
          orders_status: "pending",
          shipments_status: "pending",
          returns_status: "pending",
          shipment_details_status: "pending",
          metadata: {},
        })),
      );
      if (windowError) throw windowError;

      return NextResponse.json({ ok: true, action: "started", jobId: job.id, totalWindows: windows.length });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("backfill_jobs")
      .select("*")
      .eq("user_id", user.id)
      .eq("job_key", JOB_KEY)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job) return NextResponse.json({ ok: false, error: "Historical backfill has not been started." }, { status: 404 });

    if (action === "resume") {
      if (job.status === "completed") return NextResponse.json({ ok: true, status: "completed" });

      await updateJob(job.id, { status: "running", last_error: null });
      await supabaseAdmin.from("backfill_windows")
        .update({ status: "pending", last_error: null, updated_at: new Date().toISOString() })
        .eq("backfill_job_id", job.id)
        .eq("status", "failed");

      return NextResponse.json({ ok: true, action: "resumed", jobId: job.id });
    }

    if (job.status === "completed") {
      return NextResponse.json({
        ok: true,
        status: "completed",
        completedWindows: job.completed_windows,
        totalWindows: job.total_windows,
      });
    }

    if (job.status === "failed") {
      await updateJob(job.id, { status: "running", last_error: null });
      await supabaseAdmin.from("backfill_windows")
        .update({ status: "pending", last_error: null, updated_at: new Date().toISOString() })
        .eq("backfill_job_id", job.id)
        .eq("status", "failed");
    }

    const { data: candidate, error: candidateError } = await supabaseAdmin
      .from("backfill_windows")
      .select("*")
      .eq("backfill_job_id", job.id)
      .neq("status", "completed")
      .order("window_start", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateError) throw candidateError;

    if (!candidate) {
      await updateJob(job.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
        last_error: null,
      });
      return NextResponse.json({
        ok: true,
        status: "completed",
        completedWindows: job.total_windows,
        totalWindows: job.total_windows,
      });
    }

    const claimTime = new Date().toISOString();
    const { data: win, error: claimError } = await supabaseAdmin
      .from("backfill_windows")
      .update({ status: "running", updated_at: claimTime })
      .eq("id", candidate.id)
      .in("status", ["pending", "failed"])
      .select("*")
      .maybeSingle();

    if (claimError) throw claimError;
    if (!win) {
      return NextResponse.json({
        ok: true,
        status: "running",
        message: "Backfill window was claimed by another worker. Retry the step.",
      });
    }

    try {
      const metadata = ((win.metadata ?? {}) as BackfillMetadata);

      if (win.orders_status !== "completed") {
        const response = await invokeSync(request, "orders", {
          mode: "full",
          dateField: "orderDate",
          orderDateAfter: win.window_start,
          orderDateBefore: win.window_end,
          ...(metadata.ordersSyncRunId ? { syncRunId: metadata.ordersSyncRunId } : {}),
          ...(metadata.ordersNextPageURL ? { nextPageURL: metadata.ordersNextPageURL } : {}),
        });
        const result = await response.clone().json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? "Orders backfill failed.");

        const nextMetadata: BackfillMetadata = {
          ...metadata,
          ordersSyncRunId: result.syncRunId ?? metadata.ordersSyncRunId ?? null,
          ordersNextPageURL: result.hasMore ? result.nextPageURL : null,
        };

        if (result.hasMore) {
          await updateWindow(win.id, { metadata: nextMetadata });
          return NextResponse.json({ ok: true, status: "running", stage: "orders", windowStart: win.window_start, windowEnd: win.window_end, result });
        }

        await updateWindow(win.id, {
          orders_status: "completed",
          metadata: { ...nextMetadata, ordersNextPageURL: null },
        });
        return NextResponse.json({ ok: true, status: "running", stage: "orders", windowStart: win.window_start, windowEnd: win.window_end, result });
      }

      if (win.shipments_status !== "completed") {
        const filterIndex = Number.isInteger(metadata.shipmentFilterIndex) ? metadata.shipmentFilterIndex! : 0;
        const filter = SHIPMENT_FILTERS[filterIndex];

        if (!filter) {
          await updateWindow(win.id, {
            shipments_status: "completed",
            shipment_details_status: "completed",
            metadata: { ...metadata, shipmentFilterIndex: SHIPMENT_FILTERS.length, shipmentNextPageUrl: null, shipmentSyncRunId: null, pendingShipmentIds: [] },
          });
          return NextResponse.json({ ok: true, status: "running", stage: "shipments", windowStart: win.window_start, windowEnd: win.window_end, message: "All shipment filters completed." });
        }

        const pendingIds = metadata.pendingShipmentIds ?? [];
        let result: any = null;

        if (pendingIds.length > 0) {
          const detailResponse = await invokeSync(request, "shipment_details", { shipmentIds: pendingIds });
          const detailResult = await detailResponse.clone().json().catch(() => ({}));
          if (!detailResponse.ok) throw new Error(detailResult.error ?? "Shipment detail batch failed.");

          const detailMetadata: BackfillMetadata = { ...metadata, pendingShipmentIds: [] };
          if (metadata.shipmentPageComplete) {
            detailMetadata.shipmentFilterIndex = filterIndex + 1;
            detailMetadata.shipmentNextPageUrl = null;
            detailMetadata.shipmentSyncRunId = null;
            detailMetadata.shipmentPageComplete = false;
          }
          await updateWindow(win.id, { metadata: detailMetadata });
          return NextResponse.json({ ok: true, status: "running", stage: "shipment_details", windowStart: win.window_start, windowEnd: win.window_end, result: detailResult });
        }

        result = await invokeSync(request, "shipments", {
          mode: "full",
          filterType: filter.filterType,
          ...(filter.shipmentType ? { shipmentType: filter.shipmentType } : {}),
          modifiedFrom: win.window_start,
          modifiedTo: win.window_end,
          ...(metadata.shipmentSyncRunId ? { syncRunId: metadata.shipmentSyncRunId } : {}),
          ...(metadata.shipmentNextPageUrl ? { nextPageUrl: metadata.shipmentNextPageUrl } : {}),
        });
        const shipmentResult = await result.clone().json().catch(() => ({}));
        if (!result.ok) throw new Error(shipmentResult.error ?? "Shipment backfill failed.");

        const shipmentIds = Array.isArray(shipmentResult.shipmentIds)
          ? shipmentResult.shipmentIds.filter((id: unknown): id is string => typeof id === "string")
          : [];

        if (shipmentIds.length > 0) {
          await updateWindow(win.id, {
            metadata: {
              ...metadata,
              pendingShipmentIds: shipmentIds,
              shipmentNextPageUrl: shipmentResult.hasMore ? shipmentResult.nextPageUrl : null,
              shipmentSyncRunId: shipmentResult.syncRunId ?? metadata.shipmentSyncRunId ?? null,
              shipmentPageComplete: !shipmentResult.hasMore,
            },
          });
          return NextResponse.json({ ok: true, status: "running", stage: "shipment_details", windowStart: win.window_start, windowEnd: win.window_end, result: shipmentResult });
        }

        if (shipmentResult.hasMore) {
          await updateWindow(win.id, {
            metadata: {
              ...metadata,
              shipmentNextPageUrl: shipmentResult.nextPageUrl,
              shipmentSyncRunId: shipmentResult.syncRunId ?? metadata.shipmentSyncRunId ?? null,
              shipmentPageComplete: false,
            },
          });
        } else {
          await updateWindow(win.id, {
            metadata: {
              ...metadata,
              shipmentFilterIndex: filterIndex + 1,
              shipmentNextPageUrl: null,
              shipmentSyncRunId: null,
              shipmentPageComplete: false,
            },
          });
        }

        return NextResponse.json({ ok: true, status: "running", stage: "shipments", windowStart: win.window_start, windowEnd: win.window_end, result: shipmentResult });
      }

      if (win.returns_status !== "completed") {
        const response = await invokeSync(request, "returns", {
          mode: "full",
          dateField: "createdDate",
          createdAfter: win.window_start,
          createdBefore: win.window_end,
          ...(metadata.returnSyncRunId ? { syncRunId: metadata.returnSyncRunId } : {}),
          ...(metadata.returnNextUrl ? { nextUrl: metadata.returnNextUrl } : {}),
          ...(metadata.returnCurrentSource ? { currentSource: metadata.returnCurrentSource } : {}),
        });
        const result = await response.clone().json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? "Returns backfill failed.");

        const nextMetadata: BackfillMetadata = {
          ...metadata,
          returnSyncRunId: result.syncRunId ?? metadata.returnSyncRunId ?? null,
          returnNextUrl: result.nextUrl ?? null,
          returnCurrentSource: result.currentSource ?? metadata.returnCurrentSource ?? "customer_return",
        };

        if (result.hasMore) {
          await updateWindow(win.id, { metadata: nextMetadata });
          return NextResponse.json({ ok: true, status: "running", stage: "returns", windowStart: win.window_start, windowEnd: win.window_end, result });
        }

        const nextCompletedWindows = (job.completed_windows ?? 0) + 1;
        await updateWindow(win.id, {
          returns_status: "completed",
          status: "completed",
          shipment_details_status: "completed",
          completed_at: new Date().toISOString(),
          metadata: nextMetadata,
        });
        await updateJob(job.id, { completed_windows: nextCompletedWindows });

        return NextResponse.json({
          ok: true,
          status: "running",
          stage: "returns",
          windowStart: win.window_start,
          windowEnd: win.window_end,
          result,
          completedWindows: nextCompletedWindows,
          totalWindows: job.total_windows,
        });
      }

      throw new Error("Backfill window reached an invalid state.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backfill stage failed.";
      await updateWindow(win.id, { status: "failed", last_error: message });
      await updateJob(job.id, { status: "failed", last_error: message });
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical backfill failed.";
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
