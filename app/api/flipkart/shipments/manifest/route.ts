import { NextResponse } from "next/server";
import { flipkartBinaryRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 60;

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const vendorGroupCode = requiredString(body?.vendorGroupCode, "vendorGroupCode");
    const isMps = Boolean(body?.isMps);
    const locationId = typeof body?.locationId === "string" && body.locationId.trim() ? body.locationId.trim() : undefined;
    const params = Array.isArray(body?.params) ? body.params : [];
    if (params.length === 0) throw new Error("params is required.");
    if (isMps && (!body?.pickUpDate?.after || !body?.pickUpDate?.before)) {
      throw new Error("pickUpDate.after and pickUpDate.before are required when isMps is true.");
    }

    const payload = {
      params,
      vendorGroupCode,
      ...(locationId ? { locationId } : {}),
      isMps,
      ...(isMps ? { pickUpDate: { after: body.pickUpDate.after, before: body.pickUpDate.before } } : {}),
    };

    const result = await flipkartBinaryRequest("/sellers/v3/shipments/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    await logFlipkartMutation({
      userId, method: "POST", endpoint: "/sellers/v3/shipments/manifest",
      requestMeta: { vendorGroupCode, locationId, isMps, paramCount: params.length },
      responseMeta: { contentType: result.contentType, contentDisposition: result.contentDisposition, bytes: result.data.byteLength },
      statusCode: result.status, startedAt,
    });

    return new NextResponse(result.data, {
      status: result.status,
      headers: {
        "Content-Type": result.contentType ?? "application/pdf",
        ...(result.contentDisposition ? { "Content-Disposition": result.contentDisposition } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Manifest generation failed.";
    if (userId) await logFlipkartMutation({
      userId, method: "POST", endpoint: "/sellers/v3/shipments/manifest",
      requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message, startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
