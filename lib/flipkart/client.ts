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

export async function flipkartBinaryRequest(
  path: string,
  init: RequestInit = {},
): Promise<{ data: ArrayBuffer; status: number; contentType: string | null; contentDisposition: string | null }> {
  const token = await getFlipkartAccessToken();

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/pdf, application/octet-stream, application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Flipkart API ${response.status} on ${path}: ${text.slice(0, 1000)}`);
  }

  return {
    data: await response.arrayBuffer(),
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
  };
}
