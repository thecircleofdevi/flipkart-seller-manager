import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { POST as runShipmentSync } from "@/app/api/flipkart/sync/route";
import { POST as runListingSync } from "@/app/api/flipkart/sync/listings/route";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const type = body?.type;

  if (type !== "shipments" && type !== "listings") {
    return NextResponse.json(
      { ok: false, error: "Invalid sync type" },
      { status: 400 },
    );
  }

  const secret = process.env.FLIPKART_SYNC_SECRET;

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "Sync configuration is missing" },
      { status: 500 },
    );
  }

  // Do not make a server-to-server HTTP request back into the Vercel
  // deployment. Deployment Protection can intercept that request before it
  // reaches the sync route. Invoke the authenticated route handler directly
  // instead, passing the same internal sync secret it expects.
  const internalRequest = new Request(request.url, {
    method: "POST",
    headers: {
      "x-flipkart-sync-secret": secret,
      "Content-Type": "application/json",
    },
  });

  const response =
    type === "listings"
      ? await runListingSync(internalRequest)
      : await runShipmentSync(internalRequest);

  const result = await response
    .clone()
    .json()
    .catch(() => ({ ok: false, error: "Sync returned invalid JSON" }));

  return NextResponse.json(result, { status: response.status });
}
