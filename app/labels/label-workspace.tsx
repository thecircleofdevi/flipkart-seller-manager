"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/client";

type Preset = {
  id: string;
  name: string;
  page_width_pt: number;
  page_height_pt: number;
  crop_x_pt: number;
  crop_y_pt: number;
  crop_width_pt: number;
  crop_height_pt: number;
  output_width_pt: number;
  output_height_pt: number;
  is_default: boolean;
};

type PdfItem = {
  id: string;
  file: File;
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
};

const OUTPUT_W = 288;
const OUTPUT_H = 432;
const DEFAULT_PRESET_NAME = "Flipkart 4×6 Thermal";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function pageBox(item: PdfItem) {
  return {
    x: Math.max(0, item.pageWidth * 0.08),
    y: Math.max(0, item.pageHeight * 0.08),
    width: Math.min(item.pageWidth * 0.84, item.pageHeight * 2 / 3),
    height: Math.min(item.pageHeight * 0.84, item.pageWidth * 3 / 2),
  };
}

export default function LabelWorkspace() {
  const [items, setItems] = useState<PdfItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState(DEFAULT_PRESET_NAME);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const selected = items[selectedIndex] ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await (supabase as any)
        .from("label_crop_presets")
        .select("id,name,page_width_pt,page_height_pt,crop_x_pt,crop_y_pt,crop_width_pt,crop_height_pt,output_width_pt,output_height_pt,is_default")
        .order("is_default", { ascending: false })
        .order("updated_at", { ascending: false });
      if (!cancelled && data) {
        setPresets(data as Preset[]);
        const defaultPreset = (data as Preset[]).find((p) => p.is_default);
        if (defaultPreset) setSelectedPresetId(defaultPreset.id);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const saved = selectedPresetId ? presets.find((p) => p.id === selectedPresetId) : null;
    if (saved && Math.abs(saved.page_width_pt - selected.pageWidth) < 2 && Math.abs(saved.page_height_pt - selected.pageHeight) < 2) {
      setCrop({
        x: clamp(saved.crop_x_pt, 0, selected.pageWidth),
        y: clamp(saved.crop_y_pt, 0, selected.pageHeight),
        width: clamp(saved.crop_width_pt, 1, selected.pageWidth),
        height: clamp(saved.crop_height_pt, 1, selected.pageHeight),
      });
      return;
    }
    setCrop(pageBox(selected));
  }, [selectedIndex, selected?.pageWidth, selected?.pageHeight, selectedPresetId, presets]);

  const pageUrl = useMemo(() => selected ? URL.createObjectURL(selected.file) : null, [selected]);
  useEffect(() => () => { if (pageUrl) URL.revokeObjectURL(pageUrl); }, [pageUrl]);

  const cropAspect = crop.height ? crop.width / crop.height : 2 / 3;
  const isThermalRatio = Math.abs(cropAspect - 2 / 3) < 0.02;
  const pageDisplay = useMemo((): { width: number; height: number; scale: number } => {
    if (!selected) return { width: 1, height: 1, scale: 1 };
    const maxW = 720;
    const scale = Math.min(1, maxW / selected.pageWidth);
    return { width: selected.pageWidth * scale, height: selected.pageHeight * scale, scale };
  }, [selected]);

  function updateCrop(partial: Partial<typeof crop>) {
    if (!selected) return;
    const next = { ...crop, ...partial };
    const width = clamp(next.width, 1, selected.pageWidth - next.x);
    const height = clamp(next.height, 1, selected.pageHeight - next.y);
    setCrop({
      x: clamp(next.x, 0, selected.pageWidth - width),
      y: clamp(next.y, 0, selected.pageHeight - height),
      width,
      height,
    });
  }

  function setCropField(key: keyof typeof crop, raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    if (key === "width") {
      updateCrop({ width: value, height: value * 1.5 });
      return;
    }
    if (key === "height") {
      updateCrop({ height: value, width: value / 1.5 });
      return;
    }
    updateCrop({ [key]: value });
  }

  async function loadFiles(fileList: FileList | null) {
    if (!fileList) return;
    setBusy(true);
    setMessage(null);
    try {
      const next: PdfItem[] = [];
      for (const file of Array.from(fileList)) {
        if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) continue;
        const bytes = await file.arrayBuffer();
        const pdf = await PDFDocument.load(bytes);
        const page = pdf.getPages()[0];
        if (!page) continue;
        const size = page.getSize();
        next.push({
          id: crypto.randomUUID(),
          file,
          pageCount: pdf.getPageCount(),
          pageWidth: size.width,
          pageHeight: size.height,
        });
      }
      setItems((current) => [...current, ...next]);
      if (next.length) setSelectedIndex(items.length);
      setMessage(next.length ? `${next.length} PDF${next.length === 1 ? "" : "s"} loaded. Review the crop and save it as a preset.` : "No PDF files were loaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to read the PDF.");
    } finally {
      setBusy(false);
    }
  }

  function pointerDown(event: React.PointerEvent) {
    if (!selected || !pageRef.current) return;
    const rect = pageRef.current.getBoundingClientRect();
    const sx = selected.pageWidth / rect.width;
    const sy = selected.pageHeight / rect.height;
    setDrag({
      dx: (event.clientX - rect.left) * sx - crop.x,
      dy: (event.clientY - rect.top) * sy - crop.y,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: React.PointerEvent) {
    if (!drag || !selected || !pageRef.current) return;
    const rect = pageRef.current.getBoundingClientRect();
    const sx = selected.pageWidth / rect.width;
    const sy = selected.pageHeight / rect.height;
    updateCrop({
      x: (event.clientX - rect.left) * sx - drag.dx,
      y: (event.clientY - rect.top) * sy - drag.dy,
    });
  }

  function pointerUp() {
    setDrag(null);
  }

  async function savePreset() {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("You are not signed in.");
      const name = presetName.trim() || DEFAULT_PRESET_NAME;
      const { data, error } = await (supabase as any)
        .from("label_crop_presets")
        .insert({
          user_id: user.id,
          name,
          page_width_pt: selected.pageWidth,
          page_height_pt: selected.pageHeight,
          crop_x_pt: crop.x,
          crop_y_pt: crop.y,
          crop_width_pt: crop.width,
          crop_height_pt: crop.height,
          output_width_pt: OUTPUT_W,
          output_height_pt: OUTPUT_H,
          is_default: true,
        })
        .select("id,name,page_width_pt,page_height_pt,crop_x_pt,crop_y_pt,crop_width_pt,crop_height_pt,output_width_pt,output_height_pt,is_default")
        .single();
      if (error) throw error;

      await (supabase as any).from("label_crop_presets").update({ is_default: false }).eq("user_id", user.id).neq("id", data.id);
      setPresets((current) => [data as Preset, ...current.map((p) => ({ ...p, is_default: false }))]);
      setSelectedPresetId(data.id);
      setMessage(`Preset “${name}” saved and set as default.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save preset.");
    } finally {
      setBusy(false);
    }
  }

  async function makeCroppedPdf(file: File) {
    const sourceBytes = await file.arrayBuffer();
    const source = await PDFDocument.load(sourceBytes);
    const output = await PDFDocument.create();
    const pages = source.getPages();

    for (const sourcePage of pages) {
      const embedded = await output.embedPage(sourcePage);
      const sourceSize = sourcePage.getSize();
      const cropX = clamp(crop.x, 0, sourceSize.width);
      const cropYTop = clamp(crop.y, 0, sourceSize.height);
      const cropW = clamp(crop.width, 1, sourceSize.width - cropX);
      const cropH = clamp(crop.height, 1, sourceSize.height - cropYTop);
      const cropYBottom = sourceSize.height - cropYTop - cropH;
      const page = output.addPage([OUTPUT_W, OUTPUT_H]);
      page.drawPage(embedded, {
        x: -cropX * OUTPUT_W / cropW,
        y: -cropYBottom * OUTPUT_H / cropH,
        width: sourceSize.width * OUTPUT_W / cropW,
        height: sourceSize.height * OUTPUT_H / cropH,
      });
    }

    output.setTitle("Flipkart 4×6 Thermal Labels");
    output.setSubject("Cropped shipping labels prepared for 4×6 thermal printing");
    return output.save({ useObjectStreams: true });
  }

  async function processAll() {
    if (!items.length || !selected) return;
    setBusy(true);
    setMessage("Preparing cropped 4×6 labels...");
    try {
      const output = await PDFDocument.create();
      for (const item of items) {
        const source = await PDFDocument.load(await item.file.arrayBuffer());
        for (const sourcePage of source.getPages()) {
          const embedded = await output.embedPage(sourcePage);
          const sourceSize = sourcePage.getSize();
          const cropX = clamp(crop.x, 0, sourceSize.width);
          const cropYTop = clamp(crop.y, 0, sourceSize.height);
          const cropW = clamp(crop.width, 1, sourceSize.width - cropX);
          const cropH = clamp(crop.height, 1, sourceSize.height - cropYTop);
          const cropYBottom = sourceSize.height - cropYTop - cropH;
          const page = output.addPage([OUTPUT_W, OUTPUT_H]);
          page.drawPage(embedded, {
            x: -cropX * OUTPUT_W / cropW,
            y: -cropYBottom * OUTPUT_H / cropH,
            width: sourceSize.width * OUTPUT_W / cropW,
            height: sourceSize.height * OUTPUT_H / cropH,
          });
        }
      }
      const bytes = await output.save({ useObjectStreams: true });
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), `flipkart-labels-${items.length}.pdf`);
      setMessage(`${items.length} source PDF${items.length === 1 ? "" : "s"} processed into 4×6 label pages.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to process labels.");
    } finally {
      setBusy(false);
    }
  }

  async function processCurrent() {
    if (!selected) return;
    setBusy(true);
    try {
      const bytes = await makeCroppedPdf(selected.file);
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), `${selected.file.name.replace(/\.pdf$/i, "")}-4x6.pdf`);
      setMessage("Current PDF cropped to 4×6 pages.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to process this label.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="label-workspace">
      <div className="label-head">
        <div>
          <span className="eyebrow">Shipping documents</span>
          <h2>Label Workspace</h2>
          <p>Prepare Flipkart shipping PDFs for a 4×6 thermal printer. The output contains only the label area.</p>
        </div>
        <label className="primary-button label-upload">
          {busy ? "Working..." : "Add PDF labels"}
          <input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => loadFiles(e.target.files)} disabled={busy} />
        </label>
      </div>

      {message && <div className="label-message">{message}</div>}

      <div className="label-layout">
        <aside className="label-sidebar">
          <div className="label-panel">
            <div className="label-panel-title">Batch</div>
            <div className="label-count">{items.length}<span>PDFs loaded</span></div>
            {items.length ? <div className="label-file-list">{items.map((item, index) => (
              <button key={item.id} className={"label-file " + (index === selectedIndex ? "active" : "")} onClick={() => setSelectedIndex(index)}>
                <span>{index + 1}</span>
                <div><strong>{item.file.name}</strong><small>{item.pageCount} page{item.pageCount === 1 ? "" : "s"}</small></div>
              </button>
            ))}</div> : <div className="label-empty">Add one or more Flipkart PDFs to start.</div>}
          </div>

          <div className="label-panel">
            <div className="label-panel-title">Saved presets</div>
            {presets.length ? presets.map((preset) => (
              <button key={preset.id} className={"preset-row " + (selectedPresetId === preset.id ? "active" : "")} onClick={() => setSelectedPresetId(preset.id)}>
                <div><strong>{preset.name}</strong><small>{Math.round(preset.crop_width_pt)} × {Math.round(preset.crop_height_pt)} pt · 4×6 output</small></div>
                {preset.is_default && <span className="badge good">Default</span>}
              </button>
            )) : <div className="label-empty">No saved crop preset yet.</div>}
          </div>
        </aside>

        <section className="label-editor">
          <div className="label-editor-head">
            <div>
              <strong>{selected?.file.name ?? "No PDF selected"}</strong>
              <span>{selected ? `${Math.round(selected.pageWidth)} × ${Math.round(selected.pageHeight)} pt` : "Upload a Flipkart label PDF"}</span>
            </div>
            <div className="label-actions">
              <button className="icon-button" disabled={!selected || busy} onClick={processCurrent}>Download current</button>
              <button className="primary-button" disabled={!items.length || busy} onClick={processAll}>Process all & download</button>
            </div>
          </div>

          {selected && pageUrl ? (
            <div className="label-canvas-wrap">
              <div
                className="label-canvas"
                ref={pageRef}
                style={{ width: pageDisplay.width, height: pageDisplay.height }}
              >
                <iframe title="PDF page preview" src={pageUrl + "#page=1&toolbar=0&navpanes=0"} className="label-pdf-preview" />
                <div
                  className="crop-box"
                  style={{
                    left: crop.x * pageDisplay.scale,
                    top: crop.y * pageDisplay.scale,
                    width: crop.width * pageDisplay.scale,
                    height: crop.height * pageDisplay.scale,
                  }}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={pointerUp}
                >
                  <span>4×6 crop</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="label-dropzone">
              <div className="empty-orb">▣</div>
              <h3>Drop your Flipkart label PDF here</h3>
              <p>Multi-page PDFs and multiple files are supported. The same saved crop can be applied to the whole batch.</p>
              <label className="primary-button label-upload">Choose PDFs<input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => loadFiles(e.target.files)} /></label>
            </div>
          )}

          {selected && <div className="crop-controls">
            <div className="crop-control"><label>Left (pt)</label><input type="number" value={Math.round(crop.x)} onChange={(e) => setCropField("x", e.target.value)} /></div>
            <div className="crop-control"><label>Top (pt)</label><input type="number" value={Math.round(crop.y)} onChange={(e) => setCropField("y", e.target.value)} /></div>
            <div className="crop-control"><label>Width (pt)</label><input type="number" value={Math.round(crop.width)} onChange={(e) => setCropField("width", e.target.value)} /></div>
            <div className="crop-control"><label>Height (pt)</label><input type="number" value={Math.round(crop.height)} onChange={(e) => setCropField("height", e.target.value)} /></div>
            <div className={"ratio-note " + (isThermalRatio ? "ok" : "warn")}>{isThermalRatio ? "2:3 thermal ratio" : "Crop ratio will be scaled to 4×6"}</div>
          </div>}

          <div className="label-save-row">
            <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder={DEFAULT_PRESET_NAME} />
            <button className="primary-button" disabled={!selected || busy} onClick={savePreset}>Save crop as default preset</button>
            <span>Future labels can reuse this crop automatically.</span>
          </div>
        </section>
      </div>
    </div>
  );
}
