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
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shipmentIdsInput, setShipmentIdsInput] = useState("");
  const [unit, setUnit] = useState<"in" | "cm">("in");
  const [previewMode, setPreviewMode] = useState<"blended" | "page" | "odd-even">("blended");
  const [previewPage, setPreviewPage] = useState(1);
  const [batchReport, setBatchReport] = useState<null | { pages: number; files: number; valid: number; warnings: string[]; checkedAt: string }>(null);
  const [batchPages, setBatchPages] = useState<Array<{ itemIndex: number; pageIndex: number; fileName: string; width: number; height: number; valid: boolean; warning?: string }>>([]);
  const [batchPageCursor, setBatchPageCursor] = useState(0);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const selected = items[selectedIndex] ?? null;
  const inspectedBatchPage = batchPages[batchPageCursor] ?? null;

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
        if (defaultPreset) {
          setSelectedPresetId(defaultPreset.id);
          setPresetName(defaultPreset.name);
        }
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

  useEffect(() => {
    setPreviewPage((page) => clamp(page, 1, selected?.pageCount ?? 1));
  }, [selectedIndex, selected?.pageCount]);

  const cropAspect = crop.height ? crop.width / crop.height : 2 / 3;
  const isThermalRatio = Math.abs(cropAspect - 2 / 3) < 0.02;
  const PT_PER_IN = 72;
  const ptToUnit = (value: number) => value / (unit === "in" ? PT_PER_IN : PT_PER_IN / 2.54);
  const unitToPt = (value: number) => value * (unit === "in" ? PT_PER_IN : PT_PER_IN / 2.54);
  const marginsPt = selected
    ? {
        top: crop.y,
        bottom: Math.max(0, selected.pageHeight - crop.y - crop.height),
        left: crop.x,
        right: Math.max(0, selected.pageWidth - crop.x - crop.width),
      }
    : { top: 0, bottom: 0, left: 0, right: 0 };
  const margins = {
    top: ptToUnit(marginsPt.top),
    bottom: ptToUnit(marginsPt.bottom),
    left: ptToUnit(marginsPt.left),
    right: ptToUnit(marginsPt.right),
  };
  const cropSize = selected
    ? { width: ptToUnit(crop.width), height: ptToUnit(crop.height) }
    : { width: 0, height: 0 };
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

  function setMarginField(key: "top" | "bottom" | "left" | "right", raw: string) {
    if (!selected) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const next = {
      top: marginsPt.top,
      bottom: marginsPt.bottom,
      left: marginsPt.left,
      right: marginsPt.right,
      [key]: Math.max(0, unitToPt(value)),
    };
    const maxX = Math.max(0, selected.pageWidth - next.left - next.right);
    const maxY = Math.max(0, selected.pageHeight - next.top - next.bottom);
    updateCrop({
      x: next.left,
      y: next.top,
      width: Math.max(1, maxX),
      height: Math.max(1, maxY),
    });
  }

  function setDimensionField(key: "width" | "height", raw: string) {
    if (!selected) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const valuePt = Math.max(1, unitToPt(value));
    if (key === "width") {
      const width = clamp(valuePt, 1, selected.pageWidth - marginsPt.left);
      updateCrop({ width, x: marginsPt.left, y: marginsPt.top });
    } else {
      const height = clamp(valuePt, 1, selected.pageHeight - marginsPt.top);
      updateCrop({ height, x: marginsPt.left, y: marginsPt.top });
    }
  }

  function autoCrop() {
    if (!selected) return;
    const next = pageBox(selected);
    setCrop(next);
    setMessage("Auto-crop applied. Fine-tune the crop box if the Flipkart PDF has extra content around the label.");
  }


  async function loadShipmentLabels(input?: string) {
    const raw = input ?? shipmentIdsInput;
    const shipmentIds = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
    if (!shipmentIds.length) {
      setMessage("Enter at least one Flipkart shipment ID.");
      return;
    }
    if (shipmentIds.length > 100) {
      setMessage("A maximum of 100 shipment IDs can be loaded at once.");
      return;
    }
    setBusy(true);
    setMessage("Requesting labels from Flipkart...");
    try {
      const response = await fetch(`/api/flipkart/shipments/documents?type=labels&shipmentIds=${encodeURIComponent(shipmentIds.join(","))}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Flipkart label request failed.");
      }
      const blob = await response.blob();
      if (blob.size < 100) throw new Error("Flipkart returned an empty label document.");
      const file = new File([blob], `flipkart-labels-${shipmentIds.length}.pdf`, { type: "application/pdf" });
      const bytes = await file.arrayBuffer();
      const pdf = await PDFDocument.load(bytes);
      const page = pdf.getPages()[0];
      if (!page) throw new Error("Flipkart returned a PDF without pages.");
      const size = page.getSize();
      const item: PdfItem = {
        id: crypto.randomUUID(),
        file,
        pageCount: pdf.getPageCount(),
        pageWidth: size.width,
        pageHeight: size.height,
      };
      setItems((current) => [...current, item]);
      setSelectedIndex(items.length);
      setMessage(`Loaded ${pdf.getPageCount()} label page${pdf.getPageCount() === 1 ? "" : "s"} from Flipkart for ${shipmentIds.length} shipment${shipmentIds.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load labels from Flipkart.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shipmentIds = params.get("shipmentIds");
    if (!shipmentIds) return;
    setShipmentIdsInput(shipmentIds);
    void loadShipmentLabels(shipmentIds);
  }, []);

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
    setBusy(true); setMessage(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("You are not signed in.");
      const name = presetName.trim() || DEFAULT_PRESET_NAME;
      if (editingPresetId) {
        const { data, error } = await (supabase as any).from("label_crop_presets").update({
          name, page_width_pt: selected.pageWidth, page_height_pt: selected.pageHeight,
          crop_x_pt: crop.x, crop_y_pt: crop.y, crop_width_pt: crop.width, crop_height_pt: crop.height,
          output_width_pt: OUTPUT_W, output_height_pt: OUTPUT_H,
        }).eq("id", editingPresetId).eq("user_id", user.id)
          .select("id,name,page_width_pt,page_height_pt,crop_x_pt,crop_y_pt,crop_width_pt,crop_height_pt,output_width_pt,output_height_pt,is_default").single();
        if (error) throw error;
        setPresets((current) => current.map((p) => p.id === data.id ? data as Preset : p));
        setSelectedPresetId(data.id); setEditingPresetId(null);
        setMessage("Preset “" + name + "” updated.");
      } else {
        const { data, error } = await (supabase as any).from("label_crop_presets").insert({
          user_id: user.id, name, page_width_pt: selected.pageWidth, page_height_pt: selected.pageHeight,
          crop_x_pt: crop.x, crop_y_pt: crop.y, crop_width_pt: crop.width, crop_height_pt: crop.height,
          output_width_pt: OUTPUT_W, output_height_pt: OUTPUT_H, is_default: true,
        }).select("id,name,page_width_pt,page_height_pt,crop_x_pt,crop_y_pt,crop_width_pt,crop_height_pt,output_width_pt,output_height_pt,is_default").single();
        if (error) throw error;
        setPresets((current) => [data as Preset, ...current.map((p) => ({ ...p, is_default: false }))]);
        setSelectedPresetId(data.id);
        setMessage("Preset “" + name + "” saved and set as default.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save preset.");
    } finally { setBusy(false); }
  }

  async function makePresetDefault(presetId: string) {
    setBusy(true); setMessage(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("You are not signed in.");
      const { data, error } = await (supabase as any).from("label_crop_presets").update({ is_default: true })
        .eq("id", presetId).eq("user_id", user.id).select("id,is_default").single();
      if (error) throw error;
      setPresets((current) => current.map((p) => ({ ...p, is_default: p.id === data.id })));
      setSelectedPresetId(data.id); setMessage("Default crop preset updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to make preset default.");
    } finally { setBusy(false); }
  }

  function startEditPreset(preset: Preset) {
    setSelectedPresetId(preset.id); setEditingPresetId(preset.id); setPresetName(preset.name);
    setMessage("Editing “" + preset.name + "”. Adjust the crop, then save changes.");
  }

  async function deletePreset(preset: Preset) {
    if (!window.confirm("Delete the “" + preset.name + "” crop preset?")) return;
    setBusy(true); setMessage(null);
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("You are not signed in.");
      const { error } = await (supabase as any).from("label_crop_presets").delete().eq("id", preset.id).eq("user_id", user.id);
      if (error) throw error;
      setPresets((current) => current.filter((p) => p.id !== preset.id));
      if (selectedPresetId === preset.id) setSelectedPresetId(null);
      if (editingPresetId === preset.id) setEditingPresetId(null);
      setMessage("Preset “" + preset.name + "” deleted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete preset.");
    } finally { setBusy(false); }
  }

  function getEffectiveCrop(sourceSize: { width: number; height: number }) {
    const reference = selected ? { width: selected.pageWidth, height: selected.pageHeight } : sourceSize;
    const scaleX = sourceSize.width / Math.max(reference.width, 1);
    const scaleY = sourceSize.height / Math.max(reference.height, 1);
    return {
      x: crop.x * scaleX,
      y: crop.y * scaleY,
      width: crop.width * scaleX,
      height: crop.height * scaleY,
      adapted: Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001,
    };
  }

  async function makeCroppedPdf(file: File) {
    const sourceBytes = await file.arrayBuffer();
    const source = await PDFDocument.load(sourceBytes);
    const output = await PDFDocument.create();
    const pages = source.getPages();

    for (const sourcePage of pages) {
      const embedded = await output.embedPage(sourcePage);
      const sourceSize = sourcePage.getSize();
      const effective = getEffectiveCrop(sourceSize);
      const cropX = clamp(effective.x, 0, sourceSize.width);
      const cropYTop = clamp(effective.y, 0, sourceSize.height);
      const cropW = clamp(effective.width, 1, sourceSize.width - cropX);
      const cropH = clamp(effective.height, 1, sourceSize.height - cropYTop);
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
          const effective = getEffectiveCrop(sourceSize);
          const cropX = clamp(effective.x, 0, sourceSize.width);
          const cropYTop = clamp(effective.y, 0, sourceSize.height);
          const cropW = clamp(effective.width, 1, sourceSize.width - cropX);
          const cropH = clamp(effective.height, 1, sourceSize.height - cropYTop);
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

  async function printAll() {
    if (!items.length || !selected) return;
    const printWindow = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!printWindow) {
      setMessage("Your browser blocked the print window. Allow pop-ups for this site and try again.");
      return;
    }

    setBusy(true);
    setMessage("Preparing the 4×6 print-ready PDF...");
    try {
      const output = await PDFDocument.create();
      for (const item of items) {
        const source = await PDFDocument.load(await item.file.arrayBuffer());
        for (const sourcePage of source.getPages()) {
          const embedded = await output.embedPage(sourcePage);
          const sourceSize = sourcePage.getSize();
          const effective = getEffectiveCrop(sourceSize);
          const cropX = clamp(effective.x, 0, sourceSize.width);
          const cropYTop = clamp(effective.y, 0, sourceSize.height);
          const cropW = clamp(effective.width, 1, sourceSize.width - cropX);
          const cropH = clamp(effective.height, 1, sourceSize.height - cropYTop);
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
      const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      printWindow.location.href = blobUrl;
      setMessage(`Print-ready PDF created: ${items.reduce((total, item) => total + item.pageCount, 0)} label pages at 4×6.`);

      const cleanup = () => {
        URL.revokeObjectURL(blobUrl);
        printWindow.close();
      };

      setTimeout(() => {
        try {
          printWindow.focus();
          printWindow.print();
          printWindow.addEventListener("afterprint", cleanup, { once: true });
        } catch {
          printWindow.focus();
        }
      }, 1200);
    } catch (error) {
      printWindow.close();
      setMessage(error instanceof Error ? error.message : "Unable to prepare labels for printing.");
    } finally {
      setBusy(false);
    }
  }

  async function validateBatch() {
    if (!items.length) return;
    setBusy(true);
    setMessage("Checking every label page against the current crop...");
    try {
      let pages = 0;
      let valid = 0;
      const warnings: string[] = [];
      const reference = selected ? { width: selected.pageWidth, height: selected.pageHeight } : null;

      const pageResults: Array<{ itemIndex: number; pageIndex: number; fileName: string; width: number; height: number; valid: boolean; warning?: string }> = [];
      for (const [itemIndex, item] of items.entries()) {
        const pdf = await PDFDocument.load(await item.file.arrayBuffer());
        pdf.getPages().forEach((page, pageIndex) => {
          pages++;
          const size = page.getSize();
          const effective = getEffectiveCrop(size);
          const fits = effective.x >= 0 && effective.y >= 0 && effective.width > 0 && effective.height > 0 &&
            effective.x + effective.width <= size.width + 0.5 && effective.y + effective.height <= size.height + 0.5;
          const widthDelta = reference ? Math.abs(size.width - reference.width) / Math.max(reference.width, 1) : 0;
          const heightDelta = reference ? Math.abs(size.height - reference.height) / Math.max(reference.height, 1) : 0;
          const sizeMismatch = widthDelta > 0.02 || heightDelta > 0.02;
          const pageWarnings: string[] = [];

          if (!fits) {
            pageWarnings.push(`Crop extends outside ${Math.round(size.width)}×${Math.round(size.height)} pt page.`);
            warnings.push(`${item.file.name} · page ${pageIndex + 1}: ${pageWarnings.at(-1)}`);
          }
          if (sizeMismatch) {
            pageWarnings.push("Page size differs from the selected reference page; the crop will be proportionally adapted.");
            warnings.push(`${item.file.name} · page ${pageIndex + 1}: ${pageWarnings.at(-1)}`);
          }

          if (fits) valid++;
          pageResults.push({
            itemIndex,
            pageIndex,
            fileName: item.file.name,
            width: size.width,
            height: size.height,
            valid: fits,
            warning: pageWarnings.length ? pageWarnings.join(" ") : undefined,
          });
        });
      }
      setBatchPages(pageResults);
      setBatchPageCursor(0);

      const uniqueWarnings = [...new Set(warnings)];
      setBatchReport({ pages, files: items.length, valid, warnings: uniqueWarnings, checkedAt: new Date().toLocaleTimeString() });
      setMessage(uniqueWarnings.length
        ? `Batch check complete: ${valid}/${pages} pages fit the crop, with ${uniqueWarnings.length} warning(s).`
        : `Batch check passed: ${pages} pages across ${items.length} file(s) are compatible with the current crop.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to validate the label batch.");
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

      <div className="label-source-bar">
        <div>
          <strong>Load labels from Flipkart</strong>
          <span>Paste shipment IDs to fetch the real shipping-label PDF directly from the connected seller account.</span>
        </div>
        <div className="label-source-actions">
          <input
            value={shipmentIdsInput}
            onChange={(e) => setShipmentIdsInput(e.target.value)}
            placeholder="Shipment ID, Shipment ID, ..."
            disabled={busy}
          />
          <button className="primary-button" disabled={busy} onClick={() => loadShipmentLabels()}>Fetch labels</button>
        </div>
      </div>

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
              <div key={preset.id} className={"preset-row " + (selectedPresetId === preset.id ? "active" : "")}>
                <button className="preset-main" onClick={() => { setSelectedPresetId(preset.id); setPresetName(preset.name); setEditingPresetId(null); }} disabled={busy}>
                  <div><strong>{preset.name}</strong><small>{Math.round(preset.crop_width_pt)} × {Math.round(preset.crop_height_pt)} pt · 4×6 output</small></div>
                  {preset.is_default && <span className="badge good">Default</span>}
                </button>
                <div className="preset-actions">
                  <button type="button" onClick={() => startEditPreset(preset)} disabled={busy}>Edit</button>
                  {!preset.is_default && <button type="button" onClick={() => makePresetDefault(preset.id)} disabled={busy}>Make default</button>}
                  <button type="button" onClick={() => deletePreset(preset)} disabled={busy}>Delete</button>
                </div>
              </div>
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
              <button className="icon-button" disabled={!items.length || busy} onClick={printAll}>Print 4×6</button>
              <button className="icon-button" disabled={!items.length || busy} onClick={validateBatch}>Check batch</button>
              <button className="primary-button" disabled={!items.length || busy} onClick={processAll}>Process all & download</button>
            </div>
          </div>

          {selected && pageUrl ? (
            <>
              <div className="preview-toolbar">
                <div>
                  <strong>Preview mode</strong>
                  <span>Choose how the source PDF is inspected before cropping.</span>
                </div>
                <div className="preview-mode-tabs">
                  <button className={previewMode === "blended" ? "active" : ""} onClick={() => setPreviewMode("blended")}>Blended</button>
                  <button className={previewMode === "page" ? "active" : ""} onClick={() => setPreviewMode("page")}>Page by page</button>
                  <button className={previewMode === "odd-even" ? "active" : ""} onClick={() => setPreviewMode("odd-even")}>Odd &amp; even</button>
                </div>
                <div className="preview-page-control">
                  <label>Page</label>
                  <select value={previewPage} onChange={(e) => setPreviewPage(Number(e.target.value))}>
                    {Array.from({ length: selected.pageCount }, (_, i) => i + 1).map((page) => <option key={page} value={page}>{page}</option>)}
                  </select>
                </div>
              </div>

              <div className="label-canvas-wrap">
                {previewMode === "odd-even" ? (
                  <div className="preview-pair">
                    {[previewPage % 2 === 0 ? previewPage - 1 : previewPage, previewPage % 2 === 0 ? previewPage : previewPage + 1]
                      .filter((page) => page >= 1 && page <= selected.pageCount)
                      .map((page, pairIndex) => (
                        <div
                          key={page}
                          className="label-canvas preview-pair-page"
                          ref={pairIndex === 0 ? pageRef : undefined}
                          style={{ width: pageDisplay.width, height: pageDisplay.height }}
                        >
                          <iframe title={`PDF page preview ${page}`} src={pageUrl + `#page=${page}&toolbar=0&navpanes=0`} className="label-pdf-preview" />
                          {pairIndex === 0 && <div
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
                          </div>}
                        </div>
                      ))}
                  </div>
                ) : (
                  <div
                    className="label-canvas"
                    ref={pageRef}
                    style={{ width: pageDisplay.width, height: pageDisplay.height }}
                  >
                    <iframe title="PDF page preview" src={pageUrl + `#page=${previewPage}&toolbar=0&navpanes=0`} className="label-pdf-preview" />
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
                )}
              </div>
            </>
          ) : (
            <div className="label-dropzone">
              <div className="empty-orb">▣</div>
              <h3>Drop your Flipkart label PDF here</h3>
              <p>Multi-page PDFs and multiple files are supported. The same saved crop can be applied to the whole batch.</p>
              <label className="primary-button label-upload">Choose PDFs<input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => loadFiles(e.target.files)} /></label>
            </div>
          )}

          {batchReport && <div className="batch-report">
            <div className="batch-report-head">
              <div><strong>Batch validation</strong><span>{batchReport.files} file{batchReport.files === 1 ? "" : "s"} · {batchReport.pages} label pages · checked {batchReport.checkedAt}</span></div>
              <div className={"batch-status " + (batchReport.warnings.length ? "warn" : "ok")}>{batchReport.warnings.length ? `${batchReport.warnings.length} warning${batchReport.warnings.length === 1 ? "" : "s"}` : "Ready to print"}</div>
            </div>
            <div className="batch-report-stats">
              <div><strong>{batchReport.valid}/{batchReport.pages}</strong><span>pages fit crop</span></div>
              <div><strong>4×6</strong><span>output size</span></div>
              <div><strong>{batchReport.warnings.length}</strong><span>warnings</span></div>
            </div>
            {batchPages.length > 0 && (
              <div className="batch-inspector">
                <div className="batch-inspector-head">
                  <div>
                    <strong>Inspect label pages</strong>
                    <span>Review each page before printing. Warning pages are marked.</span>
                  </div>
                  <div className="batch-inspector-nav">
                    <button disabled={batchPageCursor <= 0} onClick={() => setBatchPageCursor((value) => Math.max(0, value - 1))}>Previous</button>
                    <span>{batchPageCursor + 1} / {batchPages.length}</span>
                    <button disabled={batchPageCursor >= batchPages.length - 1} onClick={() => setBatchPageCursor((value) => Math.min(batchPages.length - 1, value + 1))}>Next</button>
                  </div>
                </div>
                {inspectedBatchPage && (
                  <div className="batch-inspector-row">
                    <div className="batch-page-meta">
                      <strong>Page {inspectedBatchPage.pageIndex + 1} · {inspectedBatchPage.fileName}</strong>
                      <span>{Math.round(inspectedBatchPage.width)} × {Math.round(inspectedBatchPage.height)} pt</span>
                    </div>
                    <div className={"batch-page-status " + (inspectedBatchPage.valid ? "ok" : "warn")}>
                      {inspectedBatchPage.valid ? "Crop ready" : "Needs review"}
                    </div>
                    {inspectedBatchPage.warning && <div className="batch-page-warning">{inspectedBatchPage.warning}</div>}
                    <button
                      className="icon-button"
                      onClick={() => {
                        setSelectedIndex(inspectedBatchPage.itemIndex);
                        setPreviewPage(inspectedBatchPage.pageIndex + 1);
                      }}
                    >
                      Open in editor
                    </button>
                  </div>
                )}
              </div>
            )}
            {batchReport.warnings.length > 0 && <div className="batch-warning-list">{batchReport.warnings.slice(0, 8).map((warning) => <div key={warning}>{warning}</div>)}{batchReport.warnings.length > 8 && <div>+ {batchReport.warnings.length - 8} more warnings</div>}</div>}
          </div>}

          {selected && <div className="crop-options">
            <div className="crop-options-head">
              <div>
                <strong>Crop options</strong>
                <span>Set exact margins and page dimensions, or drag the crop box above.</span>
              </div>
              <div className="unit-toggle">
                <button className={unit === "in" ? "active" : ""} onClick={() => setUnit("in")}>inch</button>
                <button className={unit === "cm" ? "active" : ""} onClick={() => setUnit("cm")}>cm</button>
              </div>
            </div>

            <div className="crop-options-grid">
              <div className="crop-control"><label>Top</label><input type="number" step="0.01" value={margins.top.toFixed(2)} onChange={(e) => setMarginField("top", e.target.value)} /></div>
              <div className="crop-control"><label>Width</label><input type="number" step="0.01" value={cropSize.width.toFixed(2)} onChange={(e) => setDimensionField("width", e.target.value)} /></div>
              <div className="crop-control"><label>Height</label><input type="number" step="0.01" value={cropSize.height.toFixed(2)} onChange={(e) => setDimensionField("height", e.target.value)} /></div>
              <div className="crop-control"><label>Bottom</label><input type="number" step="0.01" value={margins.bottom.toFixed(2)} onChange={(e) => setMarginField("bottom", e.target.value)} /></div>
              <div className="crop-control"><label>Left</label><input type="number" step="0.01" value={margins.left.toFixed(2)} onChange={(e) => setMarginField("left", e.target.value)} /></div>
              <div className="crop-control"><label>Right</label><input type="number" step="0.01" value={margins.right.toFixed(2)} onChange={(e) => setMarginField("right", e.target.value)} /></div>
              <button className="auto-crop-button" onClick={autoCrop} disabled={busy}>Auto-crop</button>
              <div className={"ratio-note " + (isThermalRatio ? "ok" : "warn")}>{isThermalRatio ? "2:3 thermal ratio" : "Will scale to 4×6 output"}</div>
            </div>
          </div>}

          <div className="label-save-row">
            <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder={DEFAULT_PRESET_NAME} />
            <button className="primary-button" disabled={!selected || busy} onClick={savePreset}>{editingPresetId ? "Save preset changes" : "Save crop as default preset"}</button>
            {editingPresetId && <button className="icon-button" disabled={busy} onClick={() => { setEditingPresetId(null); setPresetName(DEFAULT_PRESET_NAME); }}>Cancel edit</button>}
            <span>{editingPresetId ? "Changes update the selected preset." : "New presets become the default automatically."}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
