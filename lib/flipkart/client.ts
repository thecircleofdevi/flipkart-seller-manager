import { getFlipkartAccessToken } from "./auth";

const BASE_URL = "https://api.flipkart.net";

export async function flipkartRequest<T>(path: string, init: RequestInit = {}): Promise<{ data: T; status: number }> {
  const token = await getFlipkartAccessToken();

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Flipkart API ${response.status} on ${path}: ${text.slice(0, 1000)}`);

  let data: T;
  try { data = JSON.parse(text) as T; }
  catch { throw new Error(`Flipkart returned a non-JSON response on ${path}.`); }

  return { data, status: response.status };
}
