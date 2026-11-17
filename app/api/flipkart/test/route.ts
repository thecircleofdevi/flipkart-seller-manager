import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const appId = process.env.FLIPKART_APP_ID;
  const appSecret = process.env.FLIPKART_APP_SECRET;

  if (!appId || !appSecret) {
    return NextResponse.json({ ok: false, error: "Flipkart credentials are not configured on the server." }, { status: 500 });
  }

  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const tokenUrl = "https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api";

  try {
    const response = await fetch(tokenUrl, {
      method: "GET",
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
      cache: "no-store",
    });

    const body = await response.text();
    if (!response.ok) {
      return NextResponse.json({ ok: false, status: response.status, error: "Flipkart token request failed.", response: safeJson(body) }, { status: 502 });
    }

    const token = safeJson(body);
    if (!token || typeof token !== "object" || !("access_token" in token)) {
      return NextResponse.json({ ok: false, error: "Unexpected Flipkart token response." }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      message: "Flipkart credentials are valid and an access token was issued.",
      tokenType: token.token_type ?? null,
      expiresInSeconds: token.expires_in ?? null,
      scope: token.scope ?? null,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown network error." }, { status: 502 });
  }
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
