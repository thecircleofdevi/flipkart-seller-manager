import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { flipkartBinaryRequest, flipkartRequest } from "@/lib/flipkart/client";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SHIPMENT_IDS = 100;

async function assertAuthorized() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const ownerId = process.env.FLIPKART_OWNER_USER_ID;
  if (!user || !ownerId || user.id !== ownerId) throw new Error("Unauthorized.");
  return user.id;
}

function parseShipmentIds(value: string | null) {
  const ids = [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("At least one shipment ID is required.");
  if (ids.length > MAX_SHIPMENT_IDS) throw new Error(`A maximum of ${MAX_SHIPMENT_IDS} shipment IDs can be requested at once.`);
  if (ids.some((id) => !/^[A-Za-z0-9._:-]+$/.test(id))) throw new Error("Invalid shipment ID.");
  return ids;
}

async function assertShipmentOwnership(userId: string, shipmentIds: string[]) {
  const { data, error } = await supabaseAdmin
    .from("shipments")
    .select("flipkart_shipment_id")
    .eq("user_id", userId)
    .in("flipkart_shipment_id", shipmentIds);
  if (error) throw error;

  const owned = new Set((data ?? []).map((row) => row.flipkart_shipment_id).filter(Boolean));
  const missing = shipmentIds.filter((id) => !owned.has(id));
  if (missing.length) throw new Error("One or more shipment IDs are not present in the seller account.");
}

function filenameFromDisposition(value: string | null, fallback: string) {
  const match = value?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  return match?.[1] ? decodeURIComponent(match[1].replace(/"$/, "")) : fallback;
}

export async function GET(request: Request) {
  let jobId: string | null = null;
  try {
    const userId = await assertAuthorized();
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const shipmentIds = parseShipmentIds(url.searchParams.get("shipmentIds"));

    await assertShipmentOwnership(userId, shipmentIds);

    const encodedIds = encodeURIComponent(shipmentIds.join(","));
    const jobType = type === "labels" ? "label" : type === "invoices" ? "invoice" : type === "forms" ? "form" : null;
    if (!jobType) {
      return NextResponse.json({ ok: false, error: "type must be labels, invoices, or forms." }, { status: 400 });
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("document_jobs")
      .insert({
        user_id: userId,
        shipment_id: shipmentIds.length === 1 ? (await supabaseAdmin.from("shipments").select("id").eq("user_id", userId).eq("flipkart_shipment_id", shipmentIds[0]).maybeSingle()).data?.id ?? null : null,
        shipment_ids: shipmentIds,
        type: jobType,
        status: "processing",
        metadata: { requested_from: "shipment_documents_api" },
      })
      .select("id")
      .single();
    if (jobError) throw jobError;
    jobId = job.id;

    if (type === "labels" || type === "invoices") {
      const path = type === "labels"
        ? `/sellers/v3/shipments/${encodedIds}/labels`
        : `/sellers/v3/shipments/${encodedIds}/invoices`;
      const result = await flipkartBinaryRequest(path);

      const filename = filenameFromDisposition(result.contentDisposition, `flipkart-${type}.pdf`);
      await supabaseAdmin.from("document_jobs").update({
        status: result.status >= 200 && result.status < 300 ? "completed" : "failed",
        filename,
        content_type: result.contentType?.split(";")[0] || "application/pdf",
        error: result.status >= 200 && result.status < 300 ? null : `Flipkart returned HTTP ${result.status}`,
        completed_at: new Date().toISOString(),
      }).eq("id", job.id);

      return new NextResponse(result.data, {
        status: result.status,
        headers: {
          "Content-Type": result.contentType?.split(";")[0] || "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "private, no-store",
          "X-Document-Job-Id": job.id,
        },
      });
    }

    if (type === "forms") {
      const result = await flipkartRequest<unknown>(`/sellers/v3/shipments/${encodedIds}/forms`);
      await supabaseAdmin.from("document_jobs").update({
        status: "completed",
        content_type: "application/json",
        metadata: { response: result.data },
        completed_at: new Date().toISOString(),
      }).eq("id", job.id);
      return NextResponse.json({ ok: true, jobId: job.id, shipmentIds, data: result.data }, {
        headers: { "Cache-Control": "private, no-store", "X-Document-Job-Id": job.id },
      });
    }

    return NextResponse.json({ ok: false, error: "type must be labels, invoices, or forms." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown document error.";
    const status = message === "Unauthorized." ? 401 : /required|maximum|Invalid shipment|not present|must be/.test(message) ? 400 : 502;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
