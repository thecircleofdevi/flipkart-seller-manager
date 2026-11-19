"use client";

import { useMemo, useState } from "react";

type OtcData = Record<string, unknown> | null;

function pick(data: OtcData, keys: string[]) {
  if (!data) return null;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export default function ReturnOtcPanel() {
  const [locationId, setLocationId] = useState("");
  const [task, setTask] = useState<OtcData>(null);
  const [start, setStart] = useState<OtcData>(null);
  const [shipments, setShipments] = useState<OtcData>(null);
  const [end, setEnd] = useState<OtcData>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const taskId = useMemo(() => pick(task, ["taskId", "task_id"]), [task]);
  const feId = useMemo(() => pick(start ?? task, ["feId", "fe_id", "fieldExecutiveId"]), [start, task]);
  const shipmentCount = useMemo(() => {
    if (!shipments) return 0;
    const candidates = [shipments.shipments, shipments.data, shipments.items];
    for (const value of candidates) if (Array.isArray(value)) return value.length;
    return Number(shipments.count ?? 0) || 0;
  }, [shipments]);

  async function call(action: string, body: Record<string, unknown>) {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch("/api/flipkart/returns/otc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Return OTC action failed.");
      return result.data as OtcData;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Return OTC action failed.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function initialLoad() {
    if (!locationId.trim()) {
      setMessage("Seller location ID is required.");
      return;
    }
    const data = await call("initialLoad", { sellerLocationId: locationId.trim() });
    if (data) setTask(data);
  }

  async function startOtc() {
    if (!locationId.trim() || !taskId) {
      setMessage("Run initial load first and confirm a task ID is returned.");
      return;
    }
    const data = await call("start", { sellerLocationId: locationId.trim() });
    if (data) setStart(data);
  }

  async function loadShipments() {
    if (!taskId || !feId) {
      setMessage("Start OTC first and confirm task and FE IDs.");
      return;
    }
    const data = await call("shipments", { taskId, feId, pageSize: 25 });
    if (data) setShipments(data);
  }

  async function endOtc() {
    if (!taskId || !feId) {
      setMessage("Task and FE IDs are required before ending OTC.");
      return;
    }
    const data = await call("end", { taskId, feId });
    if (data) setEnd(data);
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head">
        <h3 className="section-title">Return OTC</h3>
        <span className="section-note">Physical return handover workflow</span>
      </div>
      <p className="sync-message">This is intentionally stateful. Do not skip directly to End OTC.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <input
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="Seller location ID"
          aria-label="Seller location ID"
          style={{ minWidth: 220 }}
        />
        <button className="text-button" disabled={Boolean(busy)} onClick={initialLoad}>{busy === "initialLoad" ? "Loading..." : "1. Initial load"}</button>
        <button className="text-button" disabled={Boolean(busy) || !taskId} onClick={startOtc}>{busy === "start" ? "Starting..." : "2. Start OTC"}</button>
        <button className="text-button" disabled={Boolean(busy) || !feId} onClick={loadShipments}>{busy === "shipments" ? "Loading..." : "3. Load shipments"}</button>
        <button className="text-button" disabled={Boolean(busy) || !feId} onClick={endOtc}>{busy === "end" ? "Ending..." : "4. End OTC"}</button>
      </div>
      {message && <div className="sync-message" style={{ marginTop: 10 }}>{message}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8, marginTop: 14 }}>
        <div className="badge">Task: {taskId ?? "not loaded"}</div>
        <div className="badge">FE: {feId ?? "not loaded"}</div>
        <div className="badge">Shipments loaded: {shipmentCount}</div>
        <div className={end ? "badge good" : "badge"}>OTC ended: {end ? "yes" : "no"}</div>
      </div>
      {(task || start || shipments || end) && (
        <details style={{ marginTop: 14 }}>
          <summary>Raw OTC response</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", fontSize: 12 }}>
            {JSON.stringify({ task, start, shipments, end }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
