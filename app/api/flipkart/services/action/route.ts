import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 60;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function required(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  let action = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    action = required(body?.action, "action");
    if (action !== "attempt" && action !== "complete") throw new Error("action must be attempt or complete.");

    const servicesInput = Array.isArray(body?.services) ? body.services : [];
    if (servicesInput.length < 1 || servicesInput.length > 100) {
      throw new Error("services must contain between 1 and 100 service records.");
    }

    const services = servicesInput.map((item: unknown, index: number) => {
      if (!item || typeof item !== "object") throw new Error(`services[${index}] must be an object.`);
      const row = item as Record<string, unknown>;
      const serviceFulfilmentId = required(row.serviceFulfilmentId ?? row.service, `services[${index}].serviceFulfilmentId`);
      const locationId = required(row.locationId, `services[${index}].locationId`);
      const deliveryDate = required(row.deliveryDate ?? body?.deliveryDate, `services[${index}].deliveryDate`);
      if (!datePattern.test(deliveryDate)) throw new Error(`services[${index}].deliveryDate must use yyyy-MM-dd format.`);

      const service: Record<string, unknown> = { serviceFulfilmentId, locationId, deliveryDate };
      if (action === "attempt") {
        const newDeliveryDate = required(row.newDeliveryDate ?? body?.newDeliveryDate, "newDeliveryDate");
        if (!datePattern.test(newDeliveryDate)) throw new Error("newDeliveryDate must use yyyy-MM-dd format.");
        service.newDeliveryDate = newDeliveryDate;
        service.reason = required(row.reason ?? body?.reason, "reason");
        service.subReason = required(row.subReason ?? body?.subReason, "subReason");
        if (row.comments ?? body?.comments) service.comments = String(row.comments ?? body.comments);
      }
      return service;
    });

    const endpoint = action === "attempt" ? "/sellers/v2/services/attempt" : "/sellers/v2/services/complete";
    const result = await flipkartRequest<unknown>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services }),
    });

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint,
      requestMeta: { action, serviceCount: services.length },
      responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, action, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Service fulfilment action failed.";
    if (userId) await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: action === "attempt" ? "/sellers/v2/services/attempt" : "/sellers/v2/services/complete",
      requestMeta: { action },
      responseMeta: {},
      statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message,
      startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
