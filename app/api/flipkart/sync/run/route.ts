import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const type = body?.type;
  if (type !== "shipments" && type !== "listings") return NextResponse.json({ ok: false, error: "Invalid sync type" }, { status: 400 });
  const secret = process.env.FLIPKART_SYNC_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "Sync configuration is missing" }, { status: 500 });
  const origin = new URL(request.url).origin;
  const target = type === "listings" ? "/api/flipkart/sync/listings" : "/api/flipkart/sync";
  const response = await fetch(origin + target, { method: "POST", headers: { "x-flipkart-sync-secret": secret, "Content-Type": "application/json" }, cache: "no-store" });
  const result = await response.json().catch(() => ({ ok: false, error: "Sync returned invalid JSON" }));
  return NextResponse.json(result, { status: response.status });
}
