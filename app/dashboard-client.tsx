"use client";

import { useMemo, useState } from "react";

type NavKey = "overview" | "orders" | "shipments" | "listings" | "returns" | "sync" | "settings";

type Props = {
  userEmail: string;
  metrics: { label: string; value: number; caption: string; icon: string }[];
  syncRows: { id: string; sync_type: string; status: string; started_at: string; finished_at: string | null; records_written: number | null; error_message: string | null }[];
  returns: { id: string; status: string | null; return_reason: string | null; created_at: string | null }[];
  shipments: { id: string; flipkart_shipment_id: string | null; state: string | null; dispatch_by: string | null; tracking_id: string | null; courier_name: string | null }[];
  lowStock: number;
  systemHealthy: boolean;
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

function initials(email: string) {
  return (email.slice(0, 2) || "SM").toUpperCase();
}

export default function DashboardClient(props: Props) {
  const [active, setActive] = useState<NavKey>("overview");
  const [query, setQuery] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);

  const filteredShipments = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.shipments;
    return props.shipments.filter((s) => [s.flipkart_shipment_id, s.state, s.tracking_id, s.courier_name].some((v) => v?.toLowerCase().includes(q)));
  }, [query, props.shipments]);

  const title = nav.find((item) => item.id === active)?.label ?? "Overview";

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
              <div className="stats">{props.metrics.map((m) => <button className="card stat-card" key={m.label} onClick={() => setActive(m.label.toLowerCase() as NavKey)}><div className="stat-top"><span>{m.label}</span><span className="stat-icon">{m.icon}</span></div><div className="stat-value">{m.value}</div><div className="stat-caption">{m.caption}</div><span className="card-arrow">↗</span></button>)}</div>
            </section>

            <section className="section grid-2">
              <article className="card">
                <div className="section-head"><h2 className="section-title">Needs attention</h2><span className="section-note">Prioritised for you</span></div>
                <div className="queue-list">
                  <div className="queue-row"><div className="queue-left"><span className={props.lowStock ? "status-dot orange" : "status-dot green"} /><div><div className="queue-name">{props.lowStock ? "Review " + props.lowStock + " low-stock item" + (props.lowStock === 1 ? "" : "s") : "Inventory looks healthy"}</div><div className="queue-meta">Protect availability on fast-moving catalogue items.</div></div></div><span className={props.lowStock ? "badge warn" : "badge good"}>{props.lowStock ? "Review" : "Good"}</span></div>
                  <div className="queue-row"><div className="queue-left"><span className={props.returns.length ? "status-dot orange" : "status-dot green"} /><div><div className="queue-name">{props.returns.length} open return records</div><div className="queue-meta">Customer and courier returns.</div></div></div><span className={props.returns.length ? "badge warn" : "badge good"}>{props.returns.length ? "Review" : "Clear"}</span></div>
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
            {active === "sync" && <div className="table-card">{props.syncRows.length ? props.syncRows.map((r) => <div className="table-row" key={r.id}><div className="row-main"><span className={"status-dot " + (r.status === "success" ? "green" : r.status === "failed" ? "red" : "orange")}/><div><strong>{r.sync_type.replaceAll("_", " ")}</strong><small>{date(r.finished_at ?? r.started_at)} · {r.records_written ?? 0} records</small></div></div><span className={"sync-status " + r.status}>{r.status}</span></div>) : <div className="empty big">No sync history yet.</div>}</div>}
            {active === "orders" && <div className="empty-state"><div className="empty-orb">▦</div><h3>Orders, next.</h3><p>The data layer is ready. This workspace will become the detailed order cockpit with search, status lanes and contextual actions.</p></div>}
            {active === "listings" && <div className="empty-state"><div className="empty-orb">◈</div><h3>Catalogue control.</h3><p>Listings are already syncing. The next layer is a high-density catalogue view with inventory, pricing and listing health.</p></div>}
            {active === "settings" && <div className="settings-grid"><div className="card setting-card"><span className="setting-icon">◉</span><div><strong>Flipkart connection</strong><p>Authenticated seller API connection is configured server-side.</p></div><span className="badge good">Connected</span></div><div className="card setting-card"><span className="setting-icon">◌</span><div><strong>Data health</strong><p>Supabase is serving the seller workspace.</p></div><span className="badge good">Healthy</span></div></div>}
          </section>
        )}

        <footer className="footer-note">Seller Manager · Quiet by default. Powerful when needed.</footer>
      </main>

      {commandOpen && <div className="command-backdrop" onClick={() => setCommandOpen(false)}><div className="command" onClick={(e) => e.stopPropagation()}><div className="command-head"><span>Quick actions</span><button onClick={() => setCommandOpen(false)}>Esc</button></div><button onClick={() => { setActive("shipments"); setCommandOpen(false); }}>→ Open fulfilment queue</button><button onClick={() => { setActive("returns"); setCommandOpen(false); }}>↺ Review returns</button><button onClick={() => { setActive("sync"); setCommandOpen(false); }}>◌ Inspect sync health</button><button onClick={() => { setActive("listings"); setCommandOpen(false); }}>◈ Open catalogue</button></div></div>}
    </div>
  );
}
