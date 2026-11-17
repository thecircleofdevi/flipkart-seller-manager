import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";

export const runtime = "nodejs";

type ShipmentSearchResponse = {
  shipments?: unknown[];
  hasMore?: boolean;
  nextPageUrl?: string | null;
};

export async function GET() {
  try {
    const { data, status } = await flipkartRequest<ShipmentSearchResponse>(
      "/sellers/v3/shipments/filter/",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: {
            type: "preDispatch",
            states: [
              "APPROVED",
              "PACKING_IN_PROGRESS",
              "PACKED",
              "FORM_FAILED",
              "READY_TO_DISPATCH",
            ],
          },
          pagination: { pageSize: 20 },
          sort: { field: "orderDate", order: "desc" },
        }),
      }
    );

    return NextResponse.json({
      ok: true,
      status,
      shipmentCount: Array.isArray(data.shipments) ? data.shipments.length : 0,
      hasMore: data.hasMore ?? false,
      nextPageUrlPresent: Boolean(data.nextPageUrl),
      shipments: data.shipments ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Flipkart API error.",
      },
      { status: 502 }
    );
  }
}
