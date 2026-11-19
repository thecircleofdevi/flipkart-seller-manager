import { NextResponse } from "next/server";
import { flipkartRequest } from "@/lib/flipkart/client";
import { requireFlipkartOwner } from "@/lib/flipkart/authorize";
import { logFlipkartMutation } from "@/lib/flipkart/mutation-log";

export const runtime = "nodejs";
export const maxDuration = 60;

const ACTION_PATHS = {
  initialLoad: "/sellers/v3/returns/tasks/initial-load",
  start: "/sellers/v3/returns/otc/start/details",
  shipments: "/sellers/v3/returns/tasks/shipments",
  end: "/sellers/v3/returns/otc/end/details",
} as const;

type Action = keyof typeof ACTION_PATHS;

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function actionOf(value: unknown): Action {
  const action = requiredString(value, "action");
  if (!(action in ACTION_PATHS)) throw new Error("Unsupported return OTC action.");
  return action as Action;
}

export async function GET(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  try {
    userId = await requireFlipkartOwner();
    const url = new URL(request.url);
    const nextUrl = url.searchParams.get("nextUrl")?.trim();
    if (!nextUrl || !nextUrl.startsWith("/sellers/v3/returns/tasks/shipments/")) {
      throw new Error("nextUrl must be a Flipkart return shipment pagination path returned by the API.");
    }

    const result = await flipkartRequest<unknown>(nextUrl, { method: "GET" });

    await logFlipkartMutation({
      userId,
      method: "GET",
      endpoint: nextUrl,
      requestMeta: { action: "shipments-pagination" },
      responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, action: "shipments", data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Return OTC pagination failed.";
    if (userId) await logFlipkartMutation({
      userId,
      method: "GET",
      endpoint: "/sellers/v3/returns/tasks/shipments/*",
      requestMeta: {},
      responseMeta: {},
      statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message,
      startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  let userId = "";
  let action: Action | null = null;

  try {
    userId = await requireFlipkartOwner();
    const body = await request.json();
    action = actionOf(body?.action);

    let payload: Record<string, unknown>;
    if (action === "initialLoad" || action === "start") {
      payload = {
        sellerLocationId: requiredString(body?.sellerLocationId, "sellerLocationId"),
        taskType: "RETURN",
      };
    } else if (action === "shipments") {
      const pageSize = body?.pageSize === undefined ? 25 : Number(body.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25) {
        throw new Error("pageSize must be an integer between 1 and 25.");
      }
      payload = {
        taskId: requiredString(body?.taskId, "taskId"),
        feId: requiredString(body?.feId, "feId"),
        pageSize,
      };
    } else {
      payload = {
        feId: requiredString(body?.feId, "feId"),
        taskId: requiredString(body?.taskId, "taskId"),
        taskType: "RETURN",
      };
    }

    const endpoint = ACTION_PATHS[action];
    const result = await flipkartRequest<unknown>(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint,
      requestMeta: { action, ...payload },
      responseMeta: result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {},
      statusCode: result.status,
      startedAt,
    });

    return NextResponse.json({ ok: true, action, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Return OTC action failed.";
    if (userId) await logFlipkartMutation({
      userId,
      method: "POST",
      endpoint: action ? ACTION_PATHS[action] : "/sellers/v3/returns/otc/*",
      requestMeta: { action },
      responseMeta: {},
      statusCode: message === "Unauthorized." ? 401 : 502,
      errorMessage: message,
      startedAt,
    });
    return NextResponse.json({ ok: false, error: message }, { status: message === "Unauthorized." ? 401 : 400 });
  }
}
