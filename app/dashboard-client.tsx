"use client";

import { useEffect, useMemo, useState } from "react";

type NavKey = "overview" | "orders" | "shipments" | "listings" | "returns" | "sync" | "settings";

type Props = {
  userEmail: string;
  metrics: { label: string; value: number; caption: string; icon: string }[];
  syncRows: { id: string; sync_type: string; status: string; started_at: string; finished_at: string | null; records_written: number | null; error_message: string | null }[];
  returns: { id: string; status: string | null; return_reason: string | null; created_at: string | null }[];
  shipments: { id: string; flipkart_shipment_id: string | null; state: string | null; dispatch_by: string | null; tracking_id: string | null; courier_name: string | null }[];
  lowStock: number;
  systemHealthy: boolean;
  orders: { id: string; flipkart_order_id: string | null; order_date: string | null; status: string | null }[];
  listings: { id: string; sku: string | null; fsn: string | null; status: string | null; procurement_type: string | null; shipping_provider: string | null; updated_at: string | null }[];
  attention: { overdueShipments: number; failedSyncs: number; failedNotifications: number };
  orderDetails: { id: string; flipkart_order_id: string; order_date: string | null; status: string | null; items: { id: string; flipkart_order_item_id: string; sku: string | null; fsn: string | null; quantity: number | null; selling_price: number | null; total_price: number | null; shipping_charge: number | null; customer_price: number | null; status: string | null }[]; shipments: { id: string; flipkart_shipment_id: string; state: string | null; dispatch_after: string | null; dispatch_by: string | null; tracking_id: string | null; tracking_url: string | null; courier_name: string | null; hold: boolean | null; shipment_type: string | null; service_profile: string | null; updated_at: string | null; events: { id: string; event_type: string; event_timestamp: string | null; source: string | null }[] }[] }[];
};

const nav: { id: NavKey; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "orders", label: "Orders", icon: "▦" },
  { id: "shipments", label: "Shipments", icon: "→" },
  { id: "listings", label: "Listings", icon: "◈" },
  { id: "returns", label: "Returns", icon: "↺" },
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
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncStage, setSyncStage] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ status: string; elapsedSeconds: number; estimatedTotalSeconds: number; recordsWritten: number } | null>(null);

  const filteredShipments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.shipments;
    return props.shipments.filter((s) => [s.flipkart_shipment_id, s.state, s.tracking_id, s.courier_name].some((v) => v?.toLowerCase().includes(q)));
  }, [query, props.shipments]);

  const title = nav.find((item) => item.id === active)?.label ?? "Overview";
  const filteredOrders = useMemo(() => { const q = query.trim().toLowerCase(); if (!q) return props.orders; return props.orders.filter((o) => [o.flipkart_order_id, o.status].some((v) => v?.toLowerCase().includes(q))); }, [query, props.orders]);
  const filteredListings = useMemo(() => { const q = query.trim().toLowerCase(); if (!q) return props.listings; return props.listings.filter((l) => [l.sku, l.fsn, l.status, l.procurement_type, l.shipping_provider].some((v) => v?.toLowerCase().includes(q))); }, [query, props.listings]);
  const [orderPage, setOrderPage] = useState(1);
  const [listingPage, setListingPage] = useState(1);
  const pageSize = 50;
  const visibleOrders = filteredOrders.slice((orderPage - 1) * pageSize, orderPage * pageSize);
  const visibleListings = filteredListings.slice((listingPage - 1) * pageSize, listingPage * pageSize);
  useEffect(() => {
    if (!syncing) return;
    let cancelled = false;
    const started = Date.now();

    const stages = syncing === "shipments"
      ? [
          { type: "shipments" as const, label: "Orders & shipment states" },
          { type: "shipment_details" as const, label: "Shipment details, buyer, packages & forms" },
          { type: "returns" as const, label: "Returns & return events" },
        ]
      : [
          { type: "listings" as const, label: "Catalogue, inventory & pricing" },
          { type: "product_search" as const, label: "Product catalogue enrichment" },
        ];

    const runPaged = async (
      type: "returns" | "listings",
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
          pageId: result.pageId !== undefined ? result.pageId : cursor.pageId,
          pendingSkuIds: result.pendingSkuIds !== undefined ? result.pendingSkuIds : cursor.pendingSkuIds,
          batchNo: result.nextBatchNo !== undefined ? result.nextBatchNo : cursor.batchNo,
          currentSource: result.currentSource !== undefined ? result.currentSource : cursor.currentSource,
          modifiedAfter: result.modifiedAfter !== undefined ? result.modifiedAfter : cursor.modifiedAfter,
          modifiedBefore: result.modifiedBefore !== undefined ? result.modifiedBefore : cursor.modifiedBefore,
        };

        setSyncProgress({
          status: hasMore ? "running" : "success",
          elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          estimatedTotalSeconds: 180,
          recordsWritten,
        });
      }
    };

    const runStage = async (stage: typeof stages[number]) => {
      setSyncStage(stage.type);
      setSyncProgress({ status: "running", elapsedSeconds: 0, estimatedTotalSeconds: 180, recordsWritten: 0 });

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
              estimatedTotalSeconds: 180,
              recordsWritten: result.recordsWritten ?? 0,
            });
          }
        }
        return;
      }

      if (stage.type === "shipment_details") {
        const pollPromise = (async () => {
          while (!cancelled) {
            const response = await fetch("/api/flipkart/sync/status?type=shipment_details", { cache: "no-store" });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.running) {
              if (result.status === "failed") throw new Error(result.errorMessage ?? "Shipment details failed");
              return;
            }
            setSyncProgress({
              status: "running",
              elapsedSeconds: Math.floor((Date.now() - started) / 1000),
              estimatedTotalSeconds: result.estimatedTotalSeconds ?? 180,
              recordsWritten: result.recordsWritten ?? 0,
            });
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        })();

        const response = await fetch("/api/flipkart/sync/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: stage.type }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error ?? stage.label + " failed");
        await pollPromise;
        return;
      }

      if (stage.type === "returns") {
        await runPaged("returns", { mode: "incremental" });
        return;
      }

      await runPaged("listings");
      for (const internalState of ["ACTIVE", "INACTIVE", "READY_FOR_ACTIVATION", "ARCHIVED", "INACTIVATED_BY_FLIPKART"] as const) {
        let batchNo = 0;
        let syncRunId: string | null = null;
        let hasMore = true;
        while (hasMore && !cancelled) {
          const response = await fetch("/api/flipkart/sync/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "product_search",
              internalState,
              batchNo,
              ...(syncRunId ? { syncRunId } : {}),
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error ?? stage.label + " failed");
          syncRunId = result.syncRunId ?? syncRunId;
          hasMore = Boolean(result.hasMore);
          batchNo = result.nextBatchNo ?? batchNo + 1;
          setSyncProgress({
            status: hasMore ? "running" : "success",
            elapsedSeconds: Math.floor((Date.now() - started) / 1000),
            estimatedTotalSeconds: 180,
            recordsWritten: result.recordsWritten ?? 0,
          });
        }
      }
    };

    (async () => {
      try {
        for (const stage of stages) {
          if (cancelled) return;
          await runStage(stage);
        }
        if (!cancelled) {
          setSyncMessage(syncing === "listings"
            ? "Catalogue sync complete: listings, inventory, pricing and product data reconciled."
            : "Fulfilment sync complete: orders, shipment details, tracking, returns and events reconciled.");
          window.location.reload();
        }
      } catch (error) {
        if (!cancelled) setSyncMessage(error instanceof Error ? error.message : "Sync failed");
      }
    })();

    return () => { cancelled = true; };
  }, [syncing]);

  async function runSync(type: "shipments" | "listings") {
    setSyncMessage(null);
    setSyncProgress({ status: "starting", elapsedSeconds: 0, estimatedTotalSeconds: 180, recordsWritten: 0 });
    setSyncStage(type);
    setSyncing(type);
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
            {active === "shipments" && <div className="table-card"><div className="table-toolbar"><span>Fulfilment queue</span><span>{filteredShipments.length} visible</span></div>{filteredShipments.length ? filteredShipments.map((s) => <div className="table-row" key={s.id}><div className="row-main"><span className="status-dot orange"/><div><strong>{s.flipkart_shipment_id ?? "Shipment"}</strong><small>{s.tracking_id ?? "Tracking pending"} · {s.courier_name ?? "Courier pending"}</small></div></div><span className="badge">{s.state?.replaceAll("_", " ") ?? "Unknown"}</span><span className="row-date">{date(s.dispatch_by)}</span></div>) : <div className="empty big">No shipments match your search.</div>}</div>}
            {active === "returns" && <div className="table-card">{props.returns.length ? props.returns.map((r) => <div className="table-row" key={r.id}><div className="row-main"><span className="status-dot orange"/><div><strong>{r.status ?? "Return"}</strong><small>{r.return_reason ?? "Reason not supplied"}</small></div></div><span className="badge">{date(r.created_at)}</span></div>) : <div className="empty big">No open returns. Your return desk is clear.</div>}</div>}
            {active === "sync" && <div className="table-card">{syncing && syncProgress && <div className="sync-progress"><div className="sync-progress-head"><span>{syncing === "shipments" ? "Syncing fulfilment" : "Syncing catalogue"}</span><span className="sync-progress-time">{formatDuration(syncProgress.elapsedSeconds)} elapsed</span></div><div className="sync-progress-track"><div className="sync-progress-bar" style={{ width: `${Math.min(95, Math.max(4, (syncProgress.elapsedSeconds / Math.max(1, syncProgress.estimatedTotalSeconds)) * 100))}%` }} /></div><div className="sync-progress-meta"><span>{syncProgress.recordsWritten.toLocaleString("en-IN")} records written</span><span>ETA ~ {formatDuration(Math.max(0, syncProgress.estimatedTotalSeconds - syncProgress.elapsedSeconds))}</span></div></div>}<div className="sync-actions"><button className="primary-button" disabled={Boolean(syncing)} onClick={() => runSync("shipments")}>{syncing === "shipments" ? "Syncing fulfilment..." : "Sync fulfilment"}</button><button className="text-button" disabled={Boolean(syncing)} onClick={() => runSync("listings")}>{syncing === "listings" ? "Syncing catalogue..." : "Sync catalogue"}</button>{syncMessage && <span className="sync-message">{syncMessage}</span>}</div>{props.syncRows.length ? props.syncRows.map((r) => <div className="table-row" key={r.id}><div className="row-main"><span className={"status-dot " + (r.status === "success" ? "green" : r.status === "failed" ? "red" : "orange")}/><div><strong>{r.sync_type.replaceAll("_", " ")}</strong><small>{date(r.finished_at ?? r.started_at)} · {r.records_written ?? 0} records</small></div></div><span className={"sync-status " + r.status}>{r.status}</span></div>) : <div className="empty big">No sync history yet.</div>}</div>}
            {active === "orders" && <div className="table-card"><div className="table-toolbar"><span>Order stream</span><span>{filteredOrders.length} records · page {orderPage} / {Math.max(1, Math.ceil(filteredOrders.length / pageSize))}</span></div>{visibleOrders.length ? visibleOrders.map((o) => <button className="table-row table-row-button" key={o.id} onClick={() => setSelectedOrderId(o.id)}><div className="row-main"><span className={"status-dot " + (o.status?.toLowerCase().includes("cancel") ? "red" : "green")}/><div><strong>{o.flipkart_order_id ?? "Order"}</strong><small>{o.status ?? "Status pending"}</small></div></div><span className="badge">{date(o.order_date)}</span><span className="row-arrow">↗</span></button>) : <div className="empty big">No orders match your search.</div>}</div>}
            {active === "listings" && <div className="table-card"><div className="table-toolbar"><span>Catalogue</span><span>{filteredListings.length} records · page {listingPage} / {Math.max(1, Math.ceil(filteredListings.length / pageSize))}</span></div>{visibleListings.length ? visibleListings.map((l) => <div className="table-row" key={l.id}><div className="row-main"><span className={"status-dot " + (l.status === "ACTIVE" ? "green" : "orange")}/><div><strong>{l.sku ?? "SKU pending"}</strong><small>{l.fsn ?? "FSN pending"} · {l.procurement_type ?? "Procurement pending"}</small></div></div><span className="badge">{l.status ?? "Unknown"}</span><span className="row-date">{l.shipping_provider ?? "Shipping provider pending"}</span></div>) : <div className="empty big">No listings match your search.</div>}</div>}
            {active === "settings" && <div className="settings-grid"><div className="card setting-card"><span className="setting-icon">◉</span><div><strong>Flipkart connection</strong><p>Authenticated seller API connection is configured server-side.</p></div><span className="badge good">Connected</span></div><div className="card setting-card"><span className="setting-icon">◌</span><div><strong>Data health</strong><p>Supabase is serving the seller workspace.</p></div><span className="badge good">Healthy</span></div></div>}
          </section>
        )}

        <footer className="footer-note">Seller Manager · Quiet by default. Powerful when needed.</footer>
      </main>

      {selectedOrderId && (() => { const order = props.orderDetails.find((o) => o.id === selectedOrderId); if (!order) return null; return <div className="drawer-backdrop" onClick={() => setSelectedOrderId(null)}><aside className="order-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">Order cockpit</span><h2>{order.flipkart_order_id}</h2><p>{date(order.order_date)} · {order.status ?? "Status pending"}</p></div><button className="drawer-close" onClick={() => setSelectedOrderId(null)}>×</button></div><div className="drawer-section"><div className="drawer-label">Order status</div><span className={"badge " + (order.status?.toLowerCase().includes("cancel") ? "" : "good")}>{order.status ?? "Unknown"}</span></div><div className="drawer-section"><div className="drawer-section-head"><div className="drawer-label">Items</div><span>{order.items.length}</span></div>{order.items.length ? order.items.map((i) => <div className="drawer-item" key={i.id}><div><strong>{i.sku ?? i.fsn ?? "Item"}</strong><small>{i.flipkart_order_item_id} · Qty {i.quantity ?? 0}</small></div><span>{i.customer_price != null ? "₹" + Number(i.customer_price).toLocaleString("en-IN") : "Price pending"}</span></div>) : <div className="drawer-empty">No order items captured.</div>}</div><div className="drawer-section"><div className="drawer-section-head"><div className="drawer-label">Fulfilment</div><span>{order.shipments.length}</span></div>{order.shipments.length ? order.shipments.map((s) => <div className="shipment-cockpit" key={s.id}><div className="shipment-top"><div><strong>{s.flipkart_shipment_id}</strong><small>{s.state?.replaceAll("_"," ") ?? "State pending"} · {s.courier_name ?? "Courier pending"}</small></div><span className={s.hold ? "badge warn" : "badge good"}>{s.hold ? "On hold" : "Moving"}</span></div><div className="shipment-meta"><span>Dispatch by <b>{date(s.dispatch_by)}</b></span><span>{s.tracking_id ?? "Tracking pending"}</span></div>{s.events.length ? <div className="timeline">{s.events.map((e) => <div className="timeline-row" key={e.id}><i/><div><strong>{e.event_type.replaceAll("_"," ")}</strong><small>{date(e.event_timestamp)}{e.source ? " · " + e.source : ""}</small></div></div>)}</div> : <div className="drawer-empty">No shipment events captured yet.</div>}</div>) : <div className="drawer-empty">No shipment is linked to this order yet.</div>}</div></aside></div>; })()}      {commandOpen && <div className="command-backdrop" onClick={() => setCommandOpen(false)}><div className="command" onClick={(e) => e.stopPropagation()}><div className="command-head"><span>Quick actions</span><button onClick={() => setCommandOpen(false)}>Esc</button></div><button onClick={() => { setActive("shipments"); setCommandOpen(false); }}>→ Open fulfilment queue</button><button onClick={() => { setActive("returns"); setCommandOpen(false); }}>↺ Review returns</button><button onClick={() => { setActive("sync"); setCommandOpen(false); }}>◌ Inspect sync health</button><button onClick={() => { setActive("listings"); setCommandOpen(false); }}>◈ Open catalogue</button><button onClick={() => { setActive("orders"); setCommandOpen(false); }}>▦ Open orders</button></div></div>}
    </div>
  );
}
