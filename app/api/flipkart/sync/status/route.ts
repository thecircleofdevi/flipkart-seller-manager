import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const requestedType = new URL(request.url).searchParams.get("type");
    const type = ["shipments", "shipment_details", "orders", "returns", "listings", "product_search"].includes(requestedType ?? "")
      ? requestedType!
      : "shipments";
  const { data: latest } = await supabaseAdmin
    .from("sync_runs")
    .select("id,status,started_at,finished_at,records_written,error_message")
    .eq("user_id", user.id)
    .eq("sync_type", type)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latest) return NextResponse.json({ ok: true, running: false, status: "idle", estimatedTotalSeconds: 180 });

  if (
    latest.status === "running" &&
    new Date(latest.started_at).getTime() < Date.now() - 10 * 60 * 1000
  ) {
    const staleMessage = "Sync run exceeded the execution window and was marked stale.";
    await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: staleMessage,
      })
      .eq("id", latest.id)
      .eq("user_id", user.id);

    return NextResponse.json({
      ok: true,
      running: false,
      status: "failed",
      elapsedSeconds: Math.floor((Date.now() - new Date(latest.started_at).getTime()) / 1000),
      estimatedTotalSeconds: 180,
      recordsWritten: latest.records_written ?? 0,
      errorMessage: staleMessage,
    }, { headers: { "Cache-Control": "no-store" } });
  }

  const { data: history } = await supabaseAdmin
    .from("sync_runs")
    .select("started_at,finished_at")
    .eq("user_id", user.id)
    .eq("sync_type", type)
    .eq("status", "success")
    .not("finished_at", "is", null)
    .order("started_at", { ascending: false })
    .limit(5);

  const durations = (history ?? []).map((row) => {
    const start = new Date(row.started_at).getTime();
    const end = new Date(row.finished_at!).getTime();
    return Math.max(1, Math.round((end - start) / 1000));
  }).filter((value) => Number.isFinite(value));

  const estimatedTotalSeconds = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 180;

  const running = latest.status === "running";
  const endTime = latest.finished_at ? new Date(latest.finished_at).getTime() : Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((endTime - new Date(latest.started_at).getTime()) / 1000));

  return NextResponse.json({
    ok: true,
    running,
    status: latest.status,
    elapsedSeconds,
    estimatedTotalSeconds,
    recordsWritten: latest.records_written ?? 0,
    errorMessage: latest.error_message,
  }, { headers: { "Cache-Control": "no-store" } });
}
