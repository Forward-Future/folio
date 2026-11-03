import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "./pdf";
import { Modal } from "./Dialogs";
import { DEFAULT_PRINT, parsePages, planSheets, checkPrintBudget, overlapFromPoints, overlapToPoints, type OverlapUnit, type PageSize, type PrintSettings } from "./printLayout";
import { renderPrintSheet, encodePrintSheet } from "./printRender";
import "./print.css";

export function PrintDialog({ pdf, currentPage, name, onClose }: {
  pdf: PDFDocumentProxy; currentPage: number; name: string; onClose: () => void;
}) {
  const [settings, setSettings] = useState(DEFAULT_PRINT);
  const [overlapUnit, setOverlapUnit] = useState<OverlapUnit>("in");
  const [selection, setSelection] = useState("all");
  const [range, setRange] = useState("");
  const [copies, setCopies] = useState(1);
  const [printers, setPrinters] = useState<{ name: string; displayName: string; isDefault: boolean }[]>([]);
  const [printer, setPrinter] = useState("");
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [preview, setPreview] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const job = useRef<AbortController | null>(null);
  const update = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings(s => ({ ...s, [key]: value }));
  useEffect(() => {
    let cancelled = false;
    const oldFocus = document.activeElement as HTMLElement | null;
    const dialog = root.current!.closest<HTMLElement>(".modal")!;
    dialog.querySelector<HTMLElement>("select,button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']")];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", trap);
    void (async () => {
      const result: PageSize[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled) return;
        const page = await pdf.getPage(n), size = page.getViewport({ scale: 1 });
        result.push({ width: size.width, height: size.height });
      }
      if (!cancelled) setSizes(result);
    })().catch(() => { if (!cancelled) setError("Couldn't read page sizes."); });
    void window.folioDesktop?.getPrinters().then(result => {
      if (!cancelled) { setPrinters(result); setPrinter(result.find(p => p.isDefault)?.name ?? ""); }
    }).catch(() => { if (!cancelled) setMessage("Printer list unavailable. Choose a printer in the system dialog."); });
    return () => { cancelled = true; job.current?.abort(); dialog.removeEventListener("keydown", trap); oldFocus?.focus(); };
  }, [pdf]);

  const layout = useMemo(() => {
    if (!sizes.length) return { sheets: [], error: "" };
    try {
      const pages = selection === "current" ? [currentPage] : selection === "range" ? parsePages(range, pdf.numPages) : sizes.map((_, i) => i + 1);
      return { sheets: planSheets(pages, sizes, settings), error: "" };
    } catch (e) { return { sheets: [], error: (e as Error).message }; }
  }, [sizes, selection, currentPage, range, pdf.numPages, settings]);
  const index = Math.min(sheetIndex, Math.max(0, layout.sheets.length - 1));
  const sheet = layout.sheets[index];
  const budgetError = useMemo(() => {
    try { checkPrintBudget(layout.sheets, settings.dpi); return ""; }
    catch (error) { return (error as Error).message; }
  }, [layout.sheets, settings.dpi]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview("");
    if (sheet) void renderPrintSheet(pdf, sheet, settings, 38, controller.signal).then(canvas => {
      if (!controller.signal.aborted) setPreview(canvas.toDataURL());
      canvas.width = canvas.height = 0;
    }).catch(() => { if (!controller.signal.aborted) setError("Couldn't render the print preview."); });
    return () => controller.abort();
  }, [pdf, sheet, settings]);

  const submit = async () => {
    if (!window.folioDesktop || busy || budgetError || !layout.sheets.length || copies < 1 || copies > 999 || !Number.isInteger(copies)) return;
    const controller = new AbortController(); job.current = controller;
    setBusy(true); setError(""); setMessage("");
    try {
      const images: string[] = []; let bytes = 0;
      for (let i = 0; i < layout.sheets.length; i++) {
        setProgress(`Preparing sheet ${i + 1} of ${layout.sheets.length}…`);
        const canvas = await renderPrintSheet(pdf, layout.sheets[i], settings, settings.dpi, controller.signal);
        let image: string;
        try { image = await encodePrintSheet(canvas, controller.signal); }
        finally { canvas.width = canvas.height = 0; }
        bytes += image.length;
        if (bytes > 64 * 1024 * 1024) throw new Error("This job exceeds 64 MiB of encoded images. Select fewer pages, reduce poster scale/overlap, or choose a lower DPI.");
        images.push(image);
      }
      controller.signal.throwIfAborted();
      setProgress("Waiting for the system print dialog…");
      const result = await window.folioDesktop.printSheets({ images, paper: settings.paper, dpi: settings.dpi,
        landscape: layout.sheets[0].width > layout.sheets[0].height, copies, printer, booklet: settings.mode === "booklet" });
      if (controller.signal.aborted) return;
      if (result.ok) { setMessage("Print job accepted by the system."); }
      else if (/cancel/i.test(result.error ?? "")) setMessage("Printing cancelled.");
      else setError(result.error || "Couldn't print. Check the selected printer.");
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (job.current === controller) { job.current = null; setBusy(false); setProgress(""); } }
  };
  const close = () => { if (!busy) onClose(); else if (!progress.startsWith("Waiting")) { job.current?.abort(); setProgress("Cancelling preparation…"); } };
  return <Modal title="Print" onClose={close}>
    <div className="print-dialog" ref={root}>
      <p className="print-filename" title={name}>{name}</p>
      <fieldset disabled={busy} className="print-printer">
        <label>Printer<select value={printer} onChange={e => setPrinter(e.target.value)}>
          <option value="">System default</option>{printers.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}
        </select></label>
        <div className="print-driver-buttons" title="Available in the system print dialog"><button type="button" className="btn ghost" disabled>Properties</button>
          <button type="button" className="btn ghost" disabled>Advanced</button></div>
        <label>Copies<input type="number" min="1" max="999" value={copies} onChange={e => setCopies(e.target.valueAsNumber)} /></label>
        <label className="print-check"><input type="checkbox" checked={settings.grayscale} onChange={e => update("grayscale", e.target.checked)} />Print in grayscale</label>
        <label className="print-check"><input type="checkbox" checked={settings.toner} onChange={e => update("toner", e.target.checked)} />Save ink/toner <span title="Lightens page content to 70% opacity. Actual ink savings depend on the printer.">ⓘ</span></label>
      </fieldset>
      <p className="print-hint print-driver-note">Printer properties and advanced driver settings are available after Continue to print.</p>
      <div className="print-columns">
        <fieldset disabled={busy} className="print-options">
          <section><h3>Pages to print</h3><div className="print-radio-row">
            {[["all", "All"], ["current", `Current (${currentPage})`], ["range", "Pages"]].map(([value, label]) => <label key={value}><input type="radio" name="print-pages" checked={selection === value} onChange={() => setSelection(value)} />{label}</label>)}
          </div><input aria-label="Page range" placeholder="1-3, 5" disabled={selection !== "range" || busy} value={range} onChange={e => setRange(e.target.value)} />
          </section>
          <section><h3>Page sizing &amp; handling</h3><div className="print-modes" role="group" aria-label="Page sizing and handling">
            {(["size", "poster", "multiple", "booklet"] as const).map(mode => <button key={mode} type="button" aria-pressed={settings.mode === mode} onClick={() => update("mode", mode)}>{mode[0].toUpperCase() + mode.slice(1)}</button>)}
          </div>
          {settings.mode === "size" && <div className="print-size-choices">{([["fit", "Fit"], ["actual", "Actual size"], ["shrink", "Shrink oversized pages"], ["custom", "Custom scale"]] as const).map(([value, label]) => <label key={value}><input type="radio" name="print-sizing" checked={settings.sizing === value} onChange={() => update("sizing", value)} />{label}</label>)}</div>}
          {settings.mode === "size" && (settings.sizing === "actual" || settings.sizing === "custom") && <p className="print-hint">Content outside the sheet's quarter-inch margins is clipped. Check the preview.</p>}
          {(settings.mode === "poster" || settings.mode === "size" && settings.sizing === "custom") && <label className="print-inline">{settings.mode === "poster" ? "Tile scale (%)" : "Custom scale (%)"}<input type="number" min="10" max="400" value={settings.scale} onChange={e => update("scale", e.target.valueAsNumber)} /></label>}
          {settings.mode === "poster" && <><label className="print-inline">Overlap<input aria-label="Poster overlap" type="number" min="0" step={overlapUnit === "in" ? "0.05" : "1"}
            value={Number.isFinite(settings.overlapPoints) ? +overlapFromPoints(settings.overlapPoints, overlapUnit).toFixed(6) : ""}
            onChange={e => update("overlapPoints", overlapToPoints(e.target.valueAsNumber, overlapUnit))} /></label>
            <label className="print-inline">Overlap units<select aria-label="Overlap units" value={overlapUnit} onChange={e => setOverlapUnit(e.target.value as OverlapUnit)}><option value="in">Inches</option><option value="mm">Millimeters</option></select></label>
            <p className="print-hint">Adjacent tiles repeat the chosen overlap, left to right then down. Trim the quarter-inch paper margins and align the repeated content. Cut marks are not included.</p></>}
          {settings.mode === "multiple" && <label className="print-inline">Pages per sheet<select value={settings.perSheet} onChange={e => update("perSheet", +e.target.value)}>{[2, 4, 6, 9, 16].map(n => <option key={n}>{n}</option>)}</select></label>}
          {settings.mode === "booklet" && <p className="print-hint">Left-bound booklet, front then back. Blank pages pad the final sheet. Select two-sided printing and {settings.orientation === "portrait" ? "long-edge" : "short-edge"} binding in the system dialog. Manual duplex is not supported.</p>}
          </section>
          <section><label className="print-inline">Print quality<select aria-label="Print quality" value={settings.dpi} onChange={e => update("dpi", +e.target.value as PrintSettings["dpi"])}>{[150, 300, 600].map(dpi => <option key={dpi} value={dpi}>{dpi} dpi</option>)}</select></label>
            <label className="print-inline">Paper size<select value={settings.paper} onChange={e => update("paper", e.target.value as PrintSettings["paper"])}>{["Letter", "A4", "Legal"].map(p => <option key={p}>{p}</option>)}</select></label>
            <label className="print-check print-unavailable"><input type="checkbox" disabled />Choose paper source by PDF page size</label><p className="print-hint">Automatic tray selection is unavailable. Choose a tray in printer properties.</p>
            <h3>Orientation</h3><div className="print-radio-row">{(["auto", "portrait", "landscape"] as const).map(value => <label key={value}><input type="radio" name="print-orientation" checked={settings.orientation === value} onChange={() => update("orientation", value)} />{value[0].toUpperCase() + value.slice(1)}</label>)}</div>
            <p className="print-hint">Auto uses the first selected page; Multiple and Booklet use landscape. All sheets use one paper size and orientation.</p>
          </section>
        </fieldset>
        <div className="print-preview" aria-label="Print preview">
          {sheet && <><p>Scale: {[...new Set(sheet.placements.map(p => `${Math.round(p.scale * 100)}%`))].join(", ") || "Blank"}</p><p>{(sheet.width / 72).toFixed(2)} × {(sheet.height / 72).toFixed(2)} inches</p></>}
          <div className="print-paper">{preview ? <img src={preview} alt={`Preview of sheet ${index + 1}`} /> : <p>{layout.error ? "No preview" : "Preparing preview…"}</p>}</div>
          <div className="print-preview-nav"><button className="pill-btn" aria-label="Previous sheet" disabled={index === 0} onClick={() => setSheetIndex(index - 1)}>‹</button><span>Sheet {sheet ? index + 1 : 0} of {layout.sheets.length}</span><button className="pill-btn" aria-label="Next sheet" disabled={index >= layout.sheets.length - 1} onClick={() => setSheetIndex(index + 1)}>›</button></div>
          <p className="print-hint">Preview shows the layout at reduced resolution. Output renders at {settings.dpi} dpi, with quarter-inch margins. Keep the same paper size and 100% scaling in the system dialog.</p>
          <p className="print-hint">Jobs are limited to 100 sheets, 576 MiB of decoded images and 64 MiB of encoded data. Higher DPI may require a smaller job.</p>
        </div>
      </div>
      {(layout.error || budgetError || error || !Number.isInteger(copies) || copies < 1 || copies > 999) && <p className="form-error" role="alert">{layout.error || budgetError || error || "Copies must be between 1 and 999."}</p>}
      <p className="print-status" role="status">{progress || message}</p>
      {!window.folioDesktop && <p className="print-hint">This print workflow requires the Folio desktop app.</p>}
      <div className="form-actions"><button className="btn ghost" onClick={close} disabled={busy && progress.startsWith("Waiting")}>{busy ? "Cancel preparation" : "Cancel"}</button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy || !window.folioDesktop || !preview || !sheet || !!layout.error || !!budgetError || !Number.isInteger(copies) || copies < 1 || copies > 999}>Continue to print…</button></div>
    </div>
  </Modal>;
}
