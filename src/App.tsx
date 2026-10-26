import { useCallback, useEffect, useRef, useState } from "react";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
  SpreadMode,
} from "./viewer";
import { AnnotationEditorParamsType, AnnotationEditorType } from "pdfjs-dist";
import { loadPdf, thumbnailDataUrl, type PDFDocumentProxy } from "./pdf";
import { fileId, getRecent, saveRecent, updateLastPage } from "./recent";
import { Icon, type IconName } from "./icons";
import { Welcome } from "./Welcome";
import { Sidebar } from "./Sidebar";
import { ZoomMenu } from "./ZoomMenu";
import { SearchBar, type FindResult } from "./SearchBar";
import { InfoDialog, PasswordDialog, ShortcutsDialog } from "./Dialogs";

type Tool = "select" | "highlight" | "ink" | "freetext";

const TOOL_MODES: Record<Tool, number> = {
  select: AnnotationEditorType.NONE,
  highlight: AnnotationEditorType.HIGHLIGHT,
  ink: AnnotationEditorType.INK,
  freetext: AnnotationEditorType.FREETEXT,
};

const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  { id: "select", icon: "cursor", label: "Select", key: "V" },
  { id: "highlight", icon: "highlight", label: "Highlight", key: "H" },
  { id: "ink", icon: "pen", label: "Draw", key: "D" },
  { id: "freetext", icon: "text", label: "Text", key: "T" },
];

const HIGHLIGHTS = [
  { name: "Yellow", hex: "#FFD84D" },
  { name: "Green", hex: "#5EDC9A" },
  { name: "Blue", hex: "#6CB8FF" },
  { name: "Pink", hex: "#FF8FC7" },
  { name: "Red", hex: "#FF5A4E" },
];

const INKS = [
  { name: "Black", hex: "#1C1B19" },
  { name: "Red", hex: "#E5533D" },
  { name: "Blue", hex: "#2F6FED" },
  { name: "Green", hex: "#1F9D55" },
  { name: "Purple", hex: "#8B5CF6" },
];

const PALETTE: Partial<Record<Tool, typeof INKS>> = { highlight: HIGHLIGHTS, ink: INKS, freetext: INKS };

const COLOR_PARAM: Partial<Record<Tool, number>> = {
  highlight: AnnotationEditorParamsType.HIGHLIGHT_COLOR,
  ink: AnnotationEditorParamsType.INK_COLOR,
  freetext: AnnotationEditorParamsType.FREETEXT_COLOR,
};

interface OpenDoc {
  id: string;
  name: string;
  data: Uint8Array;
  pdf: PDFDocumentProxy;
}

interface Pending {
  name: string;
  data: Uint8Array;
  error?: string;
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const busRef = useRef<EventBus | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  const lastPageRef = useRef<number>(1);
  const docRef = useRef<OpenDoc | null>(null);

  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("folio:sidebar") !== "0" && window.innerWidth > 760);
  const [searchOpen, setSearchOpen] = useState(false);
  const [find, setFind] = useState<FindResult>({ current: 0, total: 0, state: null });
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "light");
  const [spread, setSpread] = useState(() => localStorage.getItem("folio:spread") === "1");
  const spreadRef = useRef(spread);
  spreadRef.current = spread;
  const [night, setNight] = useState(() => localStorage.getItem("folio:night") === "1");
  const [tool, setTool] = useState<Tool>("select");
  const [colors, setColors] = useState<Partial<Record<Tool, string>>>({
    highlight: HIGHLIGHTS[0].hex,
    ink: INKS[0].hex,
    freetext: INKS[0].hex,
  });
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const pageRef = useRef(1);
  pageRef.current = page;
  const [dirty, setDirty] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<"info" | "shortcuts" | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);

  docRef.current = doc;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout((flash as unknown as { t?: number }).t);
    (flash as unknown as { t?: number }).t = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // ── Viewer bootstrap ────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current!;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      viewer: innerRef.current!,
      eventBus,
      linkService,
      findController,
      annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHTS.map((c) => `${c.name.toLowerCase()}=${c.hex}`).join(","),
    });
    linkService.setViewer(viewer);
    viewerRef.current = viewer;
    busRef.current = eventBus;
    linkRef.current = linkService;

    eventBus.on("pagesinit", () => {
      viewer.spreadMode = spreadRef.current ? SpreadMode.ODD : SpreadMode.NONE;
      viewer.currentScaleValue = window.innerWidth < 900 ? "page-width" : "auto";
      if (lastPageRef.current > 1) viewer.currentPageNumber = lastPageRef.current;
    });
    eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
      pageRef.current = pageNumber;
      setPage(pageNumber);
      setPageInput(String(pageNumber));
    });
    eventBus.on("scalechanging", ({ scale }: { scale: number }) => setScale(scale));
    eventBus.on("rotationchanging", ({ pagesRotation }: { pagesRotation: number }) => setRotation(pagesRotation));
    eventBus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
      setFind((f) => ({ ...f, ...matchesCount })),
    );
    eventBus.on(
      "updatefindcontrolstate",
      ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) =>
        setFind({ ...matchesCount, state }),
    );
    eventBus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
      const entry = Object.entries(TOOL_MODES).find(([, m]) => m === mode);
      const next = entry ? (entry[0] as Tool) : "select";
      setTool(next);
      // Apply the remembered colour once the editor layer for this mode is live.
      const param = COLOR_PARAM[next];
      const value = colorsRef.current[next];
      if (param && value) eventBus.dispatch("switchannotationeditorparams", { source: null, type: param, value });
    });

    // Ctrl/⌘ + wheel or trackpad pinch zooms around the cursor.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!viewer.pdfDocument) return;
      viewer.updateScale({
        drawingDelay: 300,
        scaleFactor: Math.exp(-e.deltaY / 300),
        origin: [e.clientX, e.clientY],
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // ── Opening documents ───────────────────────────────────────────────
  const openBytes = useCallback(
    async (name: string, data: Uint8Array, password?: string) => {
      const viewer = viewerRef.current!;
      setLoading(true);
      setError(null);
      try {
        const pdf = await loadPdf(data, password).promise;
        const id = fileId(name, data.byteLength);
        const existing = await getRecent(id);
        lastPageRef.current = existing?.lastPage ?? 1;

        const prev = docRef.current;
        viewer.setDocument(pdf);
        linkRef.current!.setDocument(pdf, null);
        prev?.pdf.loadingTask.destroy();

        (pdf.annotationStorage as { onSetModified: unknown }).onSetModified = () => setDirty(true);
        (pdf.annotationStorage as { onResetModified: unknown }).onResetModified = () => setDirty(false);

        setDoc({ id, name, data, pdf });
        setNumPages(pdf.numPages);
        setPage(lastPageRef.current);
        setPageInput(String(lastPageRef.current));
        setRotation(0);
        setDirty(false);
        setTool("select");
        setPending(null);
        setSearchOpen(false);
        setFind({ current: 0, total: 0, state: null });
        document.title = `${name} — Folio`;

        saveRecent({
          id,
          name,
          size: data.byteLength,
          pages: pdf.numPages,
          openedAt: Date.now(),
          lastPage: lastPageRef.current,
          thumb: existing?.thumb ?? (await thumbnailDataUrl(pdf).catch(() => "")),
          data: new Blob([data.slice()], { type: "application/pdf" }),
        });
      } catch (err) {
        const e = err as { name?: string; code?: number; message?: string };
        if (e?.name === "PasswordException") {
          setPending({ name, data, error: e.code === 2 ? "Incorrect password. Try again." : undefined });
        } else {
          setError(`Couldn't open “${name}”. ${e?.message ?? "The file may be damaged."}`);
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (file: File) => {
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setError(`“${file.name}” isn't a PDF.`);
        return;
      }
      openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    },
    [openBytes],
  );

  const pickFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.onchange = () => input.files?.[0] && openFile(input.files[0]);
    input.click();
  }, [openFile]);

  const openSample = useCallback(async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}sample.pdf`);
    openBytes("TraceMonkey — Trace-based JIT.pdf", new Uint8Array(await res.arrayBuffer()));
  }, [openBytes]);

  const closeDoc = useCallback(() => {
    if (dirty && !confirm("You have unsaved annotations. Close anyway?")) return;
    viewerRef.current!.setDocument(null as unknown as PDFDocumentProxy);
    linkRef.current!.setDocument(null, null);
    docRef.current?.pdf.loadingTask.destroy();
    setDoc(null);
    setDirty(false);
    setSearchOpen(false);
    setFocus(false);
    document.title = "Folio";
  }, [dirty]);

  // Remember where the reader left off.
  useEffect(() => {
    if (!doc) return;
    const t = window.setTimeout(() => updateLastPage(doc.id, page), 600);
    return () => window.clearTimeout(t);
  }, [doc, page]);

  // ── Actions ─────────────────────────────────────────────────────────
  const goTo = (n: number) => {
    const v = viewerRef.current!;
    if (!v.pdfDocument) return;
    v.currentPageNumber = Math.min(Math.max(1, n), v.pagesCount);
  };
  const zoom = (steps: number) => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.updateScale({ steps, drawingDelay: 0, origin: undefined as unknown as number[] });
  };
  const setScaleValue = (value: string) => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.currentScaleValue = value;
  };
  const toggleSpread = () => {
    const v = viewerRef.current!;
    const next = !spread;
    setSpread(next);
    localStorage.setItem("folio:spread", next ? "1" : "0");
    if (!v.pdfDocument) return;
    const value = v.currentScaleValue;
    v.spreadMode = next ? SpreadMode.ODD : SpreadMode.NONE;
    // Re-fit so "fit width/page" accounts for two pages side by side.
    if (["auto", "page-width", "page-fit"].includes(value)) v.currentScaleValue = value;
  };
  const rotate = () => {
    const v = viewerRef.current!;
    if (v.pdfDocument) v.pagesRotation = (v.pagesRotation + 90) % 360;
  };

  const chooseTool = (next: Tool) => {
    const v = viewerRef.current!;
    if (!v.pdfDocument) return;
    try {
      v.annotationEditorMode = { mode: TOOL_MODES[next] };
      setTool(next);
    } catch {
      flash("Annotations aren't supported for this document");
    }
  };

  const chooseColor = (hex: string) => {
    setColors((c) => ({ ...c, [tool]: hex }));
    const param = COLOR_PARAM[tool];
    if (param) busRef.current!.dispatch("switchannotationeditorparams", { source: null, type: param, value: hex });
  };

  const currentBytes = async () => {
    if (!doc) return null;
    return dirty ? await doc.pdf.saveDocument() : doc.data;
  };

  const download = async () => {
    const bytes = await currentBytes();
    if (!bytes || !doc) return;
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name.toLowerCase().endsWith(".pdf") ? doc.name : `${doc.name}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    flash(dirty ? "Saved a copy with your annotations" : "Download started");
  };

  const print = async () => {
    const bytes = await currentBytes();
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.src = url;
    frame.onload = () => {
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(url, "_blank");
        }
      }, 250);
    };
    document.body.appendChild(frame);
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  // Desktop app: PDFs opened from Explorer, and a title bar that matches the theme.
  useEffect(() => window.folioDesktop?.onOpenFile((name, data) => openBytes(name, data)), [openBytes]);
  useEffect(() => window.folioDesktop?.setTheme(theme), [theme]);
  useEffect(() => window.folioDesktop?.onUpdateReady(setUpdateVersion), []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("folio:theme", next);
    setTheme(next);
  };

  const toggleFocus = async () => {
    const next = !focus;
    setFocus(next);
    try {
      if (next && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (!next && document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* fullscreen can be refused; focus mode still hides the chrome */
    }
  };

  useEffect(() => {
    const onFs = () => !document.fullscreenElement && setFocus(false);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => localStorage.setItem("folio:sidebar", sidebar ? "1" : "0"), [sidebar]);
  useEffect(() => localStorage.setItem("folio:night", night ? "1" : "0"), [night]);

  // Keep the viewer's layout correct when the sidebar animates open/closed.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v?.pdfDocument) return;
    const value = v.currentScaleValue;
    if (!["auto", "page-width", "page-fit"].includes(value)) return;
    const t = window.setTimeout(() => (v.currentScaleValue = value), 260);
    return () => window.clearTimeout(t);
  }, [sidebar, focus]);

  // Warn before losing unsaved annotations.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const typing = target.closest("input, textarea, [contenteditable=true], .freeTextEditor");

      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pickFile();
        return;
      }
      if (!docRef.current) return;

      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => document.getElementById("folio-search")?.focus());
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        download();
      } else if (mod && e.key.toLowerCase() === "p") {
        e.preventDefault();
        print();
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoom(-1);
      } else if (mod && e.key === "0") {
        e.preventDefault();
        setScaleValue("auto");
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (typing || mod || e.altKey) {
        return;
      } else if (e.key === "Escape") {
        if (dialog) setDialog(null);
        else if (searchOpen) setSearchOpen(false);
        else if (tool !== "select") chooseTool("select");
        else if (focus) toggleFocus();
      } else if (e.key === "f" || e.key === "F") {
        toggleFocus();
      } else if (e.key === "?") {
        setDialog("shortcuts");
      } else if (e.key === "2") {
        toggleSpread();
      } else if (e.key === "r" || e.key === "R") {
        rotate();
      } else {
        const t = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
        if (t) chooseTool(t.id);
        else if (e.key === "Home") goTo(1);
        else if (e.key === "End") goTo(numPages);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Drag & drop anywhere ────────────────────────────────────────────
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) openFile(file);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  const runFind = (query: string, opts: { again?: boolean; previous?: boolean; caseSensitive?: boolean; entireWord?: boolean }) =>
    busRef.current!.dispatch("find", {
      source: null,
      type: opts.again ? "again" : "",
      query,
      caseSensitive: !!opts.caseSensitive,
      entireWord: !!opts.entireWord,
      highlightAll: true,
      findPrevious: !!opts.previous,
      matchDiacritics: false,
    });

  const closeSearch = () => {
    setSearchOpen(false);
    busRef.current!.dispatch("findbarclose", { source: null });
  };

  const isEditing = tool !== "select";

  return (
    <div
      className="app"
      data-focus={focus || undefined}
      data-sidebar={(sidebar && !!doc && !focus) || undefined}
      data-night={night || undefined}
      data-tool={tool}
    >
      <header className="topbar">
        <div className="topbar-left">
          <button className="brand" onClick={doc ? closeDoc : undefined} title={doc ? "Back to library" : "Folio"}>
            <span className="brand-mark" />
            <span className="brand-name">Folio</span>
          </button>
          {doc && (
            <>
              <IconButton icon="sidebar" label="Toggle sidebar (Ctrl+\)" active={sidebar} onClick={() => setSidebar(!sidebar)} />
              <div className="doc-title" title={doc.name}>
                <span>{doc.name.replace(/\.pdf$/i, "")}</span>
                {dirty && <span className="dirty-dot" title="Unsaved annotations" />}
              </div>
            </>
          )}
        </div>

        <div className="topbar-center">
          {doc && (
            <div className="segmented" role="toolbar" aria-label="Tools">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={tool === t.id ? "on" : ""}
                  onClick={() => chooseTool(t.id)}
                  title={`${t.label} (${t.key})`}
                >
                  <Icon name={t.icon} size={16} />
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="topbar-right">
          {doc && (
            <>
              <IconButton icon="search" label="Search (Ctrl+F)" active={searchOpen} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))} />
              <IconButton icon="print" label="Print (Ctrl+P)" className="wide-only" onClick={print} />
              <IconButton icon="download" label={dirty ? "Save copy with annotations (Ctrl+S)" : "Download (Ctrl+S)"} onClick={download} />
              <span className="divider" />
              <IconButton icon="eye" label="Night reading" className="wide-only" active={night} onClick={() => setNight(!night)} />
            </>
          )}
          <IconButton icon={theme === "dark" ? "sun" : "moon"} label="Toggle theme" onClick={toggleTheme} />
          {doc && (
            <>
              <IconButton icon="info" label="Document info" className="wide-only" onClick={() => setDialog("info")} />
              <IconButton icon="expand" label="Focus mode (F)" onClick={toggleFocus} />
            </>
          )}
        </div>
      </header>

      <div className="body">
        {doc && (
          <Sidebar
            pdf={doc.pdf}
            page={page}
            rotation={rotation}
            onSelectPage={goTo}
            onSelectDest={(dest) => linkRef.current!.goToDestination(dest as string)}
          />
        )}

        <main className="stage">
          <div ref={containerRef} className="viewer-container" tabIndex={-1}>
            <div ref={innerRef} className="pdfViewer" />
          </div>

          {doc && searchOpen && (
            <SearchBar result={find} onFind={runFind} onClose={closeSearch} />
          )}

          {doc && isEditing && PALETTE[tool] && (
            <div className="color-pill" role="radiogroup" aria-label="Color">
              {PALETTE[tool]!.map((c) => (
                <button
                  key={c.hex}
                  className={colors[tool] === c.hex ? "on" : ""}
                  style={{ "--swatch": c.hex } as React.CSSProperties}
                  onClick={() => chooseColor(c.hex)}
                  title={c.name}
                  role="radio"
                  aria-checked={colors[tool] === c.hex}
                />
              ))}
              <span className="divider" />
              <button className="pill-btn" onClick={() => busRef.current!.dispatch("editingaction", { source: null, name: "undo" })} title="Undo (Ctrl+Z)">
                <Icon name="undo" size={16} />
              </button>
              <button className="pill-done" onClick={() => chooseTool("select")}>Done</button>
            </div>
          )}

          {doc && (
            <div className="pill" role="toolbar" aria-label="Navigation">
              <button className="pill-btn" onClick={() => goTo(page - 1)} disabled={page <= 1} title="Previous page">
                <Icon name="chevronUp" size={17} />
              </button>
              <form
                className="page-field"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = parseInt(pageInput, 10);
                  if (Number.isFinite(n)) goTo(n);
                  else setPageInput(String(page));
                  (document.activeElement as HTMLElement)?.blur();
                }}
              >
                <input
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
                  onFocus={(e) => e.target.select()}
                  onBlur={() => setPageInput(String(pageRef.current))}
                  style={{ width: `${Math.max(2, String(numPages).length) + 0.6}ch` }}
                  aria-label="Page number"
                />
                <span className="page-total">of {numPages}</span>
              </form>
              <button className="pill-btn" onClick={() => goTo(page + 1)} disabled={page >= numPages} title="Next page">
                <Icon name="chevronDown" size={17} />
              </button>
              <span className="divider" />
              <button className="pill-btn" onClick={() => zoom(-1)} title="Zoom out (Ctrl −)">
                <Icon name="minus" size={17} />
              </button>
              <ZoomMenu scale={scale} onPick={setScaleValue} spread={spread} onToggleSpread={toggleSpread} />
              <button className="pill-btn" onClick={() => zoom(1)} title="Zoom in (Ctrl +)">
                <Icon name="plus" size={17} />
              </button>
              <span className="divider wide-only" />
              <button className="pill-btn wide-only" onClick={rotate} title="Rotate (R)">
                <Icon name="rotate" size={17} />
              </button>
            </div>
          )}

          {focus && (
            <button className="exit-focus" onClick={toggleFocus}>
              <Icon name="close" size={14} /> Exit focus
            </button>
          )}
        </main>
      </div>

      {!doc && <Welcome onPick={pickFile} onOpenBytes={openBytes} onSample={openSample} loading={loading} />}

      {loading && doc && <div className="loading-bar" />}

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="upload" size={30} />
            <p>Drop to open</p>
          </div>
        </div>
      )}

      {pending && (
        <PasswordDialog
          name={pending.name}
          error={pending.error}
          onSubmit={(pw) => openBytes(pending.name, pending.data, pw)}
          onCancel={() => setPending(null)}
        />
      )}
      {dialog === "info" && doc && <InfoDialog pdf={doc.pdf} name={doc.name} size={doc.data.byteLength} onClose={() => setDialog(null)} />}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}

      {updateVersion && (
        <div className="update-card" role="status">
          <div>
            <strong>Folio {updateVersion} is ready</strong>
            <span>Restart to update — or it installs next time you close Folio.</span>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              if (dirty && !confirm("You have unsaved annotations. Restart anyway?")) return;
              window.folioDesktop?.installUpdate();
            }}
          >
            Restart
          </button>
          <button className="pill-btn" onClick={() => setUpdateVersion(null)} aria-label="Later" title="Later">
            <Icon name="close" size={15} />
          </button>
        </div>
      )}

      {(toast || error) && (
        <div className={`toast ${error ? "error" : ""}`} onClick={() => setError(null)}>
          {error ?? toast}
        </div>
      )}
    </div>
  );
}

function IconButton({
  icon,
  label,
  onClick,
  active,
  className = "",
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <button className={`icon-btn ${active ? "on" : ""} ${className}`} onClick={onClick} title={label} aria-label={label} aria-pressed={active}>
      <Icon name={icon} />
    </button>
  );
}
