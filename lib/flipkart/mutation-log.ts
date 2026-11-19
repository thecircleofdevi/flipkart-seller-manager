import { supabaseAdmin } from "@/lib/supabase/admin";

export async function logFlipkartMutation(input: {
  userId: string;
  method: string;
  endpoint: string;
  requestMeta?: Record<string, unknown>;
  responseMeta?: Record<string, unknown>;
  statusCode?: number;
  errorMessage?: string | null;
  startedAt: string;
}) {
  const finishedAt = new Date().toISOString();
  await supabaseAdmin.from("api_requests").insert({
    user_id: input.userId,
    method: input.method,
    endpoint: input.endpoint,
    request_meta: input.requestMeta ?? {},
    response_meta: input.responseMeta ?? {},
    status_code: input.statusCode ?? null,
    error_message: input.errorMessage ?? null,
    started_at: input.startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(input.startedAt)),
  });
}
