import { supabaseAdmin } from "@/lib/supabase/admin";

const STALE_AFTER_MS = 10 * 60 * 1000;

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly syncRunId: string) {
    super("A sync of this type is already running.");
    this.name = "SyncAlreadyRunningError";
  }
}

export async function claimSyncRun(
  userId: string,
  syncType: string,
  runKey: string,
  metadata: Record<string, unknown> = {},
) {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();

  await supabaseAdmin
    .from("sync_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: "Sync run expired after exceeding the 10-minute execution window.",
    })
    .eq("user_id", userId)
    .eq("sync_type", syncType)
    .eq("run_key", runKey)
    .eq("status", "running")
    .lt("started_at", staleBefore);

  const { data, error } = await supabaseAdmin
    .from("sync_runs")
    .insert({
      user_id: userId,
      sync_type: syncType,
      run_key: runKey,
      status: "running",
      metadata,
    })
    .select("id")
    .single();

  if (!error) return data.id;

  if (error.code === "23505") {
    const { data: existing } = await supabaseAdmin
      .from("sync_runs")
      .select("id")
      .eq("user_id", userId)
      .eq("sync_type", syncType)
      .eq("run_key", runKey)
      .eq("status", "running")
      .maybeSingle();

    if (existing?.id) throw new SyncAlreadyRunningError(existing.id);
  }

  throw error;
}
