import { NextResponse } from "next/server";
import { flipkartBinaryRequest, flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 60;

type VendorCount = {
  vendorGroupCode?: string;
  isMps?: boolean;
  count?: number;
  pickUpDate?: { after?: string; before?: string };
};

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const locationId = new URL(request.url).searchParams.get("locationId")?.trim();
    if (!locationId) throw new Error("locationId is required.");

    const result = await flipkartRequest<unknown>(
      `/sellers/v3/shipments/handover/counts?locationId=${encodeURIComponent(locationId)}`,
      { method: "GET" },
    );

    await logFlipkartMutation({
      userId,
      method: "GET",
      endpoint: "/sellers/v3/shipments/handover/counts",
      requestMeta: { locationId },
      responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, locationId, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Handover count lookup failed.";
    if (userId) await logFlipkartMutation({
      userId, method: "GET", endpoint: "/sellers/v3/shipments/handover/counts",
      requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message, startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    const locationId = typeof body?.locationId === "string" ? body.locationId.trim() : "";
    if (!locationId) throw new Error("locationId is required.");

    const requestedVendor = typeof body?.vendorGroupCode === "string" ? body.vendorGroupCode.trim() : "";
    const countsResponse = await flipkartRequest<unknown>(
      `/sellers/v3/shipments/handover/counts?locationId=${encodeURIComponent(locationId)}`,
      { method: "GET" },
    );
    const raw = countsResponse.data;
    const counts: VendorCount[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw as VendorCount] : [];
    const usable = counts.filter((x) => typeof x.vendorGroupCode === "string" && x.vendorGroupCode.trim() && Number(x.count ?? 0) > 0);
    if (!usable.length) throw new Error("Flipkart returned no dispatchable shipments for handover.");
    if (!requestedVendor) throw new Error("vendorGroupCode is required. First call GET on this route to see available handover vendors.");
    const selected = usable.find((x) => x.vendorGroupCode === requestedVendor);
    if (!selected) throw new Error("vendorGroupCode is not a current dispatchable vendor for this location.");

    const params = {
      vendorGroupCode: selected.vendorGroupCode,
      locationId,
      isMps: Boolean(selected.isMps),
      ...(selected.isMps
        ? { pickupDate: { after: selected.pickUpDate?.after, before: selected.pickUpDate?.before } }
        : {}),
    };

    const result = await flipkartBinaryRequest("/sellers/v3/shipments/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params }),
    });

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: "/sellers/v3/shipments/manifest",
      requestMeta: { locationId, vendorGroupCode: selected.vendorGroupCode, count: selected.count, isMps: selected.isMps },
      responseMeta: { contentType: result.contentType, contentDisposition: result.contentDisposition, bytes: result.data.byteLength },
      statusCode: result.status,
      startedAt,
    });

    return new NextResponse(result.data, {
      status: result.status,
      headers: {
        "Content-Type": result.contentType ?? "application/pdf",
        "Content-Disposition": result.contentDisposition ?? `attachment; filename="flipkart-manifest.pdf"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Handover manifest generation failed.";
    if (userId) await logFlipkartMutation({
      userId, method: "POST", endpoint: "/sellers/v3/shipments/manifest",
      requestMeta: {}, responseMeta: {}, statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message, startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
