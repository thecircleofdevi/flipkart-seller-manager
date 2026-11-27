"use client";

import { useEffect, useMemo, useState } from "react";

type NavKey = "overview" | "orders" | "shipments" | "listings" | "returns" | "labels" | "sync" | "settings";

type Props = {
  userEmail: string;
  loginKey: string;
  metrics: { label: string; value: number; caption: string; icon: string }[];
  syncRows: { id: string; sync_type: string; status: string; started_at: string; finished_at: string | null; records_written: number | null; error_message: string | null }[];
  returns: { id: string; flipkart_return_id?: string | null; status: string | null; return_reason: string | null; created_at: string | null }[];
  shipments: { id: string; flipkart_shipment_id: string | null; state: string | null; dispatch_by: string | null; tracking_id: string | null; courier_name: string | null; shipment_type?: string | null; hold?: boolean | null }[];
  lowStock: number;
  systemHealthy: boolean;
  orders: { id: string; flipkart_order_id: string | null; order_date: string | null; status: string | null }[];
  listings: { id: string; sku: string | null; fsn: string | null; status: string | null; procurement_type: string | null; shipping_provider: string | null; updated_at: string | null }[];
  attention: { overdueShipments: number; failedSyncs: number; failedNotifications: number };
  orderDetails: { id: string; flipkart_order_id: string; order_date: string | null; status: string | null; searchText: string; items: { id: string; flipkart_order_item_id: string; sku: string | null; fsn: string | null; quantity: number | null; cancellation_group_id: string | null; is_replacement: boolean | null; selling_price: number | null; total_price: number | null; shipping_charge: number | null; customer_price: number | null; status: string | null }[]; shipments: { id: string; flipkart_shipment_id: string; state: string | null; dispatch_after: string | null; dispatch_by: string | null; tracking_id: string | null; tracking_url: string | null; courier_name: string | null; hold: boolean | null; shipment_type: string | null; service_profile: string | null; updated_at: string | null; events: { id: string; event_type: string; event_timestamp: string | null; source: string | null }[]; documents: { id: string; type: string; status: string; shipment_ids: string[]; filename: string | null; content_type: string | null; error: string | null; created_at: string; completed_at: string | null }[] }[]; returns: { id: string; flipkart_return_id: string; status: string | null; return_reason: string | null; source: string | null; created_at: string; updated_at: string }[]; cancellations: { id: string; order_item_id: string; cancellation_group_id: string | null; status: string | null; updated_at: string }[]; timeline: { id: string; kind: string; label: string; timestamp: string; source: string }[] }[];
};

const nav: { id: NavKey; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "orders", label: "Orders", icon: "▦" },
  { id: "shipments", label: "Shipments", icon: "→" },
  { id: "listings", label: "Listings", icon: "◈" },
  { id: "returns", label: "Returns", icon: "↺" },
  { id: "labels", label: "Labels", icon: "▣" },
  { id: "sync", label: "Sync centre", icon: "◌" },
];

function date(value: string | null) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.max(0, seconds % 60);
  return minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

function initials(email: string) {
  return (email.slice(0, 2) || "SM").toUpperCase();
}

export default function DashboardClient(props: Props) {
  const [active, setActive] = useState<NavKey>("overview");
  const [query, setQuery] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedShipmentIds, setSelectedShipmentIds] = useState<Set<string>>(new Set());
  const [shipmentView, setShipmentView] = useState<"all" | "needs_action" | "packing" | "ready" | "shipped" | "delivered" | "hold" | "cancelled" | "delayed">("all");
  const [loadedOrder, setLoadedOrder] = useState<Props["orderDetails"][number] | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [remoteOrders, setRemoteOrders] = useState(props.orders);
  const [remoteOrderTotal, setRemoteOrderTotal] = useState(props.orders.length);
  const [orderSearchLoading, setOrderSearchLoading] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncStage, setSyncStage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ status: string; elapsedSeconds: number; estimatedTotalSeconds: number; recordsWritten: number } | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const [audit, setAudit] = useState<any>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  async function runAudit() {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const response = await fetch("/api/flipkart/audit", { method: "GET", cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Audit failed.");
      setAudit(result);
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : "Audit failed.");
    } finally {
      setAuditLoading(false);
    }
  }
  function openShipmentLabels(shipmentId: string) {
    window.location.href = "/labels?shipmentIds=" + encodeURIComponent(shipmentId);
  }

  const filteredShipments = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    return props.shipments.filter((s) => {
      const state = (s.state ?? "").toUpperCase();
      const overdue = Boolean(s.dispatch_by && new Date(s.dispatch_by).getTime() < now && !["DELIVERED", "CANCELLED"].includes(state));
      const viewMatch =
        shipmentView === "all" ||
        (shipmentView === "needs_action" && (s.hold === true || ["APPROVED", "PACKED", "PACKING_IN_PROGRESS", "READY_TO_DISPATCH"].includes(state) || overdue)) ||
        (shipmentView === "packing" && ["PACKING_IN_PROGRESS", "PACKED"].includes(state)) ||
        (shipmentView === "ready" && state === "READY_TO_DISPATCH") ||
        (shipmentView === "shipped" && state === "SHIPPED") ||
        (shipmentView === "delivered" && state === "DELIVERED") ||
        (shipmentView === "hold" && s.hold === true) ||
        (shipmentView === "cancelled" && state === "CANCELLED") ||
        (shipmentView === "delayed" && overdue);
      const searchMatch = !q || [s.flipkart_shipment_id, s.state, s.tracking_id, s.courier_name].some((v) => v?.toLowerCase().includes(q));
      return viewMatch && searchMatch;
    });
  }, [query, props.shipments, shipmentView]);

  const shipmentTabCounts = useMemo(() => {
    const now = Date.now();
    const counts = { all: props.shipments.length, needs_action: 0, packing: 0, ready: 0, shipped: 0, delivered: 0, hold: 0, cancelled: 0, delayed: 0 };
    for (const s of props.shipments) {
      const state = (s.state ?? "").toUpperCase();
      const overdue = Boolean(s.dispatch_by && new Date(s.dispatch_by).getTime() < now && !["DELIVERED", "CANCELLED"].includes(state));
      if (s.hold === true || ["APPROVED", "PACKED", "PACKING_IN_PROGRESS", "READY_TO_DISPATCH"].includes(state) || overdue) counts.needs_action++;
      if (["PACKING_IN_PROGRESS", "PACKED"].includes(state)) counts.packing++;
      if (state === "READY_TO_DISPATCH") counts.ready++;
      if (state === "SHIPPED") counts.shipped++;
      if (state === "DELIVERED") counts.delivered++;
      if (s.hold === true) counts.hold++;
      if (state === "CANCELLED") counts.cancelled++;
      if (overdue) counts.delayed++;
    }
    return counts;
  }, [props.shipments]);

  const title = nav.find((item) => item.id === active)?.label ?? "Overview";
  const filteredOrders = remoteOrders;
  const filteredListings = useMemo(() => { const q = query.trim().toLowerCase(); if (!q) return props.listings; return props.listings.filter((l) => [l.sku, l.fsn, l.status, l.procurement_type, l.shipping_provider].some((v) => v?.toLowerCase().includes(q))); }, [query, props.listings]);
  const [orderPage, setOrderPage] = useState(1);
  const [listingPage, setListingPage] = useState(1);
  const pageSize = 50;
  const visibleOrders = filteredOrders;
  const visibleListings = filteredListings.slice((listingPage - 1) * pageSize, listingPage * pageSize);
  useEffect(() => {
    const controller = new AbortController();
    setOrderSearchLoading(true);
    fetch(`/api/orders/search?q=${encodeURIComponent(query.trim())}&page=${orderPage}&pageSize=${pageSize}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to load orders.");
        setRemoteOrders(body.orders ?? []);
        setRemoteOrderTotal(body.total ?? 0);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setOrderError(error instanceof Error ? error.message : "Unable to load orders.");
      })
      .finally(() => setOrderSearchLoading(false));
    return () => controller.abort();
  }, [query, orderPage]);

  useEffect(() => {
    if (!selectedOrderId) {
      setLoadedOrder(null);
      setOrderError(null);
      return;
    }
    const controller = new AbortController();
    setOrderLoading(true);
    setOrderError(null);
    fetch(`/api/orders/${selectedOrderId}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to load order.");
        setLoadedOrder(body);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setOrderError(error instanceof Error ? error.message : "Unable to load order.");
      })
      .finally(() => setOrderLoading(false));
    return () => controller.abort();
  }, [selectedOrderId]);

  useEffect(() => {
    setOrderPage(1);
  }, [query]);

  const runHistoricalBackfill = async (stage?: "orders") => {
    if (backfillRunning || syncing) return;
    setBackfillRunning(true);
    setBackfillMessage(stage === "orders" ? "Checking historical orders backfill status..." : "Checking historical backfill status...");

    try {
      const call = async (action: "status" | "start" | "resume" | "step") => {
        const response = await fetch("/api/flipkart/backfill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...(stage ? { stage } : {}) }),
        });
        const result: Record<string, unknown> = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((result.error as string) ?? "Historical backfill request failed.");
        return result;
      };

      const current = await call("status");
      if (current.status === "completed") {
        setBackfillMessage(stage === "orders" ? "Historical orders backfill is already complete." : "Historical backfill is already complete.");
        return;
      }

      if (current.status === "not_started") {
        await call("start");
        setBackfillMessage(stage === "orders" ? "Historical orders backfill started." : "Historical backfill started.");
      } else {
        await call("resume");
        setBackfillMessage(stage === "orders" ? "Resuming historical orders backfill..." : "Resuming historical backfill...");
      }

      let finished = false;
      while (!finished) {
        const result = await call("step");
        if (result.status === "completed" || result.status === "orders_completed") {
          finished = true;
          setBackfillMessage(result.status === "orders_completed" ? "Historical orders backfill completed." : "Historical backfill completed and shipment details were refreshed.");
        } else {
          const stage = String(result.stage ?? "stage").replaceAll("_", " ");
          const windowStart = result.windowStart ? new Date(String(result.windowStart)).toLocaleDateString("en-IN") : "";
          const windowEnd = result.windowEnd ? new Date(String(result.windowEnd)).toLocaleDateString("en-IN") : "";
          setBackfillMessage(`Backfill running: ${stage} · ${windowStart} to ${windowEnd}`);
        }
      }
    } catch (error) {
      setBackfillMessage(error instanceof Error ? error.message : "Historical backfill failed.");
    } finally {
      setBackfillRunning(false);
    }
  };

  useEffect(() => {
    if (!syncing) return;
    let cancelled = false;
    const started = Date.now();

    const stages = [
      { type: "orders" as const, label: "Orders & order items" },
      { type: "shipments" as const, label: "Shipment states & fulfilment" },
      { type: "shipment_details" as const, label: "Shipment details, buyer, packages & forms" },
      { type: "returns" as const, label: "Returns & return events" },
      { type: "listings" as const, label: "Catalogue, inventory & pricing" },
    ];

    const latestSuccessfulDuration = (type: string) => {
      const row = props.syncRows.find((item) => item.sync_type === type && item.status === "success" && item.finished_at);
      if (!row?.finished_at) return null;
      return Math.max(1, Math.round((new Date(row.finished_at).getTime() - new Date(row.started_at).getTime()) / 1000));
    };

    const historicalEstimate = [
      ["orders", latestSuccessfulDuration("orders")],
      ["shipments", latestSuccessfulDuration("shipments")],
      ["shipment_details", latestSuccessfulDuration("shipment_details")],
      ["returns", latestSuccessfulDuration("returns")],
      ["listings", latestSuccessfulDuration("listings")],
    ] as const;

    const knownDurations = new Map(historicalEstimate);
    const fallbackStageSeconds = 20;
    const fulfilmentEstimate = (["orders", "shipments", "shipment_details", "returns"] as const)
      .reduce((sum, type) => sum + (knownDurations.get(type) ?? fallbackStageSeconds), 0);
    const catalogueEstimate = knownDurations.get("listings") ?? fallbackStageSeconds;
    const estimatedTotalSeconds = Math.max(fulfilmentEstimate, catalogueEstimate);

    const runPaged = async (
      type: "orders" | "returns" | "listings",
      extra: Record<string, unknown> = {},
    ) => {
      let syncRunId: string | null = null;
      let cursor: Record<string, unknown> = { ...extra };
      let hasMore = true;
      let recordsWritten = 0;

      while (hasMore && !cancelled) {
        const response: Response = await fetch("/api/flipkart/sync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, ...cursor, ...(syncRunId ? { syncRunId } : {}) }),
        });
        const result: Record<string, unknown> = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((result.error as string) ?? type + " failed");

        syncRunId = (result.syncRunId as string) ?? syncRunId;
        hasMore = Boolean(result.hasMore);
        recordsWritten = Number(result.recordsWritten ?? result.listingsWritten ?? 0);
        cursor = {
          ...cursor,
          nextUrl: result.nextUrl !== undefined ? result.nextUrl : cursor.nextUrl,
          nextPageURL: result.nextPageURL !== undefined ? result.nextPageURL : cursor.nextPageURL,
          pageId: result.pageId !== undefined ? result.pageId : cursor.pageId,
          pendingSkuIds: result.pendingSkuIds !== undefined ? result.pendingSkuIds : cursor.pendingSkuIds,
          batchNo: result.nextBatchNo !== undefined ? result.nextBatchNo : cursor.batchNo,
          currentSource: result.currentSource !== undefined ? result.currentSource : cursor.currentSource,
          modifiedAfter: result.modifiedAfter !== undefined ? result.modifiedAfter : cursor.modifiedAfter,
          modifiedBefore: result.modifiedBefore !== undefined ? result.modifiedBefore : cursor.modifiedBefore,
          mode: result.mode !== undefined ? result.mode : cursor.mode,
        };

        setSyncProgress({
          status: hasMore ? "running" : "success",
          elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          estimatedTotalSeconds,
          recordsWritten,
        });
      }
    };

    const runStage = async (stage: typeof stages[number]) => {
      setSyncStage(stage.type);
      setSyncProgress({ status: "running", elapsedSeconds: 0, estimatedTotalSeconds, recordsWritten: 0 });

      if (stage.type === "shipments") {
        const filterJobs: Array<{ filterType: "preDispatch" | "postDispatch" | "cancelled"; shipmentType?: "NORMAL" | "SELF" }> = [
          { filterType: "preDispatch" },
          { filterType: "postDispatch", shipmentType: "NORMAL" },
          { filterType: "postDispatch", shipmentType: "SELF" },
          { filterType: "cancelled" },
        ];

        for (const job of filterJobs) {
          let nextPageUrl: string | null = null;
          let syncRunId: string | null = null;
          let modifiedFrom: string | undefined;
          let modifiedTo: string | undefined;
          let hasMore = true;

          while (hasMore && !cancelled) {
            const response: Response = await fetch("/api/flipkart/sync/run", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "shipments",
                filterType: job.filterType,
                shipmentType: job.shipmentType,
                nextPageUrl,
                syncRunId,
                modifiedFrom,
                modifiedTo,
              }),
            });
            const result: { ok?: boolean; error?: string; syncRunId?: string; nextPageUrl?: string | null; modifiedFrom?: string; modifiedTo?: string; hasMore?: boolean; recordsWritten?: number } = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error ?? stage.label + " failed");

            syncRunId = result.syncRunId ?? syncRunId;
            nextPageUrl = result.nextPageUrl ?? null;
            modifiedFrom = result.modifiedFrom ?? modifiedFrom;
            modifiedTo = result.modifiedTo ?? modifiedTo;
            hasMore = Boolean(result.hasMore);

            setSyncProgress({
              status: hasMore ? "running" : "success",
              elapsedSeconds: Math.floor((Date.now() - started) / 1000),
              estimatedTotalSeconds,
              recordsWritten: result.recordsWritten ?? 0,
            });
          }
        }
        return;
      }

      if (stage.type === "orders") {
        await runPaged("orders", { mode: "incremental" });
        return;
      }

      if (stage.type === "shipment_details") {
        const response = await fetch("/api/flipkart/sync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: stage.type }),
        });
        const result: { error?: string; syncRunId?: string; shipmentsSeen?: number; shipmentsUpdated?: number } = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? stage.label + " failed");

        const syncRunId = result.syncRunId;
        while (!cancelled) {
          const statusResponse = await fetch("/api/flipkart/sync/status?type=shipment_details", { cache: "no-store" });
          const status: { running?: boolean; status?: string; recordsWritten?: number; errorMessage?: string; estimatedTotalSeconds?: number } = await statusResponse.json().catch(() => ({}));
          if (!statusResponse.ok) throw new Error(status.errorMessage ?? "Unable to read shipment detail sync status");
          if (status.status === "failed") throw new Error(status.errorMessage ?? "Shipment details failed");
          if (!status.running) {
            if (status.status !== "success") throw new Error("Shipment details sync did not complete successfully");
            break;
          }
          setSyncProgress({
            status: "running",
            elapsedSeconds: Math.floor((Date.now() - started) / 1000),
            estimatedTotalSeconds: status.estimatedTotalSeconds ?? estimatedTotalSeconds,
            recordsWritten: status.recordsWritten ?? result.shipmentsUpdated ?? 0,
          });
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        void syncRunId;
        return;
      }

      if (stage.type === "returns") {
        await runPaged("returns", { mode: "incremental" });
        return;
      }

      await runPaged("listings");
    };

    (async () => {
      try {
        const [fulfilmentResult, catalogueResult] = await Promise.allSettled([
          (async () => {
            await runStage(stages[0]);
            await runStage(stages[1]);
            await runStage(stages[2]);
            await runStage(stages[3]);
          })(),
          runStage(stages[4]),
        ]);
        const failures = [fulfilmentResult, catalogueResult].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        if (failures.length) throw failures[0].reason;
        if (!cancelled) {
          const elapsed = Math.floor((Date.now() - started) / 1000);
          setSyncMessage("Sync complete. API pagination ended successfully and all requested database writes completed.");
          setSyncProgress((current) => current ? { ...current, status: "success", estimatedTotalSeconds: elapsed } : current);
          window.location.reload();
        }
      } catch (error) {
        if (!cancelled) setSyncMessage(error instanceof Error ? error.message : "Sync failed");
      }
    })();

    return () => { cancelled = true; };
  }, [syncing]);

  function toggleShipmentSelection(shipmentId: string) {
    setSelectedShipmentIds((current) => {
      const next = new Set(current);
      if (next.has(shipmentId)) next.delete(shipmentId);
      else next.add(shipmentId);
      return next;
    });
  }

  function toggleAllVisibleShipments() {
    const eligible = filteredShipments.filter((s) => Boolean(s.flipkart_shipment_id));
    setSelectedShipmentIds((current) => {
      const next = new Set(current);
      const allSelected = eligible.length > 0 && eligible.every((s) => next.has(s.id));
      eligible.forEach((s) => { if (allSelected) next.delete(s.id); else next.add(s.id); });
      return next;
    });
  }

  function openSelectedLabels() {
    const shipmentIds = filteredShipments.filter((s) => selectedShipmentIds.has(s.id) && s.flipkart_shipment_id).map((s) => s.flipkart_shipment_id as string);
    if (!shipmentIds.length) { setSyncMessage("Select at least one shipment with a Flipkart shipment ID."); return; }
    if (shipmentIds.length > 100) { setSyncMessage("Label generation supports up to 100 shipments per batch."); return; }
    window.location.href = "/labels?shipmentIds=" + encodeURIComponent([...new Set(shipmentIds)].join(","));
  }

  async function downloadShipmentDocument(type: "labels" | "invoices" | "forms", shipmentId: string) {
    try {
      const response = await fetch(`/api/flipkart/shipments/documents?type=${type}&shipmentIds=${encodeURIComponent(shipmentId)}`);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error ?? "Document download failed");
      }
      const blob = await response.blob();
      if (type === "forms") {
        const text = await blob.text();
        const formWindow = window.open("", "_blank");
        if (!formWindow) throw new Error("Allow pop-ups to view shipment forms.");
        formWindow.document.write(`<pre style="white-space:pre-wrap;font-family:system-ui;padding:24px">${text.replace(/</g, "&lt;")}</pre>`);
        formWindow.document.close();
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `flipkart-${type}-${shipmentId}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Document download failed");
    }
  }

  async function mutate(path: string, body: unknown, successMessage: string) {
    try {
      setSyncMessage(null);
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error ?? "Action failed");
      const failed = result.failed ? Object.keys(result.failed).length : 0;
      setSyncMessage(failed ? `${successMessage} ${failed} item(s) failed.` : successMessage);
      window.location.reload();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Action failed");
    }
  }

  async function returnAction(action: "approve" | "reject" | "pickup" | "pickupAttempt" | "complete", returnId: string) {
    const locationId = window.prompt("Flipkart location ID", "");
    if (locationId === null) return;
    const body: Record<string, unknown> = { action, returnIds: [returnId], locationId };
    if (action === "approve" || action === "reject") {
      const comments = window.prompt("Comments", action === "approve" ? "Return approved." : "");
      if (comments === null) return;
      const service = window.prompt("Service fulfilment ID", "");
      if (service === null) return;
      body.comments = comments;
      body.service = service;
      if (action === "reject") {
        const serviceDate = window.prompt("Service date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
        if (serviceDate === null) return;
        body.serviceDate = serviceDate;
      }
    }
    if (action === "pickup" || action === "pickupAttempt") {
      const pickupDate = window.prompt("Pickup date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
      if (pickupDate === null) return;
      body.pickupDate = pickupDate;
    }
    if (action === "pickupAttempt") {
      const reason = window.prompt("Pickup failure reason", "");
      if (reason === null) return;
      const newPickupDate = window.prompt("Next pickup date (YYYY-MM-DD)", "");
      if (newPickupDate === null) return;
      body.reason = reason;
      body.newPickupDate = newPickupDate;
    }
    if (!window.confirm(`${action} return ${returnId}?`)) return;
    await mutate("/api/flipkart/returns/action", body, `Return ${returnId}: ${action} completed.`);
  }

  async function selfShipDispatch(shipmentId: string) {
    const locationId = window.prompt("Flipkart location ID", "");
    if (locationId === null) return;
    const vendorResponse = await fetch(`/api/flipkart/shipments/self-ship/vendors?locationId=${encodeURIComponent(locationId)}`, { cache: "no-store" });
    const vendorResult = await vendorResponse.json().catch(() => ({}));
    if (!vendorResponse.ok || vendorResult.ok === false) {
      setSyncMessage(vendorResult.error ?? "Could not load allowed self-ship vendors.");
      return;
    }
    const vendors = Array.isArray(vendorResult.data) ? vendorResult.data : Array.isArray(vendorResult.data?.vendors) ? vendorResult.data.vendors : [];
    if (!vendors.length) {
      setSyncMessage("Flipkart returned no allowed self-ship vendors for this location.");
      return;
    }
    const options = vendors.map((v: { vendor_name?: string; display_name?: string; vendor_code?: string }) => `${v.vendor_code ?? ""} | ${v.display_name ?? v.vendor_name ?? "Vendor"}`).filter(Boolean).join("\n");
    const selectedCode = window.prompt(`Select an allowed delivery partner by entering its vendor code:\n\n${options}`, vendors[0]?.vendor_code ?? "");
    if (selectedCode === null) return;
    const selected = vendors.find((v: { vendor_code?: string }) => v.vendor_code === selectedCode.trim());
    if (!selected?.vendor_code) {
      setSyncMessage("That delivery partner code is not in Flipkart's allowed vendor list.");
      return;
    }
    const deliveryPartnerCode = selected.vendor_code;
    const deliveryPartner = selected.display_name ?? selected.vendor_name ?? "";
    const dispatchDate = window.prompt("Dispatch date (ISO datetime)", new Date().toISOString());
    if (dispatchDate === null) return;
    const tentativeDeliveryDate = window.prompt("Tentative delivery date (ISO datetime)", new Date(Date.now() + 3 * 86400000).toISOString());
    if (tentativeDeliveryDate === null) return;
    const invoiceDate = window.prompt("Invoice date (ISO datetime)", new Date().toISOString());
    if (invoiceDate === null) return;
    const invoiceNumber = window.prompt("Invoice number (optional)", "");
    if (invoiceNumber === null) return;
    const trackingId = window.prompt("Tracking ID (optional)", "");
    if (trackingId === null) return;
    if (!window.confirm(`Dispatch self-ship shipment ${shipmentId}? This changes the shipment state on Flipkart.`)) return;
    await mutate("/api/flipkart/shipments/self-ship/dispatch", {
      shipmentIds: [shipmentId],
      locationId,
      deliveryPartnerCode,
      ...(deliveryPartner ? { deliveryPartner } : {}),
      dispatchDate,
      tentativeDeliveryDate,
      invoiceDate,
      ...(invoiceNumber ? { invoiceNumber } : {}),
      ...(trackingId ? { trackingId } : {}),
    }, `Shipment ${shipmentId}: self-ship dispatch completed.`);
  }

  async function selfShipDelivery(action: "delivery" | "deliveryAttempt", shipmentId: string) {
    const locationId = window.prompt("Flipkart location ID", "");
    if (locationId === null) return;
    const deliveryDate = window.prompt("Delivery date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
    if (deliveryDate === null) return;
    const body: Record<string, unknown> = { action, shipmentIds: [shipmentId], locationId, deliveryDate };
    if (action === "deliveryAttempt") {
      const reason = window.prompt("Delivery failure reason", "");
      if (reason === null) return;
      const newDeliveryDate = window.prompt("Next delivery date (YYYY-MM-DD)", "");
      if (newDeliveryDate === null) return;
      body.reason = reason;
      body.newDeliveryDate = newDeliveryDate;
      body.failureAttributes = [reason];
    }
    if (!window.confirm(`${action} for shipment ${shipmentId}?`)) return;
    await mutate("/api/flipkart/shipments/self-ship", body, `Shipment ${shipmentId}: ${action} completed.`);
  }

  async function updateInventory(sku: string) {
    const value = window.prompt(`Set inventory for ${sku}`, "0");
    if (value === null) return;
    const inventory = Number(value);
    if (!Number.isInteger(inventory) || inventory < 0) {
      setSyncMessage("Inventory must be a non-negative whole number.");
      return;
    }
    await mutate("/api/flipkart/listings/update-inventory", { updates: [{ sku, inventory }] }, `Inventory updated for ${sku}.`);
  }

  async function updatePrice(sku: string) {
    const mrpValue = window.prompt(`MRP for ${sku}`, "");
    if (mrpValue === null) return;
    const sellingValue = window.prompt(`Selling price for ${sku}`, "");
    if (sellingValue === null) return;
    const mrp = Number(mrpValue);
    const sellingPrice = Number(sellingValue);
    if (!Number.isInteger(mrp) || mrp <= 0 || !Number.isInteger(sellingPrice) || sellingPrice <= 0 || sellingPrice > mrp) {
      setSyncMessage("Prices must be positive whole numbers and selling price cannot exceed MRP.");
      return;
    }
    await mutate("/api/flipkart/listings/update-price", { updates: [{ sku, mrp, sellingPrice, currency: "INR" }] }, `Price updated for ${sku}.`);
  }

  async function dispatchSelectedShipments() {
    const shipmentIds = filteredShipments
      .filter((s) => selectedShipmentIds.has(s.id) && s.flipkart_shipment_id && s.state === "PACKED")
      .map((s) => s.flipkart_shipment_id as string);
    if (!shipmentIds.length) {
      setSyncMessage("Select at least one PACKED shipment.");
      return;
    }
    if (!window.confirm(`Mark ${shipmentIds.length} packed shipment(s) as Ready to Dispatch?`)) return;
    await mutate("/api/flipkart/shipments/dispatch", { shipmentIds }, `${shipmentIds.length} shipment(s) sent to Ready to Dispatch.`);
  }

  async function dispatchShipment(shipmentId: string) {
    if (!window.confirm(`Mark shipment ${shipmentId} as Ready to Dispatch?`)) return;
    await mutate("/api/flipkart/shipments/dispatch", { shipmentIds: [shipmentId] }, `Shipment ${shipmentId} marked Ready to Dispatch.`);
  }
  async function downloadHandoverManifest() {
    const locationId = window.prompt("Flipkart dispatch location ID", "");
    if (locationId === null) return;
    try {
      setSyncMessage("Loading handover vendors...");
      const response = await fetch(`/api/flipkart/shipments/handover/manifest?locationId=${encodeURIComponent(locationId)}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error ?? "Could not load handover vendors.");
      const counts = Array.isArray(result.data) ? result.data : result.data && typeof result.data === "object" ? [result.data] : [];
      const usable = counts.filter((x: { vendorGroupCode?: string; count?: number }) => x.vendorGroupCode && Number(x.count ?? 0) > 0);
      if (!usable.length) throw new Error("No shipments are currently ready for handover.");
      const options = usable.map((x: { vendorGroupCode: string; count: number }) => `${x.vendorGroupCode} | ${x.count} shipment(s)`).join("\n");
      const vendorGroupCode = window.prompt(`Choose the vendor group for the manifest:\n\n${options}`, usable[0].vendorGroupCode);
      if (vendorGroupCode === null) return;
      const selected = usable.find((x: { vendorGroupCode: string }) => x.vendorGroupCode === vendorGroupCode.trim());
      if (!selected) throw new Error("Invalid vendor group.");
      setSyncMessage("Generating Flipkart handover manifest...");
      const manifestResponse = await fetch("/api/flipkart/shipments/handover/manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, vendorGroupCode: selected.vendorGroupCode }),
      });
      if (!manifestResponse.ok) {
        const error = await manifestResponse.json().catch(() => ({}));
        throw new Error(error.error ?? "Manifest generation failed.");
      }
      const blob = await manifestResponse.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `flipkart-handover-manifest-${selected.vendorGroupCode}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setSyncMessage(`Handover manifest downloaded for ${selected.vendorGroupCode}.`);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Manifest generation failed.");
    }
  }


  async function cancelShipment(shipmentId: string) {
    const reason = window.prompt("Cancellation reason: cannot_procure_item, not_enough_inventory, or b2b_order", "not_enough_inventory");
    if (!reason) return;
    if (!window.confirm(`Cancel shipment ${shipmentId}? This is a destructive Flipkart action.`)) return;
    await mutate("/api/flipkart/shipments/cancel", { shipmentIds: [shipmentId], reason }, `Shipment ${shipmentId} cancelled.`);
  }

  async function runReturnsSync() {
    if (syncing || backfillRunning) return;
    setSyncMessage("Starting returns sync...");
    setSyncProgress({ status: "starting", elapsedSeconds: 0, estimatedTotalSeconds: 0, recordsWritten: 0 });
    const started = Date.now();
    let syncRunId: string | null = null;
    let nextUrl: string | null = null;
    let currentSource: string | null = null;
    let hasMore = true;
    let recordsWritten = 0;

    try {
      while (hasMore) {
        const response = await fetch("/api/flipkart/sync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "returns",
            mode: "incremental",
            ...(syncRunId ? { syncRunId } : {}),
            ...(nextUrl ? { nextUrl } : {}),
            ...(currentSource ? { currentSource } : {}),
          }),
        });
        const result: Record<string, unknown> = await response.json().catch(() => ({}));
        if (!response.ok || result.ok === false) {
          throw new Error((result.error as string) ?? "Returns sync failed.");
        }

        syncRunId = (result.syncRunId as string) ?? syncRunId;
        nextUrl = (result.nextUrl as string | null) ?? null;
        currentSource = (result.currentSource as string | null) ?? currentSource;
        hasMore = Boolean(result.hasMore);
        recordsWritten += Number(result.recordsWritten ?? 0);

        setSyncProgress({
          status: hasMore ? "running" : "success",
          elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          estimatedTotalSeconds: Math.max(20, Math.floor((Date.now() - started) / 1000)),
          recordsWritten,
        });
        setSyncMessage(hasMore ? `Returns sync running: ${currentSource ?? "returns"}...` : `Returns sync complete: ${recordsWritten.toLocaleString("en-IN")} records written.`);
      }

      window.location.reload();
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Returns sync failed.");
      setSyncProgress((current) => current ? { ...current, status: "failed" } : current);
    }
  }

  async function runSync() {
    setSyncMessage(null);
    setSyncProgress({ status: "starting", elapsedSeconds: 0, estimatedTotalSeconds: 0, recordsWritten: 0 });
    setSyncStage("all");
    setSyncing("all");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FK</div>
          <div><div className="brand-name">Seller Manager</div><div className="brand-sub">Operations workspace</div></div>
        </div>
        <div className="nav-label">Workspace</div>
        {nav.map((item) => (
          <button key={item.id} className={"nav-item " + (active === item.id ? "active" : "")} onClick={() => setActive(item.id)}>
            <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
          </button>
        ))}
        <div className="nav-label">System</div>
        <button className={"nav-item " + (active === "settings" ? "active" : "")} onClick={() => setActive("settings")}><span className="nav-icon">⚙</span><span>Settings</span></button>
        <div className="sidebar-footer"><div className="user-pill"><div className="avatar">{initials(props.userEmail)}</div><div className="user-meta"><div className="user-email">{props.userEmail}</div><div className="user-role">Connected account</div></div></div></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">Seller operations · {title}</div>
            <h1>{active === "overview" ? "Good morning." : title}</h1>
            <p className="subtitle">{active === "overview" ? "A calm view of everything that needs your attention." : "One focused workspace for the decisions that matter."}</p>
          </div>
          <div className="top-actions">
            <div className="search-wrap"><span>⌕</span><input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search SKU, order, shipment" aria-label="Search" /><kbd>⌘ K</kbd></div>
            <button className="icon-button" aria-label="Command menu" onClick={() => setCommandOpen(true)}>⌘</button>
            <button className="primary-button" onClick={() => setCommandOpen(true)}>New action</button>
          </div>
        </header>

        {active === "overview" && (
          <>
            <section className="hero">
              <div className="hero-grid">
                <div>
                  <div className="eyebrow hero-eyebrow">Control centre</div>
                  <h2>Your marketplace, at a glance.</h2>
                  <p>Orders, fulfilment, catalogue health and seller events brought into one focused workspace. The interface stays quiet until something needs you.</p>
                  <div className="hero-actions"><button className="hero-button" onClick={() => setActive("shipments")}>Open fulfilment queue <span>↗</span></button><button className="hero-link" onClick={() => setActive("sync")}>View system health</button></div>
                </div>
                <div className="hero-kpis">
                  <div className="hero-kpi"><div className="value">{props.syncRows.filter((r) => r.status === "success").length}/{props.syncRows.length || 0}</div><div className="label">recent syncs healthy</div></div>
                  <div className="hero-kpi"><div className="value">{props.lowStock}</div><div className="label">low stock items</div></div>
                  <div className="hero-kpi"><div className="value">{props.systemHealthy ? "Healthy" : "Check"}</div><div className="label">system status</div></div>
                </div>
              </div>
            </section>

            <section className="section">
              <div className="section-head"><h2 className="section-title">Workspace</h2><span className="live-pill"><i /> Live snapshot</span></div>
              <div className="stats">{props.metrics.map((m) => <button className="card stat-card" key={m.label} onClick={() => setActive((m.label === "Notifications" ? "sync" : m.label.toLowerCase()) as NavKey)}><div className="stat-top"><span>{m.label}</span><span className="stat-icon">{m.icon}</span></div><div className="stat-value">{m.value}</div><div className="stat-caption">{m.caption}</div><span className="card-arrow">↗</span></button>)}</div>
            </section>

            <section className="section grid-2">
              <article className="card">
                <div className="section-head"><h2 className="section-title">Needs attention</h2><span className="section-note">Prioritised for you</span></div>
                <div className="queue-list">
                  <div className="queue-row"><div className="queue-left"><span className={props.attention.overdueShipments ? "status-dot red" : "status-dot green"} /><div><div className="queue-name">{props.attention.overdueShipments ? props.attention.overdueShipments + " shipment" + (props.attention.overdueShipments === 1 ? "" : "s") + " past dispatch deadline" : "No shipments past dispatch deadline"}</div><div className="queue-meta">Deadline breaches are the highest-priority fulfilment issue.</div></div></div><span className={props.attention.overdueShipments ? "badge" : "badge good"}>{props.attention.overdueShipments ? "Urgent" : "Clear"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.lowStock ? "status-dot orange" : "status-dot green"} /><div><div className="queue-name">{props.lowStock ? "Review " + props.lowStock + " low-stock item" + (props.lowStock === 1 ? "" : "s") : "Inventory looks healthy"}</div><div className="queue-meta">Protect availability on fast-moving catalogue items.</div></div></div><span className={props.lowStock ? "badge warn" : "badge good"}>{props.lowStock ? "Review" : "Good"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.returns.length ? "status-dot orange" : "status-dot green"} /><div><div className="queue-name">{props.returns.length} open return records</div><div className="queue-meta">Customer and courier returns.</div></div></div><span className={props.returns.length ? "badge warn" : "badge good"}>{props.returns.length ? "Review" : "Clear"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.attention.failedSyncs ? "status-dot red" : "status-dot green"} /><div><div className="queue-name">{props.attention.failedSyncs ? props.attention.failedSyncs + " failed sync run" + (props.attention.failedSyncs === 1 ? "" : "s") : "No failed sync runs in the recent window"}</div><div className="queue-meta">Sync failures can leave catalogue or fulfilment data stale.</div></div></div><span className={props.attention.failedSyncs ? "badge" : "badge good"}>{props.attention.failedSyncs ? "Investigate" : "Clear"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.attention.failedNotifications ? "status-dot red" : "status-dot green"} /><div><div className="queue-name">{props.attention.failedNotifications ? props.attention.failedNotifications + " notification" + (props.attention.failedNotifications === 1 ? "" : "s") + " failed processing" : "Notification processing is clear"}</div><div className="queue-meta">Failed events can leave shipment state behind the marketplace.</div></div></div><span className={props.attention.failedNotifications ? "badge" : "badge good"}>{props.attention.failedNotifications ? "Investigate" : "Clear"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.systemHealthy ? "status-dot green" : "status-dot red"} /><div><div className="queue-name">{props.systemHealthy ? "Data connections are healthy" : "A system check needs attention"}</div><div className="queue-meta">Database and sync visibility.</div></div></div><span className={props.systemHealthy ? "badge good" : "badge"}>{props.systemHealthy ? "Healthy" : "Check"}</span></div>
                </div>
              </article>
              <article className="card sync-card"><div className="section-head"><h2 className="section-title">Sync centre</h2><button className="text-button" onClick={() => setActive("sync")}>See all</button></div>{props.syncRows.length ? props.syncRows.slice(0, 4).map((row) => <div className="sync-row" key={row.id}><div><div className="sync-type">{row.sync_type.replaceAll("_", " ")}</div><div className="sync-time">{date(row.finished_at ?? row.started_at)} · {row.records_written ?? 0} written</div></div><span className={"sync-status " + row.status}>{row.status}</span></div>) : <div className="empty">No sync runs yet. This becomes your operational heartbeat as data starts flowing.</div>}</article>
            </section>

            <section className="section grid-2">
              <article className="card"><div className="section-head"><h2 className="section-title">Fulfilment queue</h2><button className="text-button" onClick={() => setActive("shipments")}>Open queue ↗</button></div>{props.shipments.length ? props.shipments.slice(0, 4).map((s) => <div className="queue-row" key={s.id}><div className="queue-left"><span className="status-dot orange" /><div><div className="queue-name">{s.flipkart_shipment_id ?? "Shipment"}</div><div className="queue-meta">{s.state?.replaceAll("_", " ")} · {s.courier_name ?? "Courier pending"}</div></div></div><span className="badge">{date(s.dispatch_by)}</span></div>) : <div className="empty">No active fulfilment items are waiting for attention.</div>}</article>
              <article className="card"><div className="section-head"><h2 className="section-title">Return desk</h2><button className="text-button" onClick={() => setActive("returns")}>Open returns ↗</button></div>{props.returns.length ? props.returns.slice(0, 4).map((r) => <div className="queue-row" key={r.id}><div className="queue-left"><span className="status-dot orange" /><div><div className="queue-name">{r.status ?? "Return"}</div><div className="queue-meta">{r.return_reason ?? "Reason not supplied"}</div></div></div><span className="badge">{date(r.created_at)}</span></div>) : <div className="empty">No open returns. Your return desk is clear.</div>}</article>
            </section>
          </>
        )}

        {active !== "overview" && (
          <section className="workspace-view">
            <div className="view-hero"><div><span className="eyebrow">Workspace</span><h2>{title}</h2><p>Designed as a focused command surface. Search, inspect, then act without losing context.</p></div><div className="view-count">{active === "shipments" ? props.shipments.length : active === "returns" ? props.returns.length : active === "sync" ? props.syncRows.length : active === "listings" ? props.metrics.find((m) => m.label === "Listings")?.value ?? 0 : "—"}<span>records</span></div></div>
            {active === "shipments" && <div className="table-card">
              <div className="shipment-tabs" role="tablist" aria-label="Shipment views">
                {([
                  ["all", "All"],
                  ["needs_action", "Needs Action"],
                  ["packing", "Packing"],
                  ["ready", "Ready to Dispatch"],
                  ["shipped", "Shipped"],
                  ["delivered", "Delivered"],
                  ["hold", "On Hold"],
                  ["cancelled", "Cancelled"],
                  ["delayed", "Delayed"],
                ] as const).map(([id, label]) => <button key={id} className={"text-button" + (shipmentView === id ? " active-tab" : "")} onClick={() => setShipmentView(id)} role="tab" aria-selected={shipmentView === id}>{label} <span style={{opacity:.65}}>{shipmentTabCounts[id]}</span></button>)}
              </div>
              <div className="table-toolbar shipment-toolbar">
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <input type="checkbox" aria-label="Select all visible shipments"
                    checked={filteredShipments.filter((s) => s.flipkart_shipment_id).length > 0 && filteredShipments.filter((s) => s.flipkart_shipment_id).every((s) => selectedShipmentIds.has(s.id))}
                    onChange={toggleAllVisibleShipments}
                  />
                  <span>Fulfilment queue</span>
                  <span>{filteredShipments.length} visible</span>
                  {selectedShipmentIds.size > 0 && <span className="selection-count">{selectedShipmentIds.size} selected</span>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  {selectedShipmentIds.size > 0 && <button className="primary-button" onClick={openSelectedLabels}>Generate labels</button>}{selectedShipmentIds.size > 0 && filteredShipments.some((s) => selectedShipmentIds.has(s.id) && s.state === "PACKED") && <button className="text-button" onClick={dispatchSelectedShipments}>Mark Ready</button>}{filteredShipments.some((s) => s.state === "READY_TO_DISPATCH") && <button className="text-button" onClick={downloadHandoverManifest}>Handover manifest</button>}
                  <button className="text-button" onClick={() => setActive("labels")}>Label Workspace</button>
                </div>
              </div>
              {filteredShipments.length ? filteredShipments.map((s) => <div className="table-row shipment-table-row" key={s.id}>
                <input type="checkbox" aria-label="Select shipment" checked={selectedShipmentIds.has(s.id)} disabled={!s.flipkart_shipment_id}
                  onChange={() => toggleShipmentSelection(s.id)} onClick={(e) => e.stopPropagation()} />
                <div className="row-main"><span className="status-dot orange"/><div><strong>{s.flipkart_shipment_id ?? "Shipment"}</strong><small>{s.tracking_id ?? "Tracking pending"} · {s.courier_name ?? "Courier pending"}</small></div></div>
                <span className="badge">{s.state?.replaceAll("_", " ") ?? "Unknown"}</span>
                <span className="row-date">{date(s.dispatch_by)}</span>
                <div style={{display:"flex",gap:6,marginLeft:"auto",flexWrap:"wrap",justifyContent:"flex-end"}}>
                  {s.flipkart_shipment_id && <>
                    <button className="text-button" onClick={() => downloadShipmentDocument("labels", s.flipkart_shipment_id!)}>Label</button>
                    <button className="text-button" onClick={() => downloadShipmentDocument("invoices", s.flipkart_shipment_id!)}>Invoice</button>
                    <button className="text-button" onClick={() => downloadShipmentDocument("forms", s.flipkart_shipment_id!)}>Forms</button>
                    {s.state === "PACKED" && <button className="text-button" onClick={() => dispatchShipment(s.flipkart_shipment_id!)}>Ready</button>}
                    {["APPROVED","PACKED","PACKING_IN_PROGRESS","READY_TO_DISPATCH"].includes(s.state ?? "") && <button className="text-button" onClick={() => cancelShipment(s.flipkart_shipment_id!)}>Cancel</button>}
                    {s.shipment_type === "SELF" && ["APPROVED","PACKED","READY_TO_DISPATCH"].includes(s.state ?? "") && <button className="text-button" onClick={() => selfShipDispatch(s.flipkart_shipment_id!)}>Self dispatch</button>}
                    {s.shipment_type === "SELF" && s.state === "SHIPPED" && <>
                      <button className="text-button" onClick={() => selfShipDelivery("delivery", s.flipkart_shipment_id!)}>Deliver</button>
                      <button className="text-button" onClick={() => selfShipDelivery("deliveryAttempt", s.flipkart_shipment_id!)}>Attempt</button>
                    </>}
                  </>}
                </div>
              </div>) : <div className="empty big">No shipments match your search.</div>}
            </div>}
            {active === "sync" && <div className="table-card">{syncing && syncProgress && <div className="sync-progress"><div className="sync-progress-head"><span>{syncing === "all" ? "Syncing all marketplace data" : "Syncing marketplace data"}</span><span className="sync-progress-time">{formatDuration(syncProgress.elapsedSeconds)} elapsed</span></div><div className="sync-progress-track"><div className="sync-progress-bar" style={{ width: `${Math.min(95, Math.max(4, (syncProgress.elapsedSeconds / Math.max(1, syncProgress.estimatedTotalSeconds)) * 100))}%` }} /></div><div className="sync-progress-meta"><span>{syncProgress.recordsWritten.toLocaleString("en-IN")} records written</span><span>ETA ~ {formatDuration(Math.max(0, syncProgress.estimatedTotalSeconds - syncProgress.elapsedSeconds))}</span></div></div>}<div className="sync-actions"><button className="primary-button" disabled={Boolean(syncing) || backfillRunning} onClick={runSync}>{syncing === "all" ? "Syncing all data..." : "Sync all data"}</button><button className="text-button" disabled={Boolean(syncing) || backfillRunning} onClick={runReturnsSync}>Sync returns</button><button className="text-button" disabled={Boolean(syncing) || backfillRunning} onClick={() => runHistoricalBackfill("orders")}>{backfillRunning ? "Backfilling orders..." : "Backfill orders from Mar 2025"}</button><button className="text-button" disabled={Boolean(syncing) || backfillRunning} onClick={() => runHistoricalBackfill()}>{backfillRunning ? "Backfilling history..." : "Backfill full history"}</button><button className="text-button" disabled={auditLoading || Boolean(syncing) || backfillRunning} onClick={runAudit}>{auditLoading ? "Auditing..." : "Run completeness audit"}</button>{syncMessage && <span className="sync-message">{syncMessage}</span>}</div>{auditError && <div className="sync-message" style={{marginTop:10}}>{auditError}</div>}{audit && <div className="card" style={{marginTop:14}}><div className="section-head"><h3 className="section-title">Data completeness</h3><span className={"badge " + (audit.overall === "critical" ? "" : audit.overall === "warning" ? "warn" : "good")}>{audit.overall}</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:8}}>{Object.entries(audit.counts ?? {}).map(([key,value]) => <div className="badge" key={key}>{key.replaceAll("_"," ")}: {String(value)}</div>)}</div>{audit.critical?.map((item:string) => <div className="sync-message" key={item}>Critical: {item}</div>)}{audit.warnings?.map((item:string) => <div className="sync-message" key={item}>Warning: {item}</div>)}{audit.backfill && <div className="sync-message">Historical backfill: {audit.backfill.completed_windows}/{audit.backfill.total_windows} windows complete.</div>}<div className="sync-message">Generated {date(audit.generatedAt)}</div></div>}{props.syncRows.length ? props.syncRows.map((r) => <div className="table-row" key={r.id}><div className="row-main"><span className={"status-dot " + (r.status === "success" ? "green" : r.status === "failed" ? "red" : "orange")}/><div><strong>{r.sync_type.replaceAll("_", " ")}</strong><small>{date(r.finished_at ?? r.started_at)} · {r.records_written ?? 0} records</small></div></div><span className={"sync-status " + r.status}>{r.status}</span></div>) : <div className="empty big">No sync history yet.</div>}</div>}
            {active === "orders" && <div className="table-card"><div className="table-toolbar"><span>Order stream</span><div style={{display:"flex",alignItems:"center",gap:8}}><span>{remoteOrderTotal} records · page {orderPage} / {Math.max(1, Math.ceil(remoteOrderTotal / pageSize))}{orderSearchLoading ? " · loading…" : ""}</span><button className="text-button" disabled={orderPage <= 1 || orderSearchLoading} onClick={() => setOrderPage((p) => Math.max(1, p - 1))}>Previous</button><button className="text-button" disabled={orderPage >= Math.max(1, Math.ceil(remoteOrderTotal / pageSize)) || orderSearchLoading} onClick={() => setOrderPage((p) => p + 1)}>Next</button></div></div>{visibleOrders.length ? visibleOrders.map((o) => <button className="table-row table-row-button" key={o.id} onClick={() => setSelectedOrderId(o.id)}><div className="row-main"><span className={"status-dot " + (o.status?.toLowerCase().includes("cancel") ? "red" : "green")}/><div><strong>{o.flipkart_order_id ?? "Order"}</strong><small>{o.status ?? "Status pending"}</small></div></div><span className="badge">{date(o.order_date)}</span><span className="row-arrow">↗</span></button>) : <div className="empty big">No orders match your search.</div>}</div>}
            {active === "labels" && <div className="empty-state"><div className="empty-orb">▣</div><h3>Label Workspace</h3><p>Open the dedicated 4×6 thermal label workspace to crop, save presets, process multiple PDFs and prepare a print-ready batch.</p><a className="primary-button" href="/labels">Open Label Workspace</a></div>}
            {active === "listings" && <div className="table-card"><div className="table-toolbar"><span>Catalogue</span><span>{filteredListings.length} records · page {listingPage} / {Math.max(1, Math.ceil(filteredListings.length / pageSize))}</span></div>{visibleListings.length ? visibleListings.map((l) => <div className="table-row" key={l.id}><div className="row-main"><span className={"status-dot " + (l.status === "ACTIVE" ? "green" : "orange")}/><div><strong>{l.sku ?? "SKU pending"}</strong><small>{l.fsn ?? "FSN pending"} · {l.procurement_type ?? "Procurement pending"}</small></div></div><span className="badge">{l.status ?? "Unknown"}</span><span className="row-date">{l.shipping_provider ?? "Shipping provider pending"}</span><div style={{display:"flex",gap:6,marginLeft:"auto"}}>{l.sku && <><button className="text-button" onClick={() => updateInventory(l.sku!)}>Stock</button><button className="text-button" onClick={() => updatePrice(l.sku!)}>Price</button></>}</div></div>) : <div className="empty big">No listings match your search.</div>}</div>}
            {active === "settings" && <div className="settings-grid"><div className="card setting-card"><span className="setting-icon">◉</span><div><strong>Flipkart connection</strong><p>Authenticated seller API connection is configured server-side.</p></div><span className="badge good">Connected</span></div><div className="card setting-card"><span className="setting-icon">◌</span><div><strong>Data health</strong><p>Supabase is serving the seller workspace.</p></div><span className="badge good">Healthy</span></div></div>}
          </section>
        )}

        <footer className="footer-note">Seller Manager · Quiet by default. Powerful when needed.</footer>
      </main>

      {selectedOrderId && (() => {
        const order = loadedOrder;
        if (orderLoading) return <div className="drawer-backdrop" onClick={() => setSelectedOrderId(null)}><aside className="order-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">Order 360</span><h2>Loading order…</h2><p>Fetching live order relationships.</p></div><button className="drawer-close" onClick={() => setSelectedOrderId(null)}>×</button></div></aside></div>;
        if (orderError) return <div className="drawer-backdrop" onClick={() => setSelectedOrderId(null)}><aside className="order-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">Order 360</span><h2>Unable to load order</h2><p>{orderError}</p></div><button className="drawer-close" onClick={() => setSelectedOrderId(null)}>×</button></div></aside></div>;
        if (!order) return null;
        return <div className="drawer-backdrop" onClick={() => setSelectedOrderId(null)}>
          <aside className="order-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <div><span className="eyebrow">Order 360</span><h2>{order.flipkart_order_id}</h2><p>{date(order.order_date)} · {order.status ?? "Status pending"}</p></div>
              <button className="drawer-close" onClick={() => setSelectedOrderId(null)}>×</button>
            </div>
            <div className="drawer-section"><div className="drawer-label">Order status</div><span className={"badge " + (order.status?.toLowerCase().includes("cancel") ? "" : "good")}>{order.status ?? "Unknown"}</span></div>
            <div className="drawer-section">
              <div className="drawer-section-head"><div className="drawer-label">Items</div><span>{order.items.length}</span></div>
              {order.items.length ? order.items.map((i) => <div className="drawer-item" key={i.id}>
                <div><strong>{i.sku ?? i.fsn ?? "Item"}</strong><small>{i.flipkart_order_item_id} · Qty {i.quantity ?? 0}{i.is_replacement ? " · Replacement" : ""}</small></div>
                <span>{i.customer_price != null ? "₹" + Number(i.customer_price).toLocaleString("en-IN") : "Price pending"}</span>
              </div>) : <div className="drawer-empty">No order items captured.</div>}
            </div>
            <div className="drawer-section">
              <div className="drawer-section-head"><div className="drawer-label">Fulfilment</div><span>{order.shipments.length}</span></div>
              {order.shipments.length ? order.shipments.map((s) => <div className="shipment-cockpit" key={s.id}>
                <div className="shipment-top"><div><strong>{s.flipkart_shipment_id}</strong><small>{s.state?.replaceAll("_"," ") ?? "State pending"} · {s.courier_name ?? "Courier pending"}</small></div><span className={s.hold ? "badge warn" : "badge good"}>{s.hold ? "On hold" : "Moving"}</span></div>
                <div className="shipment-meta"><span>Dispatch by <b>{date(s.dispatch_by)}</b></span><span>{s.tracking_id ?? "Tracking pending"}</span></div><div className="shipment-actions"><button className="text-button" onClick={() => openShipmentLabels(s.flipkart_shipment_id)}>Label</button><button className="text-button" onClick={() => downloadShipmentDocument("invoices", s.flipkart_shipment_id)}>Invoice</button><button className="text-button" onClick={() => downloadShipmentDocument("forms", s.flipkart_shipment_id)}>Forms</button></div>
                {s.events.length ? <div className="timeline">{s.events.map((e) => <div className="timeline-row" key={e.id}><i/><div><strong>{e.event_type.replaceAll("_"," ")}</strong><small>{date(e.event_timestamp)}{e.source ? " · " + e.source : ""}</small></div></div>)}</div> : <div className="drawer-empty">No shipment events captured yet.</div>}
                {s.documents.length ? <div className="document-history"><div className="drawer-label">Documents</div>{s.documents.map((doc) => <div className="drawer-item" key={doc.id}><div><strong>{doc.type === "label" ? "Shipping label" : doc.type === "invoice" ? "Invoice" : "Shipment form"}</strong><small>{doc.status} · {date(doc.completed_at ?? doc.created_at)}{doc.filename ? " · " + doc.filename : ""}</small></div><div className="document-row-actions"><span className={"badge " + (doc.status === "completed" ? "good" : doc.status === "failed" ? "" : "warn")}>{doc.status}</span>{doc.status === "completed" && doc.type === "label" && <button className="text-button" onClick={() => openShipmentLabels(s.flipkart_shipment_id)}>Open</button>}{doc.status === "completed" && doc.type === "invoice" && <button className="text-button" onClick={() => downloadShipmentDocument("invoices", s.flipkart_shipment_id)}>Download</button>}{doc.status === "completed" && doc.type === "form" && <button className="text-button" onClick={() => downloadShipmentDocument("forms", s.flipkart_shipment_id)}>Fetch</button>}</div></div>)}</div> : <div className="drawer-empty">No shipment documents generated yet.</div>}
              </div>) : <div className="drawer-empty">No shipment is linked to this order yet.</div>}
            </div>
            <div className="drawer-section">
              <div className="drawer-section-head"><div className="drawer-label">Returns</div><span>{order.returns.length}</span></div>
              {order.returns.length ? order.returns.map((r) => <div className="drawer-item" key={r.id}><div><strong>{r.flipkart_return_id}</strong><small>{r.status ?? "Status pending"} · {r.return_reason ?? "Reason not supplied"}</small></div><span className="badge">{r.source ?? "Return"}</span></div>) : <div className="drawer-empty">No return is linked to this order.</div>}
            </div>
            <div className="drawer-section">
              <div className="drawer-section-head"><div className="drawer-label">Cancellations</div><span>{order.cancellations.length}</span></div>
              {order.cancellations.length ? order.cancellations.map((cancellation) => <div className="drawer-item" key={cancellation.id}><div><strong>{cancellation.order_item_id}</strong><small>{cancellation.status ?? "Cancelled"}{cancellation.cancellation_group_id ? " · Group " + cancellation.cancellation_group_id : ""}</small></div><span>{date(cancellation.updated_at)}</span></div>) : <div className="drawer-empty">No cancellation record linked to this order.</div>}
            </div>
            <div className="drawer-section">
              <div className="drawer-section-head"><div className="drawer-label">Unified timeline</div><span>{order.timeline.length}</span></div>
              {order.timeline.length ? <div className="timeline">{order.timeline.map((event) => <div className="timeline-row" key={event.id}><i/><div><strong>{event.label.replaceAll("_"," ")}</strong><small>{date(event.timestamp)} · {event.kind} · {event.source}</small></div></div>)}</div> : <div className="drawer-empty">No timeline events captured yet.</div>}
            </div>
          </aside>
        </div>;
      })()}
      {commandOpen && <div className="command-backdrop" onClick={() => setCommandOpen(false)}><div className="command" onClick={(e) => e.stopPropagation()}><div className="command-head"><span>Quick actions</span><button onClick={() => setCommandOpen(false)}>Esc</button></div><button onClick={() => { setActive("shipments"); setCommandOpen(false); }}>→ Open fulfilment queue</button><button onClick={() => { setActive("returns"); setCommandOpen(false); }}>↺ Review returns</button><button onClick={() => { setActive("sync"); setCommandOpen(false); }}>◌ Inspect sync health</button><button onClick={() => { setActive("listings"); setCommandOpen(false); }}>◈ Open catalogue</button><button onClick={() => { setActive("orders"); setCommandOpen(false); }}>▦ Open orders</button></div></div>}
    </div>
  );
}