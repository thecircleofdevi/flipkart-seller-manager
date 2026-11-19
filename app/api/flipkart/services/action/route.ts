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

    const serviceFulfilmentIds = parseStringList(body?.serviceFulfilmentIds, "serviceFulfilmentIds", 100);
    const deliveryDate = required(body?.deliveryDate, "deliveryDate");
    if (!datePattern.test(deliveryDate)) throw new Error("deliveryDate must use yyyy-MM-dd format.");

    const services = serviceFulfilmentIds.map((service: string) => {
      const row: Record<string, unknown> = {
        deliveryDate,
        service,
      };
      if (action === "attempt") {
        const newDeliveryDate = required(body?.newDeliveryDate, "newDeliveryDate");
        if (!datePattern.test(newDeliveryDate)) throw new Error("newDeliveryDate must use yyyy-MM-dd format.");
        row.newDeliveryDate = newDeliveryDate;
        row.reason = required(body?.reason, "reason");
        row.subReason = required(body?.subReason, "subReason");
        if (body?.comments) row.comments = String(body.comments);
      }
      return row;
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
      requestMeta: { action, serviceFulfilmentIds },
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
