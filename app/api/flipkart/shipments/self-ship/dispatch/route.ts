import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

type Result = {
  shipmentId?: string;
  processingStatus?: string;
  errorCode?: string;
  errorMessage?: string;
};

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = optionalString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function addressValue(address: Record<string, unknown>, ...keys: string[]) {
  return pickString(address, ...keys);
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";

  try {
    userId = await requireFlipkartOwner();
    const body = record(await request.json());
    const shipmentIds = parseStringList(body.shipmentIds, "shipmentIds", 100);
    const deliveryPartnerCode = requiredString(body.deliveryPartnerCode, "deliveryPartnerCode");
    const deliveryPartner = optionalString(body.deliveryPartner);
    const tentativeDeliveryDate = requiredString(body.tentativeDeliveryDate, "tentativeDeliveryDate");
    const dispatchDate = requiredString(body.dispatchDate, "dispatchDate");
    const invoiceDate = requiredString(body.invoiceDate, "invoiceDate");
    const invoiceNumber = optionalString(body.invoiceNumber);
    const trackingId = optionalString(body.trackingId);

    const { data: shipments, error: shipmentError } = await supabaseAdmin
      .from("shipments")
      .select("id,flipkart_shipment_id,location_id,shipment_type,state")
      .eq("user_id", userId)
      .in("flipkart_shipment_id", shipmentIds);

    if (shipmentError) throw shipmentError;
    if ((shipments ?? []).length !== shipmentIds.length) {
      throw new Error("One or more shipment IDs are not present in the seller account.");
    }
    if ((shipments ?? []).some((shipment) => String(shipment.shipment_type ?? "").toUpperCase() !== "SELF")) {
      throw new Error("Self-ship dispatch can only be used for SELF shipments.");
    }
    const dispatchableStates = new Set(["APPROVED", "PACKED", "PACKING_IN_PROGRESS"]);
    if ((shipments ?? []).some((shipment) => !dispatchableStates.has(String(shipment.state ?? "").toUpperCase()))) throw new Error("Self-ship dispatch is only allowed for APPROVED, PACKED, or PACKING_IN_PROGRESS shipments.");

    const locationDbIds = [...new Set((shipments ?? []).map((shipment) => shipment.location_id).filter(Boolean))] as string[];
    const requestedLocationId = optionalString(body.locationId);
    let locationId = requestedLocationId;

    if (!locationId && locationDbIds.length === 1) {
      const { data: location, error } = await supabaseAdmin
        .from("locations")
        .select("id,flipkart_location_id,address")
        .eq("user_id", userId)
        .eq("id", locationDbIds[0])
        .maybeSingle();
      if (error) throw error;
      locationId = location?.flipkart_location_id ?? undefined;
    }

    if (!locationId) {
      throw new Error("locationId is required when shipments span multiple or unknown dispatch locations.");
    }

    const { data: locationRows, error: locationError } = await supabaseAdmin
      .from("locations")
      .select("id,flipkart_location_id,address")
      .eq("user_id", userId)
      .in("flipkart_location_id", [locationId]);

    if (locationError) throw locationError;
    const location = locationRows?.[0];
    if (!location) throw new Error("The dispatch location does not belong to the seller account.");

    const address = record(location.address);
    const address1 = addressValue(address, "address1", "addressLine1", "line1", "street");
    const city = addressValue(address, "city", "cityName");
    if (!address1 || !city) {
      throw new Error("The selected dispatch location is missing address1 or city. Update the seller location data before dispatching.");
    }

    const { data: shipmentItemRows, error: shipmentItemsError } = await supabaseAdmin
      .from("shipment_items")
      .select("shipment_id,order_item_id,quantity,raw")
      .eq("user_id", userId)
      .in("shipment_id", (shipments ?? []).map((shipment) => shipment.id));

    if (shipmentItemsError) throw shipmentItemsError;

    const orderItemIds = [...new Set((shipmentItemRows ?? []).map((item) => item.order_item_id).filter(Boolean))] as string[];
    if (!orderItemIds.length) throw new Error("No order items are linked to the selected shipments.");

    const { data: orderItems, error: orderItemsError } = await supabaseAdmin
      .from("order_items")
      .select("id,flipkart_order_item_id,quantity,raw")
      .eq("user_id", userId)
      .in("id", orderItemIds);

    if (orderItemsError) throw orderItemsError;

    const orderItemById = new Map((orderItems ?? []).map((item) => [item.id, item]));
    const serialNumbersByOrderItemId = record(body.serialNumbers);

    const payloadShipments = (shipments ?? []).map((shipment) => {
      const items = (shipmentItemRows ?? [])
        .filter((item) => item.shipment_id === shipment.id)
        .map((item) => {
          const orderItem = item.order_item_id ? orderItemById.get(item.order_item_id) : undefined;
          if (!orderItem) throw new Error(`Order item data is missing for shipment ${shipment.flipkart_shipment_id}.`);
          const quantity = Number(item.quantity ?? orderItem.quantity ?? 0);
          if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid invoice quantity for shipment ${shipment.flipkart_shipment_id}.`);
          const serials = Array.isArray(serialNumbersByOrderItemId[orderItem.flipkart_order_item_id])
            ? serialNumbersByOrderItemId[orderItem.flipkart_order_item_id]
            : undefined;
          return {
            orderItemId: orderItem.flipkart_order_item_id,
            quantity,
            ...(serials ? { serialNumbers: serials } : {}),
          };
        });

      if (!items.length) throw new Error(`No invoice items are linked to shipment ${shipment.flipkart_shipment_id}.`);

      return {
        shipmentId: shipment.flipkart_shipment_id,
        tentativeDeliveryDate,
        dispatchDate,
        deliveryPartnerCode,
        ...(deliveryPartner ? { deliveryPartner } : {}),
        ...(trackingId ? { trackingId } : {}),
        ...(locationId ? { locationId } : {}),
        invoice: {
          ...(invoiceNumber ? { invoiceNumber } : {}),
          items,
          invoiceDate,
        },
        dispatchLocation: {
          locationId,
          address: {
            address1,
            ...(addressValue(address, "address2", "addressLine2", "line2") ? { address2: addressValue(address, "address2", "addressLine2", "line2") } : {}),
            ...(addressValue(address, "landmark") ? { landmark: addressValue(address, "landmark") } : {}),
            city,
            ...(addressValue(address, "state", "stateName") ? { state: addressValue(address, "state", "stateName") } : {}),
            ...(addressValue(address, "pincode", "postalCode", "zip") ? { pincode: addressValue(address, "pincode", "postalCode", "zip") } : {}),
          },
        },
      };
    });

    const result = await flipkartRequest<{ shipments?: Result[] }>("/sellers/v3/shipments/selfShip/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipments: payloadShipments }),
    });

    const rows = result.data.shipments ?? [];
    const succeeded = rows
      .filter((row) => String(row.processingStatus ?? "").toUpperCase() === "SUCCESS")
      .map((row) => row.shipmentId)
      .filter((id): id is string => Boolean(id));

    if (succeeded.length) {
      await supabaseAdmin
        .from("shipments")
        .update({
          state: "SHIPPED",
          tracking_id: trackingId ?? undefined,
          courier_name: deliveryPartner ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .in("flipkart_shipment_id", succeeded);
    }

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: "/sellers/v3/shipments/selfShip/dispatch",
      requestMeta: { shipmentIds, locationId, deliveryPartnerCode, deliveryPartner, hasTrackingId: Boolean(trackingId), hasInvoiceNumber: Boolean(invoiceNumber) },
      responseMeta: { succeeded, results: rows },
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, succeeded, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Self-ship dispatch failed.";
    if (userId) {
      await logFlipkartMutation({
        userId,
        method: "POST",
        endpoint: "/sellers/v3/shipments/selfShip/dispatch",
        requestMeta: {},
        responseMeta: {},
        statusCode: message === "Unauthorized." ? 401 : 502,
        errorMessage: message,
        startedAt,
      });
    }
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
