"use client";

import { useMemo, useState } from "react";

type OtcData = Record<string, unknown> | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function entries(data: unknown) {
  const record = asRecord(data);
  return record ? Object.entries(record) : [];
}

export default function ReturnOtcPanel() {
  const [locationId, setLocationId] = useState("");
  const [task, setTask] = useState<OtcData>(null);
  const [start, setStart] = useState<OtcData>(null);
  const [shipments, setShipments] = useState<OtcData>(null);
  const [end, setEnd] = useState<OtcData>(null);
  const [selectedFeId, setSelectedFeId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const feDetails = useMemo(() => {
    const record = asRecord(task?.feDetails);
    return record ? Object.entries(record).map(([feId, value]) => ({ feId, detail: asRecord(value) })) : [];
  }, [task]);

  const startDetails = useMemo(() => {
    const record = asRecord(start?.otcDetails);
    return record ? Object.entries(record).map(([feId, value]) => ({ feId, detail: asRecord(value) })) : [];
  }, [start]);

  const activeFeId = selectedFeId || startDetails[0]?.feId || feDetails[0]?.feId || "";
  const activeTaskId = stringValue(startDetails.find((x) => x.feId === activeFeId)?.detail?.taskId)
    || stringValue(feDetails.find((x) => x.feId === activeFeId)?.detail?.task?.id);
  const startOtc = stringValue(startDetails.find((x) => x.feId === activeFeId)?.detail?.otc);

  const shipmentCount = useMemo(() => {
    const value = shipments?.scannedShipments;
    return Array.isArray(value) ? value.length : 0;
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
    if (data) {
      setTask(data);
      setStart(null);
      setShipments(null);
      setEnd(null);
      const firstFe = asRecord(data.feDetails);
      const firstId = firstFe ? Object.keys(firstFe)[0] : "";
      setSelectedFeId(firstId);
    }
  }

  async function startOtc() {
    if (!locationId.trim()) {
      setMessage("Seller location ID is required.");
      return;
    }
    const data = await call("start", { sellerLocationId: locationId.trim() });
    if (data) {
      setStart(data);
      setShipments(null);
      setEnd(null);
      const firstOtc = asRecord(data.otcDetails);
      const firstId = selectedFeId || (firstOtc ? Object.keys(firstOtc)[0] : "");
      setSelectedFeId(firstId);
    }
  }

  async function loadShipments() {
    if (!activeTaskId || !activeFeId) {
      setMessage("Select a field executive with a task before loading shipments.");
      return;
    }
    const data = await call("shipments", { taskId: activeTaskId, feId: activeFeId, pageSize: 25 });
    if (data) setShipments(data);
  }

  async function loadNextPage() {
    const nextUrl = stringValue(shipments?.nextUrl);
    if (!nextUrl) return;
    setBusy("next");
    setMessage(null);
    try {
      const response = await fetch("/api/flipkart/returns/otc?nextUrl=" + encodeURIComponent(nextUrl));
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error ?? "Could not load next shipment page.");
      const next = asRecord(result.data);
      if (next) {
        setShipments({
          ...shipments,
          ...next,
          scannedShipments: [
            ...(Array.isArray(shipments?.scannedShipments) ? shipments.scannedShipments : []),
            ...(Array.isArray(next.scannedShipments) ? next.scannedShipments : []),
          ],
        });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load next shipment page.");
    } finally {
      setBusy(null);
    }
  }

  async function endOtc() {
    if (!activeTaskId || !activeFeId) {
      setMessage("Select a field executive with an active task before ending OTC.");
      return;
    }
    const data = await call("end", { taskId: activeTaskId, feId: activeFeId });
    if (data) setEnd(data);
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-head">
        <h3 className="section-title">Return OTC</h3>
        <span className="section-note">Physical return handover workflow</span>
      </div>
      <p className="sync-message">Workflow follows Flipkart's Initial Load → Start OTC → Scan/Poll → End OTC sequence.</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <input
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          placeholder="Seller location ID"
          aria-label="Seller location ID"
          style={{ minWidth: 220 }}
        />
        <button className="text-button" disabled={Boolean(busy)} onClick={initialLoad}>{busy === "initialLoad" ? "Loading..." : "1. Initial load"}</button>
        <button className="text-button" disabled={Boolean(busy) || !locationId.trim()} onClick={startOtc}>{busy === "start" ? "Starting..." : "2. Start OTC"}</button>
      </div>

      {feDetails.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Field executive</label>
          <select value={activeFeId} onChange={(e) => setSelectedFeId(e.target.value)} disabled={Boolean(busy)}>
            {feDetails.map(({ feId, detail }) => (
              <option key={feId} value={feId}>
                {stringValue(detail?.feName) || feId} ({feId})
              </option>
            ))}
          </select>
        </div>
      )}

      {startOtc && <div className="badge good" style={{ marginTop: 10 }}>Start OTC: {startOtc}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button className="text-button" disabled={Boolean(busy) || !activeTaskId || !activeFeId} onClick={loadShipments}>{busy === "shipments" ? "Loading..." : "3. Load scanned shipments"}</button>
        <button className="text-button" disabled={Boolean(busy) || !shipments?.nextUrl} onClick={loadNextPage}>{busy === "next" ? "Loading..." : "Load next page"}</button>
        <button className="text-button" disabled={Boolean(busy) || !activeTaskId || !activeFeId} onClick={endOtc}>{busy === "end" ? "Ending..." : "4. End OTC"}</button>
      </div>

      {message && <div className="sync-message" style={{ marginTop: 10 }}>{message}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8, marginTop: 14 }}>
        <div className="badge">Task: {activeTaskId || "not loaded"}</div>
        <div className="badge">FE: {activeFeId || "not loaded"}</div>
        <div className="badge">Shipments scanned: {shipmentCount}</div>
        <div className={end ? "badge good" : "badge"}>End OTC: {end ? "generated" : "not generated"}</div>
      </div>

      {end && (
        <div className="sync-message" style={{ marginTop: 10 }}>
          End OTC: {stringValue(end.otc) || "generated"} · total scanned {String(end.totalScanned ?? 0)} · OBD eligible {String(end.obdEligible ?? 0)} · flyer eligible {String(end.flyerEligible ?? 0)}
        </div>
      )}

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
