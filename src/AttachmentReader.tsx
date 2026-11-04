import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnnotationEditorType, AnnotationMode } from "pdfjs-dist";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "./viewer";
import { loadPdf, type PDFDocumentProxy } from "./pdf";
import { readPdfBlob } from "./pdfInput";
import type { AttachmentStatus, DocumentTabs, OpenSource } from "./documentTabs";
import { DocumentTabBar } from "./DocumentTabBar";
import { TabStatusNotice } from "./TabStatusNotice";
import { PasswordDialog } from "./Dialogs";
import { Icon } from "./icons";
import { keys } from "./platform";
import { saveBlob } from "./download";
import { trackTitlebar } from "./titlebar";
import { trackPageImages } from "./nightImages";
import "./attachments.css";

type AttachmentSource = Extract<OpenSource, { kind: "attachment" }>;

/** An independent, transient viewer. It never enters the document editor or content-keyed storage. */
export default function AttachmentReader({ tabs, tabKey }: { tabs: DocumentTabs; tabKey: number }) {
  useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  const active = tabs.active === tabKey;
  const multipleTabs = tabs.all.length > 1;
  const back = tabs.canBackToParent(tabKey);
  const origin = tabs.all.find(tab => tab.key === tabKey)?.origin;
  const parentName = tabs.all.find(tab => tab.key === origin?.parentTabKey)?.name || "Parent document";
  const header = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const sourceRef = useRef<AttachmentSource | null>(null);
  const openRef = useRef<(source: AttachmentSource, password?: string) => void>(() => {});
  const [name, setName] = useState(() => tabs.all.find(tab => tab.key === tabKey)?.name || "Attachment");
  const [status, setStatus] = useState<AttachmentStatus>({ state: "queued" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfReady, setPdfReady] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [childPassword, setChildPassword] = useState<{ incorrect: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [night, setNight] = useState(() => {
    try { return localStorage.getItem("folio:night") === "1"; }
    catch { return false; }
  });
  const extractionPassword = status.state === "password" ? status.password : undefined;
  const modal = !!childPassword || !!extractionPassword;

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === null || event.key === "folio:theme") setTheme(event.newValue === "light" ? "light" : "dark");
      if (event.key === null || event.key === "folio:night") setNight(event.newValue === "1");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { if (active) window.folioDesktop?.setTheme(theme); }, [active, theme]);

  useLayoutEffect(() => {
    if (active && window.folioDesktop && !modal && header.current) return trackTitlebar(header.current);
  }, [active, modal, back, pdfReady, name]);

  useEffect(() => {
    window.dispatchEvent(new Event("folio:tab-visibility"));
  }, [active]);

  useEffect(() => {
    tabs.setAttachmentPasswordPending(tabKey, !!childPassword);
    return () => tabs.setAttachmentPasswordPending(tabKey, false);
  }, [tabs, tabKey, childPassword]);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let opening: AbortController | null = null;
    let current: PDFDocumentProxy | null = null;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    // This shared pdf.js hook serves both file attachments and embedded media. The child
    // intentionally has no extraction broker; saving/opening it normally enables that content.
    linkService.getAttachmentContent = async () => {
      if (!disposed) setNotice("Save this file and open it normally to use its attachments or embedded media.");
      return null;
    };
    const viewer = new PDFViewer({
      container: container.current!, viewer: inner.current!, eventBus, linkService,
      annotationMode: AnnotationMode.ENABLE,
      annotationEditorMode: AnnotationEditorType.NONE,
      imagesRightClickMinSize: 1e9,
      imageResourcesPath: `${import.meta.env.BASE_URL}pdfjs/images/`,
    });
    trackPageImages(eventBus);
    viewerRef.current = viewer;
    linkService.setViewer(viewer);
    eventBus.on("pagesinit", () => {
      if (container.current!.clientWidth > 0) viewer.currentScaleValue = "page-width";
    });
    let resizeFrame = 0;
    let lastWidth = -1, lastHeight = -1;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width; lastHeight = height;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (disposed || !current || !container.current?.clientWidth || !container.current.clientHeight) return;
        // Fit presets depend on the visible viewport. Numeric zoom is the user's choice.
        const fit = viewer.currentScaleValue || "page-width";
        if (["auto", "page-width", "page-fit", "page-height"].includes(fit)) viewer.currentScaleValue = fit;
        viewer.update();
      });
    });
    resizeObserver.observe(container.current!);
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      if (disposed) return;
      setPage(pageNumber); setPageInput(String(pageNumber));
    });
    eventBus.on("scalechanging", ({ scale: value }: { scale: number }) => { if (!disposed) setScale(value); });

    const open = async (source: AttachmentSource, password?: string) => {
      if (disposed) return;
      const run = ++generation;
      opening?.abort();
      const abort = new AbortController();
      opening = abort;
      sourceRef.current = source;
      setName(source.name); setLoading(true); setError(null); setChildPassword(null); setPdfReady(false);
      setPage(1); setPageInput("1"); setPages(0);
      viewer.setDocument(null); linkService.setDocument(null);
      const previous = current;
      current = null;
      try {
        if (previous) await previous.loadingTask.destroy();
        const bytes = await readPdfBlob(source.blob, abort.signal);
        const pdf = await loadPdf(bytes, abort.signal, password);
        if (disposed || run !== generation || abort.signal.aborted) {
          await pdf.loadingTask.destroy().catch(() => {}); return;
        }
        current = pdf;
        linkService.setDocument(pdf);
        viewer.setDocument(pdf);
        setPages(pdf.numPages); setPdfReady(true); setLoading(false);
      } catch (reason) {
        if (disposed || run !== generation || abort.signal.aborted) return;
        setLoading(false);
        const failure = reason as { name?: string; code?: number; message?: string };
        if (failure.name === "PasswordException") setChildPassword({ incorrect: failure.code === 2 });
        else setError("Couldn't read this file as a PDF. You can still save the original file.");
      }
    };
    openRef.current = (source, password) => { void open(source, password); };
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      if (disposal) return disposal;
      disposed = true; generation++;
      resizeObserver.disconnect(); cancelAnimationFrame(resizeFrame);
      opening?.abort(); opening = null;
      viewer.setDocument(null); linkService.setDocument(null);
      viewerRef.current = null; sourceRef.current = null;
      const pdf = current; current = null;
      disposal = pdf ? pdf.loadingTask.destroy() : Promise.resolve();
      return disposal;
    };
    const unbind = tabs.bind(tabKey, {
      open(source) { if (source.kind === "attachment") void open(source); },
      flush: async () => {},
      dispose,
      attachmentStatus(next) { if (!disposed) setStatus(next); },
    });
    return () => { unbind(); void dispose().catch(() => {}); };
  }, [tabs, tabKey]);

  const save = () => { const source = sourceRef.current; if (source) saveBlob(source.blob, source.name); };
  const goTo = (value: number) => {
    const viewer = viewerRef.current;
    if (!viewer || !pdfReady) return;
    viewer.currentPageNumber = Math.max(1, Math.min(pages, value));
    setPageInput(String(viewer.currentPageNumber));
  };
  const zoom = (direction: number) => {
    const viewer = viewerRef.current;
    if (viewer && pdfReady) viewer.currentScaleValue = String(Math.max(0.25, Math.min(5, viewer.currentScale * 1.2 ** direction)));
  };
  const retry = () => {
    if (sourceRef.current) openRef.current(sourceRef.current);
    else tabs.retryAttachment(tabKey);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (tabs.active !== tabKey) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && event.key.toLowerCase() === "w") { event.preventDefault(); void tabs.close(tabKey); return; }
      if (mod && !event.altKey && event.key.toLowerCase() === "t") { event.preventDefault(); tabs.library(); return; }
      if (event.ctrlKey && event.key === "Tab") { event.preventDefault(); tabs.cycle(event.shiftKey ? -1 : 1); return; }
      if (modal) return;
      const typing = (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]");
      if (typing) return;
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
      else if (mod && ["p", "f"].includes(event.key.toLowerCase())) event.preventDefault();
      else if (mod && ["=", "+", "-"].includes(event.key)) { event.preventDefault(); zoom(event.key === "-" ? -1 : 1); }
      else if (mod && event.key === "0") { event.preventDefault(); if (viewerRef.current && pdfReady) viewerRef.current.currentScaleValue = "page-width"; }
      else if (!mod && !event.altKey && ["Home", "End", "PageDown", "PageUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); goTo(event.key === "Home" ? 1 : event.key === "End" ? pages : page + (["PageUp", "ArrowLeft"].includes(event.key) ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const failure = error || (status.state === "error" ? status.message || "Couldn't extract this attachment." : null);
  return <div className="app attachment-reader" data-tool="select" data-night={night || undefined}>
    <header className="topbar" ref={header}>
      <div className="topbar-left">
        {back && <button className="icon-btn attachment-back" onClick={() => tabs.backToParent(tabKey)} title="Back to parent document">Back to parent</button>}
        <span className="doc-title" title={name}>{name}</span>
      </div>
      <span className="attachment-readonly">Read only</span>
      <div className="topbar-right">
        <button className="icon-btn attachment-save" aria-label="Save original" disabled={!sourceRef.current} onClick={save} title={keys("Save original (Ctrl+S)")}><Icon name="download" size={16} /><span>Save original</span></button>
        <button className="icon-btn" aria-label="Close attachment" title={keys("Close attachment (Ctrl+W)")} onClick={() => void tabs.close(tabKey)}><Icon name="close" size={18} /></button>
      </div>
    </header>
    {multipleTabs && <DocumentTabBar tabs={tabs} tabKey={tabKey} />}
    <TabStatusNotice tabs={tabs} tabKey={tabKey} />
    <div className="body attachment-body" id="reader-panel" role={multipleTabs ? "tabpanel" : undefined} aria-labelledby={multipleTabs ? "selected-document-tab" : undefined}>
      <div className="attachment-pdf-container" ref={container}><div className="pdfViewer" ref={inner} /></div>
      {!pdfReady && <div className="attachment-reader-state" role="status">
        {failure ? <><p>{failure}</p><button className="btn primary" onClick={retry}>Try again</button></> : <>
          <p>{loading ? "Opening attached PDF…" : status.state === "password" ? "Waiting for the parent document password…" : status.state === "extracting" ? "Extracting attachment…" : "Attachment queued…"}</p>
          {!sourceRef.current && <button className="btn ghost" onClick={() => { tabs.cancelAttachment(tabKey); void tabs.close(tabKey); }}>Cancel</button>}
        </>}
      </div>}
    </div>
    {notice && <div className="attachment-notice" role="status"><span>{notice}</span><button className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}><Icon name="close" size={14} /></button></div>}
    <footer className="attachment-toolbar" aria-label="Reading controls">
      <button className="icon-btn" aria-label="Previous page" disabled={!pdfReady || page <= 1} onClick={() => goTo(page - 1)}><Icon name="chevronUp" size={16} /></button>
      <form onSubmit={event => { event.preventDefault(); const value = Number(pageInput); if (Number.isSafeInteger(value)) goTo(value); else setPageInput(String(page)); }}>
        <input aria-label="Page number" inputMode="numeric" value={pageInput} disabled={!pdfReady} onChange={event => setPageInput(event.target.value)} onBlur={() => setPageInput(String(page))} />
        <span>of {pages || "—"}</span>
      </form>
      <button className="icon-btn" aria-label="Next page" disabled={!pdfReady || page >= pages} onClick={() => goTo(page + 1)}><Icon name="chevronDown" size={16} /></button>
      <span className="divider" />
      <button className="icon-btn" aria-label="Zoom out" disabled={!pdfReady} onClick={() => zoom(-1)}><Icon name="minus" size={16} /></button>
      <select aria-label="Zoom" disabled={!pdfReady} value="" onChange={event => { if (viewerRef.current) viewerRef.current.currentScaleValue = event.target.value; }}>
        <option value="" disabled>{Math.round(scale * 100)}%</option>
        <option value="page-width">Fit width</option><option value="page-fit">Fit page</option>
        {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(value => <option key={value} value={value}>{value * 100}%</option>)}
      </select>
      <button className="icon-btn" aria-label="Zoom in" disabled={!pdfReady} onClick={() => zoom(1)}><Icon name="plus" size={16} /></button>
    </footer>
    {active && extractionPassword && <PasswordDialog key={`extract-${extractionPassword.incorrect}`} name={parentName} error={extractionPassword.incorrect ? "That password wasn't correct. Try again." : undefined} onSubmit={extractionPassword.submit} onCancel={extractionPassword.cancel} />}
    {active && childPassword && <PasswordDialog key={`child-${childPassword.incorrect}`} name={name} error={childPassword.incorrect ? "That password wasn't correct. Try again." : undefined} onSubmit={password => { if (sourceRef.current) openRef.current(sourceRef.current, password); }} onCancel={() => { setChildPassword(null); setError("This PDF needs a password to read. You can still save the original file."); }} />}
  </div>;
}
