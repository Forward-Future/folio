import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageViewport } from "pdfjs-dist";
import type { PDFDocumentProxy } from "./pdf";
import type { EventBus, PDFViewer } from "./viewer";
import { Icon } from "./icons";
import { detectSignatureTargets, fitSignature, readSignatures, uncoveredTargets, type SavedSignature, type SignatureImage, type SignatureTarget } from "./signatures";

interface FieldActions {
  stampRects: (pageIndex: number) => number[][];
  onSign: (page: number, image: SignatureImage, rect: number[]) => Promise<void>;
  onCapture: (page: number, target: SignatureTarget) => void;
}
interface PageView { id: number; div: HTMLDivElement; viewport: PageViewport }
interface Pick { field: SignatureTarget; button: HTMLButtonElement; saved: SavedSignature[] }

function FieldPicker({ pick, close, onSign, container }: {
  pick: Pick; close: () => void; container: HTMLDivElement; onSign: (image: SavedSignature) => Promise<void>;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    const menu = card.current!;
    const anchor = pick.button;
    const position = () => {
      // The page renderer can briefly detach the field during a zoom redraw.
      if (!anchor.isConnected) return;
      const a = anchor.getBoundingClientRect(), stage = container.getBoundingClientRect();
      if (a.bottom <= stage.top || a.top >= stage.bottom || a.right <= stage.left || a.left >= stage.right) { close(); return; }
      const left = Math.max(8, Math.min(a.left, window.innerWidth - menu.offsetWidth - 8));
      const top = a.bottom + menu.offsetHeight + 6 <= window.innerHeight - 8 ? a.bottom + 6 : a.top - menu.offsetHeight - 6;
      menu.style.left = left + "px";
      menu.style.top = Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8)) + "px";
    };
    position();
    menu.querySelector("button")?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation(); event.preventDefault(); close(); anchor.focus({ preventScroll: true });
      } else if (event.key === "Tab" && document.activeElement === menu.querySelector(event.shiftKey ? "button:first-of-type" : "button:last-of-type")) {
        close(); anchor.focus({ preventScroll: true });
      }
    };
    const size = new ResizeObserver(position);
    size.observe(menu); size.observe(container); size.observe(anchor);
    container.addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      size.disconnect();
      container.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pick, close, container]);
  async function choose(image: SavedSignature) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSign(image); close(); }
    catch (reason) { setError((reason as Error).message); setBusy(false); }
  }
  return createPortal(<div ref={card} className="signature-field-picker" role="dialog" aria-label={"Sign " + pick.field.label}>
    <strong>{pick.field.label}</strong>
    {pick.saved.map(image => <button key={image.key} disabled={busy} onClick={() => void choose(image)}>
      <img src={image.url} alt="" /><span>{image.name}</span>
    </button>)}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>, document.body);
}

function PageFields({ pdf, view, container, stampRects, onSign, onCapture }: FieldActions & {
  pdf: PDFDocumentProxy; view: PageView; container: HTMLDivElement;
}) {
  const [host] = useState(() => Object.assign(document.createElement("div"), { className: "signature-field-layer" }));
  const [fields, setFields] = useState<SignatureTarget[]>([]);
  const [pick, setPick] = useState<Pick | null>(null);
  const close = useCallback(() => setPick(null), []);
  useEffect(() => {
    let current = true;
    void detectSignatureTargets(pdf, view.id, true).then(targets => {
      if (current) setFields(targets);
    }).catch(() => {});
    return () => { current = false; };
  }, [pdf, view.id]);
  const open = fields.length ? uncoveredTargets(fields, stampRects(view.id - 1)) : [];
  const hasFields = open.length > 0;
  useLayoutEffect(() => {
    if (!hasFields) return;
    // PDF.js owns the page's children and can remove this layer before its next pagerendered event.
    const attach = () => {
      if (host.parentElement !== view.div && view.div.querySelector(".canvasWrapper")) view.div.append(host);
    };
    attach();
    const observer = new MutationObserver(attach);
    observer.observe(view.div, { childList: true });
    return () => { observer.disconnect(); host.remove(); };
  }, [host, view, hasFields]);
  useLayoutEffect(() => { if (pick && !open.includes(pick.field)) close(); }, [pick, open, close]);
  if (!hasFields) return null;
  const vp = view.viewport;
  return <>{createPortal(open.map(field => {
    const [left, bottom, right, top] = field.rect;
    const [x1, y1] = vp.convertToViewportPoint(left, bottom), [x2, y2] = vp.convertToViewportPoint(right, top);
    return <button key={field.id} className="signature-hit" aria-label={"Sign " + field.label} title={field.label}
      aria-haspopup="dialog" aria-expanded={pick?.field === field} style={{
        left: Math.min(x1, x2) / vp.width * 100 + "%", top: Math.min(y1, y2) / vp.height * 100 + "%",
        width: Math.abs(x2 - x1) / vp.width * 100 + "%", height: Math.abs(y2 - y1) / vp.height * 100 + "%",
      }} onClick={event => {
        if (pick?.field === field) { close(); return; }
        const saved = readSignatures();
        if (!saved.length) { onCapture(view.id, field); return; }
        setPick({ field, button: event.currentTarget, saved });
      }}><Icon name="signature" size={15} /><span>Sign</span></button>;
  }), host)}
    {pick && open.includes(pick.field) && <FieldPicker pick={pick} close={close} container={container}
      onSign={image => onSign(view.id, image, fitSignature(image, pick.field.rect))} />}
  </>;
}

export function SignatureFields({ pdf, viewer, bus, ...actions }: FieldActions & {
  pdf: PDFDocumentProxy; viewer: PDFViewer; bus: EventBus;
}) {
  const [views, setViews] = useState<PageView[]>([]);
  useLayoutEffect(() => {
    const refresh = () => setViews(viewer.pdfDocument === pdf
      ? Array.from(viewer.getCachedPageViews()).filter(v => v.div.isConnected && v.pdfPage) : []);
    refresh();
    bus.on("pagerendered", refresh);
    return () => bus.off("pagerendered", refresh);
  }, [pdf, viewer, bus]);
  return <>{views.map(view => <PageFields key={view.id} pdf={pdf} view={view} container={viewer.container} {...actions} />)}</>;
}
