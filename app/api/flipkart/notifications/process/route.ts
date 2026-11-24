import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function assertAuthorized(request: Request) {
  if (request.headers.get("x-flipkart-sync-secret") !== requiredEnv("FLIPKART_SYNC_SECRET")) {
    throw new Error("Unauthorized processing request.");
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeShipmentState(eventType: string, attributes: Record<string, unknown>) {
  const explicitStatus = stringValue(attributes.status);
  if (explicitStatus) return explicitStatus;

  const map: Record<string, string> = {
    shipment_created: "APPROVED",
    shipment_packed: "PACKED",
    packed: "PACKED",
    shipment_ready_to_dispatch: "READY_TO_DISPATCH",
    ready_to_dispatch: "READY_TO_DISPATCH",
    shipment_pickup_complete: "PICKUP_COMPLETE",
    pickup_complete: "PICKUP_COMPLETE",
    shipment_shipped: "SHIPPED",
    shipped: "SHIPPED",
    shipment_delivered: "DELIVERED",
    delivered: "DELIVERED",
    shipment_cancelled: "CANCELLED",
  };

  return map[eventType] ?? null;
}

function normalizeReturnStatus(eventType: string, attributes: Record<string, unknown>) {
  const explicitStatus = stringValue(attributes.status);
  if (explicitStatus) return explicitStatus;

  const map: Record<string, string> = {
    return_created: "CREATED",
    return_completed: "COMPLETED",
    return_cancelled: "CANCELLED",
    return_picked_up: "PICKED_UP",
  };

  return map[eventType] ?? null;
}

export async function POST(request: Request) {
  try {
    assertAuthorized(request);
    const userId = requiredEnv("FLIPKART_OWNER_USER_ID");

    const [receivedResult, retryResult] = await Promise.all([
      supabaseAdmin
        .from("notifications")
        .select("id,event_type,shipment_id,location_id,event_timestamp,payload")
        .eq("user_id", userId)
        .eq("processing_status", "received")
        .order("received_at", { ascending: true })
        .limit(100),
      supabaseAdmin
        .from("notifications")
        .select("id,event_type,shipment_id,location_id,event_timestamp,payload")
        .eq("user_id", userId)
        .eq("processing_status", "failed")
        .ilike("processing_error", "Referenced shipment or return is not present locally yet%")
        .order("received_at", { ascending: true })
        .limit(100),
    ]);

    if (receivedResult.error) throw receivedResult.error;
    if (retryResult.error) throw retryResult.error;

    const notifications = [...(receivedResult.data ?? []), ...(retryResult.data ?? [])];

    let processed = 0;
    let failed = 0;

    for (const notification of notifications ?? []) {
      try {
        const payload = (notification.payload ?? {}) as Record<string, unknown>;
        const attributes =
          payload.attributes && typeof payload.attributes === "object"
            ? (payload.attributes as Record<string, unknown>)
            : {};

        const shipmentFlipkartId =
          notification.shipment_id ??
          stringValue(payload.shipmentId) ??
          stringValue(attributes.shipmentId);
        let entityMatched = false;

        if (shipmentFlipkartId) {
          const { data: shipment } = await supabaseAdmin
            .from("shipments")
            .select("id,state")
            .eq("user_id", userId)
            .eq("flipkart_shipment_id", shipmentFlipkartId)
            .maybeSingle();

          if (shipment) {
            entityMatched = true;
            const nextState =
              normalizeShipmentState(notification.event_type, attributes) ??
              stringValue(payload.status);

            if (!nextState) {
              throw new Error(`Unmapped shipment notification event: ${notification.event_type}`);
            }

            const { error: shipmentError } = await supabaseAdmin
              .from("shipments")
              .update({
                state: nextState,
                updated_at: new Date().toISOString(),
              })
              .eq("id", shipment.id)
              .eq("user_id", userId);

            if (shipmentError) throw shipmentError;

            const eventId =
              stringValue(payload.eventId) ??
              stringValue(payload.event_id) ??
              notification.id;

            const { error: eventError } = await supabaseAdmin
              .from("shipment_events")
              .upsert(
                {
                  user_id: userId,
                  shipment_id: shipment.id,
                  flipkart_event_id: eventId,
                  event_type: notification.event_type,
                  event_timestamp:
                    notification.event_timestamp ?? new Date().toISOString(),
                  source: "notification",
                  payload,
                },
                { onConflict: "user_id,flipkart_event_id" },
              );

            if (eventError) throw eventError;
          }
        }

        const returnFlipkartId =
          stringValue(payload.returnId) ??
          stringValue(payload.return_id) ??
          stringValue(attributes.returnId) ??
          stringValue(attributes.return_id);

        if (returnFlipkartId) {
          const { data: returnRow } = await supabaseAdmin
            .from("returns")
            .select("id,status")
            .eq("user_id", userId)
            .eq("flipkart_return_id", returnFlipkartId)
            .maybeSingle();

          if (returnRow) {
            entityMatched = true;
            const nextStatus =
              normalizeReturnStatus(notification.event_type, attributes) ??
              stringValue(payload.status);

            if (!nextStatus) {
              throw new Error(`Unmapped return notification event: ${notification.event_type}`);
            }

            const { error: returnError } = await supabaseAdmin
              .from("returns")
              .update({
                status: nextStatus,
                raw: payload,
                updated_at: new Date().toISOString(),
              })
              .eq("id", returnRow.id)
              .eq("user_id", userId);

            if (returnError) throw returnError;

            if (returnRow.status !== nextStatus) {
              const { error: eventError } = await supabaseAdmin
                .from("return_events")
                .insert({
                  user_id: userId,
                  return_id: returnRow.id,
                  event_type: notification.event_type,
                  event_timestamp:
                    notification.event_timestamp ?? new Date().toISOString(),
                  payload,
                });

              if (eventError) throw eventError;
            }
          }
        }

        const hasReferencedEntity = Boolean(shipmentFlipkartId || returnFlipkartId);
        if (hasReferencedEntity && !entityMatched) {
          throw new Error(
            "Referenced shipment or return is not present locally yet; notification will be retried after synchronization.",
          );
        }

        const { error: markError } = await supabaseAdmin
          .from("notifications")
          .update({
            processing_status: "processed",
            processing_error: null,
          })
          .eq("id", notification.id)
          .eq("user_id", userId);

        if (markError) throw markError;
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown processing error";

        await supabaseAdmin
          .from("notifications")
          .update({
            processing_status: "failed",
            processing_error: message,
          })
          .eq("id", notification.id)
          .eq("user_id", userId);

        failed++;
      }
    }

    return NextResponse.json({
      ok: true,
      received: notifications?.length ?? 0,
      processed,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";

    return NextResponse.json(
      { ok: false, error: message },
      { status: message === "Unauthorized processing request." ? 401 : 500 },
    );
  }
}
