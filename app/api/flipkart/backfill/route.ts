import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { POST as runShipmentSync } from "@/app/api/flipkart/sync/route";
import { POST as runOrderSync } from "@/app/api/flipkart/sync/orders/route";
import { POST as runReturnsSync } from "@/app/api/flipkart/sync/returns/route";
import { POST as runShipmentDetailsSync } from "@/app/api/flipkart/sync/details/route";

export const runtime = "nodejs";
export const maxDuration = 300;

const JOB_KEY = "historical:2025-03-01:present:v1";

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

async function invokeSync(request: Request, type: "orders" | "shipments" | "returns" | "shipment_details", body: Record<string, unknown>) {
  const req = internalRequest(request.url, body);
  if (type === "orders") return runOrderSync(req);
  if (type === "shipments") return runShipmentSync(req);
  if (type === "returns") return runReturnsSync(req);
  return runShipmentDetailsSync(req);
}

export async function POST(request: Request) {
  try {
    const user = await getUser();
    const body = await request.json().catch(() => ({}));
    const action = body?.action === "start" ? "start" : body?.action === "status" ? "status" : body?.action === "resume" ? "resume" : "step";

    if (action === "status") {
      const { data: job, error: jobError } = await supabaseAdmin
        .from("backfill_jobs")
        .select("id,status,start_at,end_at,window_days,current_window_start,current_window_end,completed_windows,total_windows,last_error,updated_at,completed_at")
        .eq("user_id", user.id)
        .eq("job_key", JOB_KEY)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) {
        return NextResponse.json({ ok: true, status: "not_started" });
      }
      const { data: window } = await supabaseAdmin
        .from("backfill_windows")
        .select("id,window_start,window_end,status,orders_status,shipments_status,returns_status,last_error")
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
        })),
      );
      if (windowError) throw windowError;

      return NextResponse.json({ ok: true, action: "started", jobId: job.id, totalWindows: windows.length });
    }

    if (action === "resume") {
      const { data: job, error: jobError } = await supabaseAdmin
        .from("backfill_jobs")
        .select("id,status")
        .eq("user_id", user.id)
        .eq("job_key", JOB_KEY)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) return NextResponse.json({ ok: false, error: "Historical backfill has not been started." }, { status: 404 });
      if (job.status === "completed") return NextResponse.json({ ok: true, status: "completed" });

      const now = new Date().toISOString();
      await supabaseAdmin.from("backfill_jobs").update({
        status: "running",
        last_error: null,
        updated_at: now,
      }).eq("id", job.id);

      await supabaseAdmin.from("backfill_windows").update({
        status: "pending",
        last_error: null,
        updated_at: now,
      }).eq("backfill_job_id", job.id).eq("status", "failed");

      return NextResponse.json({ ok: true, action: "resumed", jobId: job.id });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("backfill_jobs")
      .select("*")
      .eq("user_id", user.id)
      .eq("job_key", JOB_KEY)
      .maybeSingle();
    if (jobError) throw jobError;
    if (!job) return NextResponse.json({ ok: false, error: "Historical backfill has not been started." }, { status: 404 });

    if (job.status === "completed") {
      return NextResponse.json({ ok: true, status: "completed", completedWindows: job.completed_windows, totalWindows: job.total_windows });
    }

    if (job.status === "failed") {
      await supabaseAdmin.from("backfill_jobs").update({ status: "running", last_error: null, updated_at: new Date().toISOString() }).eq("id", job.id);
      await supabaseAdmin.from("backfill_windows").update({ status: "pending", last_error: null, updated_at: new Date().toISOString() }).eq("backfill_job_id", job.id).eq("status", "failed");
    }

    let { data: win, error: winError } = await supabaseAdmin
      .from("backfill_windows")
      .select("*")
      .eq("backfill_job_id", job.id)
      .neq("status", "completed")
      .order("window_start", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (winError) throw winError;

    if (!win) {
      const detailResponse = await invokeSync(request, "shipment_details", {});
      const detailResult = await detailResponse.clone().json().catch(() => ({}));
      if (!detailResponse.ok) throw new Error(detailResult.error ?? "Shipment detail refresh failed.");
      await supabaseAdmin.from("backfill_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", job.id);
      return NextResponse.json({ ok: true, status: "completed", completedWindows: job.completed_windows, totalWindows: job.total_windows, shipmentDetailsRefreshed: true });
    }

    const stage =
      win.orders_status !== "completed" ? "orders" :
      win.shipments_status !== "completed" ? "shipments" :
      "returns";

    await supabaseAdmin.from("backfill_windows").update({
      status: "running",
      updated_at: new Date().toISOString(),
    }).eq("id", win.id);

    try {
      let response: Response | null = null;
      if (stage === "orders") {
        response = await invokeSync(request, "orders", {
          mode: "full",
          dateField: "orderDate",
          orderDateAfter: win.window_start,
          orderDateBefore: win.window_end,
        });
      } else if (stage === "shipments") {
        response = await invokeSync(request, "shipments", {
          mode: "full",
          filterType: "preDispatch",
          modifiedFrom: win.window_start,
          modifiedTo: win.window_end,
        });
        if (response.ok) {
          for (const shipmentType of ["NORMAL", "SELF"]) {
            response = await invokeSync(request, "shipments", {
              mode: "full",
              filterType: "postDispatch",
              shipmentType,
              modifiedFrom: win.window_start,
              modifiedTo: win.window_end,
            });
            if (!response.ok) break;
          }
        }
        if (response.ok) {
          response = await invokeSync(request, "shipments", {
            mode: "full",
            filterType: "cancelled",
            modifiedFrom: win.window_start,
            modifiedTo: win.window_end,
          });
        }
      } else if (stage === "returns") {
        response = await invokeSync(request, "returns", {
          mode: "full",
          dateField: "createdDate",
          createdAfter: win.window_start,
          createdBefore: win.window_end,
        });
      }

      if (!response) throw new Error(`Unsupported backfill stage: ${stage}`);
      const result = await response.clone().json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? `${stage} backfill failed.`);

      if (stage === "orders") {
        await supabaseAdmin.from("backfill_windows").update({ orders_status: "completed", status: "running", updated_at: new Date().toISOString() }).eq("id", win.id);
      } else if (stage === "shipments") {
        await supabaseAdmin.from("backfill_windows").update({ shipments_status: "completed", status: "running", updated_at: new Date().toISOString() }).eq("id", win.id);
      } else if (stage === "returns") {
        await supabaseAdmin.from("backfill_windows").update({ returns_status: "completed", status: "running", updated_at: new Date().toISOString() }).eq("id", win.id);
      } else {
        await supabaseAdmin.from("backfill_windows").update({ returns_status: "completed", status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", win.id);
        await supabaseAdmin.from("backfill_jobs").update({ completed_windows: job.completed_windows + 1, updated_at: new Date().toISOString() }).eq("id", job.id);
      }

      return NextResponse.json({ ok: true, status: "running", stage, windowStart: win.window_start, windowEnd: win.window_end, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backfill stage failed.";
      await supabaseAdmin.from("backfill_windows").update({ status: "failed", last_error: message, updated_at: new Date().toISOString() }).eq("id", win.id);
      await supabaseAdmin.from("backfill_jobs").update({ status: "failed", last_error: message, updated_at: new Date().toISOString() }).eq("id", job.id);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical backfill failed.";
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
