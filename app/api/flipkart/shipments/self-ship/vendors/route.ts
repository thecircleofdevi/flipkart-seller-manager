import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const locationId = new URL(request.url).searchParams.get("locationId")?.trim();
    if (!locationId) throw new Error("locationId is required.");

    const result = await flipkartRequest<unknown>(
      `/sellers/v3/shipments/selfShip/vendors?locationId=${encodeURIComponent(locationId)}`,
      { method: "GET" },
    );

    await logFlipkartMutation({
      userId,
      method: "GET",
      endpoint: "/sellers/v3/shipments/selfShip/vendors",
      requestMeta: { locationId },
      responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, locationId, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Self-ship vendor lookup failed.";
    if (userId) await logFlipkartMutation({
      userId,
      method: "GET",
      endpoint: "/sellers/v3/shipments/selfShip/vendors",
      requestMeta: {},
      responseMeta: {},
      statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message,
      startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
