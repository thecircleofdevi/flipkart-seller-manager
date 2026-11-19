import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner, parseStringList } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 60;

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const shipmentIds = parseStringList(new URL(request.url).searchParams.get("shipmentIds")?.split(",") ?? [], "shipmentIds", 100);
    const result = await flipkartRequest<unknown>(`/sellers/v3/shipments/${encodeURIComponent(shipmentIds.join(","))}/forms`, { method: "GET" });
    await logFlipkartMutation({
      userId, method: "GET", endpoint: "/sellers/v3/shipments/{shipmentIds}/forms",
      requestMeta: { shipmentIds }, responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status, startedAt,
    });
    return NextResponse.json({ ok: true, shipmentIds, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment forms lookup failed.";
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    if (!Array.isArray(body?.shipments) || body.shipments.length < 1 || body.shipments.length > 100) {
      throw new Error("shipments must contain 1 to 100 items.");
    }
    const shipments = body.shipments.map((shipment: any, index: number) => {
      const shipmentId = requiredString(shipment?.shipmentId, `shipments[${index}].shipmentId`);
      if (!Array.isArray(shipment?.forms) || shipment.forms.length < 1) throw new Error(`shipments[${index}].forms is required.`);
      const forms = shipment.forms.map((form: any, formIndex: number) => ({
        name: requiredString(form?.name, `shipments[${index}].forms[${formIndex}].name`),
        ackNumber: requiredString(form?.ackNumber, `shipments[${index}].forms[${formIndex}].ackNumber`),
      }));
      return { shipmentId, forms };
    });

    const result = await flipkartRequest<{ shipments?: Array<{ shipmentId?: string; processingStatus?: string; errorCode?: string; errorMessage?: string }> }>("/sellers/v3/shipments/forms/updateAck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipments }),
    });
    const rows = result.data.shipments ?? [];
    await logFlipkartMutation({
      userId, method: "POST", endpoint: "/sellers/v3/shipments/forms/updateAck",
      requestMeta: { shipmentIds: shipments.map((s: any) => s.shipmentId) },
      responseMeta: { results: rows }, statusCode: result.status, startedAt,
    });
    return NextResponse.json({ ok: true, results: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shipment form ACK update failed.";
    if (userId) await logFlipkartMutation({
      userId, method: "POST", endpoint: "/sellers/v3/shipments/forms/updateAck",
      requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message, startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
