import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

const ACTIONS = {
  approve: { path: "/sellers/v2/returns/approve", status: "APPROVED" },
  reject: { path: "/sellers/v2/returns/reject", status: "REJECTED" },
  pickup: { path: "/sellers/v2/returns/pickup", status: "PICKED_UP" },
  pickupAttempt: { path: "/sellers/v2/returns/pickupAttempt", status: "PICKUP_ATTEMPTED" },
  complete: { path: "/sellers/v2/returns/complete", status: "COMPLETED" },
} as const;

type Action = keyof typeof ACTIONS;

export const runtime = "nodejs";
export const maxDuration = 60;

function string(value: unknown, field: string, required = true) {
  const result = typeof value === "string" ? value.trim() : "";
  if (required && !result) throw new Error(`${field} is required.`);
  return result;
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  let action: Action | null = null;

  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    action = string(body?.action, "action") as Action;
    if (!(action in ACTIONS)) throw new Error("Unsupported return action.");

    const returnIds = parseStringList(body?.returnIds, "returnIds", 100);
    const { data: returns, error } = await supabaseAdmin
      .from("returns")
      .select("id,flipkart_return_id,location_id,raw")
      .eq("user_id", userId)
      .in("flipkart_return_id", returnIds);

    if (error) throw error;
    if ((returns ?? []).length !== returnIds.length) throw new Error("One or more return IDs are not present in the seller account.");

    const locationIds = [...new Set((returns ?? []).map((row) => {
      const raw = row.raw && typeof row.raw === "object" ? row.raw as Record<string, unknown> : {};
      return typeof raw.locationId === "string" ? raw.locationId : null;
    }).filter(Boolean))] as string[];

    const requestedLocationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";
    const locationId = requestedLocationId || (locationIds.length === 1 ? locationIds[0] : "");
    if (!locationId) throw new Error("locationId is required when the selected returns span multiple or unknown locations.");

    const requested = body?.returns;
    const requestedById = new Map<string, Record<string, unknown>>();
    if (Array.isArray(requested)) {
      for (const item of requested) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).returnId === "string") {
          requestedById.set((item as Record<string, unknown>).returnId as string, item as Record<string, unknown>);
        }
      }
    }

    const payloadRows = returnIds.map((returnId) => {
      const supplied = requestedById.get(returnId) ?? {};
      const row: Record<string, unknown> = { returnId, locationId };

      if (action === "approve" || action === "reject") {
        row.comments = string(supplied.comments ?? body?.comments, "comments");
        row.service = string(supplied.service ?? body?.service, "service");
        const serviceDate = supplied.serviceDate ?? body?.serviceDate;
        if (action === "reject") row.serviceDate = string(serviceDate, "serviceDate");
        else if (serviceDate) row.serviceDate = string(serviceDate, "serviceDate", false);
      }

      if (action === "pickup" || action === "pickupAttempt") {
        row.pickupDate = string(supplied.pickupDate ?? body?.pickupDate, "pickupDate");
      }

      if (action === "pickupAttempt") {
        row.reason = string(supplied.reason ?? body?.reason, "reason");
        row.newPickupDate = string(supplied.newPickupDate ?? body?.newPickupDate, "newPickupDate");
        const subReason = supplied.subReason ?? body?.subReason;
        if (subReason) row.subReason = String(subReason);
      }

      return row;
    });

    const payload = action === "complete"
      ? { returnIds, locationId }
      : { returns: payloadRows };

    const result = await flipkartRequest<{
      returns?: Array<{ returnId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }>;
    }>(ACTIONS[action].path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const rows = result.data.returns ?? [];
    const succeeded = rows
      .filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS")
      .map((row) => row.returnId)
      .filter((id): id is string => Boolean(id));

    if (succeeded.length) {
      await supabaseAdmin
        .from("returns")
        .update({ status: ACTIONS[action].status, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .in("flipkart_return_id", succeeded);
    }

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: ACTIONS[action].path,
      requestMeta: { action, returnIds },
      responseMeta: { succeeded, results: rows },
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, action, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Return action failed.";
    if (userId) await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: action ? ACTIONS[action].path : "/sellers/v2/returns/*",
      requestMeta: { action },
      responseMeta: {},
      statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message,
      startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
