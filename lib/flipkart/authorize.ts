import { createClient } from "@/lib/supabase/server";

export async function requireFlipkartOwner() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Unauthorized.");

  const ownerId = process.env.FLIPKART_OWNER_USER_ID;
  if (!ownerId || user.id !== ownerId) throw new Error("Unauthorized.");

  return user.id;
}

export function parseStringList(value: unknown, field: string, max: number) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  const values = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  if (!values.length) throw new Error(`${field} must contain at least one value.`);
  if (values.length > max) throw new Error(`${field} supports at most ${max} values per request.`);
  return values;
}

export function assertNonNegativeInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer.`);
  return value as number;
}

export function assertPositiveInteger(value: unknown, field: string) {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer.`);
  return value as number;
}
