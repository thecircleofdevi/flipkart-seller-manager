const TOKEN_URL = "https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api";

type FlipkartTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getFlipkartAccessToken(): Promise<string> {
  const appId = process.env.FLIPKART_APP_ID;
  const appSecret = process.env.FLIPKART_APP_SECRET;

  if (!appId || !appSecret) throw new Error("FLIPKART_APP_ID and FLIPKART_APP_SECRET are required.");

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.accessToken;

  const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  let response: Response | null = null;
  let body = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(TOKEN_URL, {
      method: "GET",
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
      cache: "no-store",
    });
    body = await response.text();
    if (response.ok) break;
    if (![500, 502, 503, 504].includes(response.status) || attempt === 4) {
      throw new Error(`Flipkart token request failed with status ${response.status}: ${body.slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }

  if (!response || !response.ok) throw new Error("Flipkart token request failed.");

  let token: FlipkartTokenResponse;
  try { token = JSON.parse(body) as FlipkartTokenResponse; }
  catch { throw new Error("Flipkart returned a non-JSON token response."); }

  if (!token.access_token) throw new Error("Flipkart token response did not include access_token.");

  const expiresIn = Number(token.expires_in ?? 3600);
  cachedToken = { accessToken: token.access_token, expiresAt: now + Math.max(expiresIn - 60, 60) * 1000 };
  return token.access_token;
}
