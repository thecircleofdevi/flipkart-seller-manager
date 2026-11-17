import { createClient } from "@/lib/supabase/server";

const metricTables = [
  { label: "Listings", table: "listings", icon: "◈", caption: "catalogue items" },
  { label: "Orders", table: "orders", icon: "⌁", caption: "orders captured" },
  { label: "Shipments", table: "shipments", icon: "→", caption: "fulfilment records" },
  { label: "Returns", table: "returns", icon: "↺", caption: "return records" },
  { label: "Notifications", table: "notifications", icon: "•", caption: "events received" },
] as const;

type TableName = typeof metricTables[number]["table"];

async function countRows(supabase: Awaited<ReturnType<typeof createClient>>, table: TableName) {
  const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
  return { count: count ?? 0, error };
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function initials(email: string | undefined) {
  return (email?.slice(0, 2) || "SM").toUpperCase();
}

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return (
      <main className="main" style={{ marginLeft: 0, minHeight: "100vh", display: "grid", placeItems: "center" }}>
        <div className="card" style={{ maxWidth: 420, width: "100%" }}>
          <div className="brand-mark">FK</div>
          <h1 style={{ fontSize: 28 }}>Seller Manager</h1>
          <p className="subtitle">Sign in to view your Flipkart operations workspace.</p>
        </div>
      </main>
    );
  }

  const [metricResults, recentSyncs, openReturns, activeShipments, inventory] = await Promise.all([
    Promise.all(metricTables.map(({ table }) => countRows(supabase, table))),
    supabase.from("sync_runs").select("id,sync_type,status,started_at,finished_at,records_written,error_message").order("started_at", { ascending: false }).limit(5),
    supabase.from("returns").select("id,status,return_reason,created_at").in("status", ["CREATED", "created", "OPEN", "open"]).order("created_at", { ascending: false }).limit(4),
    supabase.from("shipments").select("id,flipkart_shipment_id,state,dispatch_by,tracking_id,courier_name").in("state", ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]).order("dispatch_by", { ascending: true }).limit(4),
    supabase.from("listing_inventory").select("id,quantity").order("quantity", { ascending: true }).limit(8),
  ]);

  const failed = [...metricResults, { error: recentSyncs.error }].some((result) => result.error);
  const syncRows = recentSyncs.data ?? [];
  const syncSuccess = syncRows.filter((row) => row.status === "success").length;
  const lowStock = (inventory.data ?? []).filter((row) => (row.quantity ?? 0) <= 3).length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">FK</div>
          <div>
            <div className="brand-name">Seller Manager</div>
            <div className="brand-sub">Operations workspace</div>
          </div>
        </div>

        <div className="nav-label">Workspace</div>
        <button className="nav-item active"><span className="nav-icon">⌂</span><span>Overview</span></button>
        <button className="nav-item"><span className="nav-icon">▦</span><span>Orders</span></button>
        <button className="nav-item"><span className="nav-icon">→</span><span>Shipments</span></button>
        <button className="nav-item"><span className="nav-icon">◈</span><span>Listings</span></button>
        <button className="nav-item"><span className="nav-icon">↺</span><span>Returns</span></button>

        <div className="nav-label">System</div>
        <button className="nav-item"><span className="nav-icon">◌</span><span>Sync centre</span></button>
        <button className="nav-item"><span className="nav-icon">⚙</span><span>Settings</span></button>

        <div className="sidebar-footer">
          <div className="user-pill">
            <div className="avatar">{initials(user.email)}</div>
            <div className="user-meta">
              <div className="user-email">{user.email ?? "Seller account"}</div>
              <div className="user-role">Connected account</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="eyebrow">Seller operations</div>
            <h1>Good morning.</h1>
            <p className="subtitle">A calm view of everything that needs your attention.</p>
          </div>
          <div className="top-actions">
            <input className="search" placeholder="Search SKU, order, shipment…" aria-label="Search" />
            <button className="icon-button" aria-label="Refresh">↻</button>
            <button className="primary-button">New action</button>
          </div>
        </header>

        <section className="hero">
          <div className="hero-grid">
            <div>
              <div className="eyebrow" style={{ color: "rgba(255,255,255,.45)" }}>Control centre</div>
              <h2>Your marketplace, at a glance.</h2>
              <p>Orders, fulfilment, catalogue health and seller events brought into one focused workspace. No clutter. Just the signals that matter.</p>
            </div>
            <div className="hero-kpis">
              <div className="hero-kpi"><div className="value">{syncSuccess}/{syncRows.length || 0}</div><div className="label">recent syncs healthy</div></div>
              <div className="hero-kpi"><div className="value">{lowStock}</div><div className="label">low stock items</div></div>
              <div className="hero-kpi"><div className="value">{failed ? "Check" : "Healthy"}</div><div className="label">system status</div></div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="section-head">
            <h2 className="section-title">Workspace</h2>
            <span className="section-note">Live Supabase snapshot</span>
          </div>
          <div className="stats">
            {metricTables.map(({ label, icon, caption }, index) => (
              <article className="card" key={label}>
                <div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div>
                <div className="stat-value">{metricResults[index].count}</div>
                <div className="stat-caption">{caption}</div>
              </article>
            ))}
          </div>
        </section>

        <section className="section grid-2">
          <article className="card">
            <div className="section-head">
              <h2 className="section-title">Needs attention</h2>
              <span className="section-note">Prioritised for you</span>
            </div>
            <div className="queue-list">
              <div className="queue-row">
                <div className="queue-left"><span className={lowStock ? "status-dot orange" : "status-dot green"}></span><div><div className="queue-name">{lowStock ? "Review " + lowStock + " low-stock item" + (lowStock === 1 ? "" : "s") : "Inventory looks healthy"}</div><div className="queue-meta">Keep fast-moving catalogue items available.</div></div></div>
                <span className={lowStock ? "badge warn" : "badge good"}>{lowStock ? "Review" : "Good"}</span>
              </div>
              <div className="queue-row">
                <div className="queue-left"><span className={(openReturns.data?.length ?? 0) ? "status-dot orange" : "status-dot green"}></span><div><div className="queue-name">{openReturns.data?.length ?? 0} open return records</div><div className="queue-meta">Review customer and courier returns.</div></div></div>
                <span className={(openReturns.data?.length ?? 0) ? "badge warn" : "badge good"}>{(openReturns.data?.length ?? 0) ? "Review" : "Clear"}</span>
              </div>
              <div className="queue-row">
                <div className="queue-left"><span className={failed ? "status-dot red" : "status-dot green"}></span><div><div className="queue-name">{failed ? "A system check needs attention" : "Data connections are healthy"}</div><div className="queue-meta">Database and recent sync visibility.</div></div></div>
                <span className={failed ? "badge" : "badge good"}>{failed ? "Check" : "Healthy"}</span>
              </div>
              <div className="queue-row">
                <div className="queue-left"><span className={(activeShipments.data?.length ?? 0) ? "status-dot orange" : "status-dot green"}></span><div><div className="queue-name">{activeShipments.data?.length ?? 0} shipments in fulfilment</div><div className="queue-meta">Approved, packing or ready to dispatch.</div></div></div>
                <span className="badge">{(activeShipments.data?.length ?? 0) ? "Open" : "Quiet"}</span>
              </div>
            </div>
          </article>

          <article className="card sync-card">
            <div className="section-head">
              <h2 className="section-title">Sync centre</h2>
              <span className="section-note">Latest runs</span>
            </div>
            {syncRows.length ? syncRows.map((row) => (
              <div className="sync-row" key={row.id}>
                <div><div className="sync-type">{row.sync_type.replaceAll("_", " ")}</div><div className="sync-time">{formatDate(row.finished_at ?? row.started_at)} · {row.records_written ?? 0} written</div></div>
                <span className={row.status === "success" ? "sync-status success" : row.status === "failed" ? "sync-status failed" : "sync-status running"}>{row.status}</span>
              </div>
            )) : <div className="empty">No sync runs yet. Once data starts flowing, this becomes your operational heartbeat.</div>}
          </article>
        </section>

        <section className="section grid-2">
          <article className="card">
            <div className="section-head">
              <h2 className="section-title">Fulfilment queue</h2>
              <span className="section-note">Next dispatch windows</span>
            </div>
            {activeShipments.data?.length ? activeShipments.data.map((shipment) => (
              <div className="queue-row" key={shipment.id}>
                <div className="queue-left"><span className="status-dot orange"></span><div><div className="queue-name">{shipment.flipkart_shipment_id}</div><div className="queue-meta">{shipment.state?.replaceAll("_", " ")} · {shipment.courier_name ?? "Courier pending"}</div></div></div>
                <span className="badge">{formatDate(shipment.dispatch_by)}</span>
              </div>
            )) : <div className="empty">No active fulfilment items are currently waiting for attention.</div>}
          </article>

          <article className="card">
            <div className="section-head">
              <h2 className="section-title">Return desk</h2>
              <span className="section-note">Latest open returns</span>
            </div>
            {openReturns.data?.length ? openReturns.data.map((item) => (
              <div className="queue-row" key={item.id}>
                <div className="queue-left"><span className="status-dot orange"></span><div><div className="queue-name">{item.status}</div><div className="queue-meta">{item.return_reason ?? "Reason not supplied"}</div></div></div>
                <span className="badge">{formatDate(item.created_at)}</span>
              </div>
            )) : <div className="empty">No open returns. Your return desk is clear.</div>}
          </article>
        </section>

        <div className="footer-note">Flipkart Seller Manager · Built for clarity, speed and control.</div>
      </main>
    </div>
  );
}
