import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SyncAlreadyRunningError, claimSyncRun } from "@/lib/sync-lock";

export const runtime = "nodejs";
export const maxDuration = 300;

type ShipmentDetail = {
  shipmentId?: string;
  locationId?: string;
  deliveryAddress?: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
  sellerAddress?: Record<string, unknown>;
  buyerDetails?: Record<string, unknown>;
  forms?: unknown[];
  subShipments?: Array<{
    subShipmentId?: string;
    packages?: unknown[];
    courierDetails?: {
      pickupDetails?: { vendorName?: string; trackingId?: string };
      deliveryDetails?: { vendorName?: string; trackingId?: string };
    };
  }>;
};

type ShipmentDetailResponse = ShipmentDetail | ShipmentDetail[];

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

async function requestWithRetry<T>(path: string, attempts = 4) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await flipkartRequest<T>(path, { method: "GET" });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /Flipkart API (500|502|503|504)/.test(message);
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw lastError;
}

function asArray(payload: ShipmentDetailResponse): ShipmentDetail[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "shipmentId" in payload) return [payload];
  return [];
}

function normalizePath(nextUrl: string) {
  const url = new URL(nextUrl, "https://api.flipkart.net");
  if (url.hostname !== "api.flipkart.net") throw new Error("Unexpected Flipkart host.");
  const path = url.pathname.startsWith("/sellers/") ? url.pathname : `/sellers${url.pathname}`;
  return path + url.search;
}

function firstTrackingId(shipment: ShipmentDetail) {
  for (const sub of shipment.subShipments ?? []) {
    const pickup = sub.courierDetails?.pickupDetails?.trackingId;
    const delivery = sub.courierDetails?.deliveryDetails?.trackingId;
    if (delivery) return delivery;
    if (pickup) return pickup;
  }
  return null;
}

function firstCourierName(shipment: ShipmentDetail) {
  for (const sub of shipment.subShipments ?? []) {
    const pickup = sub.courierDetails?.pickupDetails?.vendorName;
    const delivery = sub.courierDetails?.deliveryDetails?.vendorName;
    if (delivery) return delivery;
    if (pickup) return pickup;
  }
  return null;
}

export async function POST(request: Request) {
  let runId: string | null = null;
  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");

    runId = await claimSyncRun(userId, "shipment_details", "shipment_details");

    const { data: rows, error: shipmentError } = await supabaseAdmin
      .from("shipments")
      .select("id,flipkart_shipment_id")
      .eq("user_id", userId)
      .not("flipkart_shipment_id", "is", null);

    if (shipmentError) throw shipmentError;

    const shipments = rows ?? [];
    let updated = 0;

    for (let i = 0; i < shipments.length; i += 25) {
      const batch = shipments.slice(i, i + 25);
      const ids = batch.map((row) => row.flipkart_shipment_id).join(",");
      const result = await requestWithRetry<ShipmentDetailResponse>(
        `/sellers/v3/shipments/${encodeURIComponent(ids)}`,
      );

      const details = asArray(result.data);
      for (const detail of details) {
        if (!detail.shipmentId) continue;
        const local = batch.find((row) => row.flipkart_shipment_id === detail.shipmentId);
        if (!local) continue;

        const trackingId = firstTrackingId(detail);
        const courierName = firstCourierName(detail);
        const addressData = {
          deliveryAddress: detail.deliveryAddress ?? null,
          billingAddress: detail.billingAddress ?? null,
          sellerAddress: detail.sellerAddress ?? null,
        };

        const { error } = await supabaseAdmin
          .from("shipments")
          .update({
            tracking_id: trackingId,
            courier_name: courierName,
            address_data: addressData,
            buyer_data: detail.buyerDetails ?? {},
            forms_data: detail.forms ?? [],
            packages_data: (detail.subShipments ?? []).flatMap((sub) => sub.packages ?? []),
            raw: detail,
          })
          .eq("id", local.id)
          .eq("user_id", userId);

        if (error) throw error;

        const { error: rawError } = await supabaseAdmin.from("raw_flipkart_payloads").upsert({
          user_id: userId,
          sync_run_id: runId,
          source_type: "shipment_details",
          external_id: detail.shipmentId,
          payload: detail,
        }, { onConflict: "user_id,source_type,external_id,payload_hash" });
        if (rawError) throw rawError;

        updated++;
      }
    }

    const { error: finishError } = await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "success",
        finished_at: new Date().toISOString(),
        records_seen: shipments.length,
        records_written: updated,
      })
      .eq("id", runId);
    if (finishError) throw finishError;

    return NextResponse.json({ ok: true, shipmentsSeen: shipments.length, shipmentsUpdated: updated });
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
    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Unauthorized sync request." ? 401 : 500 },
    );
  }
}
