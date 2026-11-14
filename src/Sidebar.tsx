import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { renderThumbnail, type OutlineItem, type PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";
import { deletePages, draftChanged, movePage, pageKey, startDraft, stepDraft, withPages, type DraftPage, type PageDraft } from "./organize";
import { IS_MAC, keys } from "./platform";
import { anchoredScrollTop, loadPageSizes, rowAt, thumbLayout, THUMB_ROW_EXTRA, type PageSize } from "./thumbnails";

interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelectPage: (n: number) => void;
  bookmarkedPages: number[] | null;
  onToggleBookmark: (n: number) => void;
  onSelectDest: (dest: unknown) => void;
  draft: PageDraft | null;
  onDraft: (draft: PageDraft | null) => void;
  onSaveDraft: () => Promise<void>;
  onExportPages: (pages: number[]) => Promise<void>;
  onOpenCopy?: () => void;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  notes: ReactNode;
  noteCount: number;
}

export type SidebarTab = "pages" | "outline" | "notes";

type PageAction = "delete";

export function Sidebar({ pdf, page, rotation, onSelectPage, onSelectDest, draft, onDraft, onSaveDraft, onOpenCopy, onExportPages,
  tab, onTab: setTab, notes, noteCount, bookmarkedPages, onToggleBookmark }: Props) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [organizerPick, setOrganizerPick] = useState<string[] | null>(null);

  useEffect(() => {
    setOutline(null);
    pdf.getOutline().then((o) => setOutline((o as OutlineItem[] | null) ?? []));
  }, [pdf]);

  // The thumbnail menu opens the organizer with its change already made, so Undo can take it back.
  const organize = (pages?: number[], action?: PageAction) => {
    const start = startDraft(pdf.numPages);
    let pick = pages?.map(String) ?? null;
    let next = start;
    if (action === "delete" && pick) {
      const result = deletePages(start.pages, new Set(pick));
      next = withPages(start, result.pages);
      pick = [pageKey(result.next)];
    }
    setOrganizerPick(pick);
    onDraft(next);
  };

  if (draft) return (
    <PageOrganizer pdf={pdf} page={page} rotation={rotation} onSelect={onSelectPage}
      draft={draft} onDraft={onDraft} onSave={onSaveDraft} onOpenCopy={onOpenCopy} initialPick={organizerPick} />
  );
  return (
    <aside className={`sidebar tab-${tab}`}>
      <div className="sidebar-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pages"} className={tab === "pages" ? "on" : ""} onClick={() => setTab("pages")}>
          Pages
        </button>
        <button role="tab" aria-selected={tab === "outline"} className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>
          Outline
        </button>
        <button role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
          Notes{noteCount > 0 && <span className="tab-count">{noteCount}</span>}
        </button>
      </div>
      {tab === "pages" && (
        <button type="button" className="bookmark-filter" aria-pressed={bookmarkedOnly} disabled={bookmarkedPages === null}
          title={bookmarkedOnly ? "Show all pages" : "Show bookmarked pages"} onClick={() => setBookmarkedOnly(only => !only)}>
          <Icon name="bookmark" size={13} /> Bookmarked
        </button>
      )}
      <div className="sidebar-scroll">
        {tab === "notes" ? (
          notes
        ) : tab === "pages" ? (
          <Thumbnails pdf={pdf} page={page} rotation={rotation}
            onSelect={onSelectPage} onExportPages={onExportPages} onOrganize={organize}
            bookmarkedPages={bookmarkedPages} onToggleBookmark={onToggleBookmark} bookmarkedOnly={bookmarkedOnly} />
        ) : outline === null ? null : outline.length === 0 ? (
          <div className="empty-outline">
            <Icon name="list" size={22} />
            <p>This document has no outline.</p>
          </div>
        ) : (
          <ul className="outline">
            {outline.map((item, i) => (
              <OutlineNode key={i} item={item} onSelect={onSelectDest} depth={0} />
            ))}
          </ul>
        )}
      </div>
      {tab !== "notes" && pdf.numPages > 1 && (
        <div className="organize-actions">
          <button className="link small" onClick={() => organize()}>
            <Icon name="grid" size={14} /> Organize pages
          </button>
        </div>
      )}
    </aside>
  );
}

function OutlineNode({ item, onSelect, depth }: { item: OutlineItem; onSelect: (d: unknown) => void; depth: number }) {
  const [open, setOpen] = useState(depth === 0 && item.items.length < 12);
  const hasKids = item.items.length > 0;
  return (
    <li>
      <div className="outline-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <button className={`outline-toggle ${hasKids ? "" : "hidden"} ${open ? "open" : ""}`} onClick={() => setOpen(!open)} tabIndex={hasKids ? 0 : -1} aria-label="Expand">
          <Icon name="chevronRight" size={13} />
        </button>
        <button
          className="outline-title"
          onClick={() => (item.url ? window.open(item.url, "_blank", "noopener") : item.dest && onSelect(item.dest))}
          title={item.title}
        >
          {item.title}
        </button>
      </div>
      {hasKids && open && (
        <ul>
          {item.items.map((child, i) => (
            <OutlineNode key={i} item={child} onSelect={onSelect} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

interface ThumbnailProps {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelect: (n: number) => void;
}

/** A row of the thumbnail list: which page it shows, and its key in the organizer's draft. */
interface ThumbRow { key: string; page: number }

// Ctrl-click (⌘-click on macOS) toggles a page, Shift-click selects the range from the anchor.
// Returns null for a plain click, which selects just that page.
function extendSelection(e: ReactMouseEvent, key: string, keys: readonly string[], selected: ReadonlySet<string>, anchor: string | null) {
  const toggle = IS_MAC ? e.metaKey : e.ctrlKey;
  if (e.shiftKey) {
    const to = keys.indexOf(key);
    const from = anchor === null ? -1 : keys.indexOf(anchor);
    const start = from < 0 ? to : from;
    const next = toggle ? new Set(selected) : new Set<string>();
    for (let i = Math.min(start, to); i <= Math.max(start, to); i++) next.add(keys[i]);
    return next;
  }
  if (!toggle) return null;
  const next = new Set(selected);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

function PageOrganizer({ pdf, page, rotation, onSelect, draft, onDraft, onSave, onOpenCopy, initialPick }: ThumbnailProps & {
  draft: PageDraft;
  onDraft: Props["onDraft"];
  onSave: Props["onSaveDraft"];
  onOpenCopy?: () => void;
  initialPick: string[] | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [picked, setPicked] = useState(() => new Set(initialPick ?? [String(page)]));
  const [anchor, setAnchor] = useState<string | null>(() => initialPick?.at(-1) ?? String(page));
  const [saving, setSaving] = useState(false);
  // A thumbnail-menu action replaces the thumbnail that had focus. Focus its page here once the list draws it.
  useEffect(() => {
    const key = initialPick?.at(-1);
    if (key === undefined) return;
    let frame = 0, tries = 0;
    const focus = () => {
      const thumb = ref.current?.querySelector<HTMLElement>(`.thumb[data-key="${CSS.escape(key)}"]`);
      if (thumb) thumb.focus({ preventScroll: true });
      else if (++tries < 30) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, []);
  const rows = useMemo(() => draft.pages.map((p): ThumbRow => ({ key: pageKey(p), page: p.page })), [draft.pages]);
  const rowKeys = useMemo(() => rows.map(row => row.key), [rows]);
  const selected = useMemo(() => rowKeys.filter(key => picked.has(key)), [rowKeys, picked]);
  const activeKey = anchor !== null && picked.has(anchor) && rowKeys.includes(anchor) ? anchor : selected[0];
  const position = activeKey === undefined ? 0 : rowKeys.indexOf(activeKey) + 1;
  const active = rows[position - 1] as ThumbRow | undefined;
  const changed = draftChanged(draft, pdf.numPages);
  const canDelete = !saving && selected.length > 0 && selected.length < rows.length;

  const choose = (keys: string[]) => { setPicked(new Set(keys)); setAnchor(keys.at(-1) ?? null); };
  const change = (pages: DraftPage[]) => onDraft(withPages(draft, pages));
  const pick = (key: string, e: ReactMouseEvent) => {
    const next = extendSelection(e, key, rowKeys, new Set(selected), activeKey ?? null);
    if (next) {
      setPicked(next);
      if (!e.shiftKey) setAnchor(key);
    } else {
      choose([key]);
      onSelect(rows[rowKeys.indexOf(key)].page);
    }
  };
  const move = (key: string, to: number) => {
    const next = saving ? null : movePage(draft.pages, key, to - 1);
    if (!next) return;
    change(next);
    choose([key]);
    onSelect(rows[rowKeys.indexOf(key)].page);
  };
  const remove = () => {
    if (!canDelete) return;
    const result = deletePages(draft.pages, new Set(selected));
    change(result.pages);
    choose([pageKey(result.next)]);
  };
  // Undo selects the pages it brings back, so the reader sees what returned.
  const step = (back: boolean) => {
    const next = saving ? draft : stepDraft(draft, back);
    if (next === draft) return;
    const before = new Set(rowKeys);
    const restored = next.pages.map(pageKey).filter(key => !before.has(key));
    onDraft(next);
    if (restored.length) choose(restored);
  };
  const save = async () => {
    if (saving || !changed) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  // While organizing, these keys edit the draft rather than the reader's highlights and drawings.
  const shortcut = useRef<(e: KeyboardEvent) => boolean>(null!);
  shortcut.current = e => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && (key === "z" || key === "y")) { step(key === "z" && !e.shiftKey); return true; }
    if (!mod && !e.altKey && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace")) { remove(); return true; }
    return false;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element;
      if (target !== document.body && (!ref.current?.contains(target) || target.closest("input, textarea, select"))) return;
      if (shortcut.current(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <aside ref={ref} className="sidebar" aria-label="Organize pages">
      <div className="organize-head">
        <strong>Organize pages</strong>
        <p>Drag a page to move it. {keys("Ctrl")}-click or Shift-click to select several pages. Save the result as a new PDF.</p>
        <div className="organize-tools" role="toolbar" aria-label="Page tools">
          <button className="pill-btn" onClick={remove} disabled={!canDelete}
            aria-label={selected.length > 1 ? `Delete ${selected.length} pages` : "Delete page"} title="Delete (Delete)">
            <Icon name="trash" size={16} />
          </button>
          <span className="organize-tools-gap" />
          <button className="pill-btn" onClick={() => step(true)} disabled={saving || !draft.undo.length}
            aria-label="Undo" title={keys("Undo (Ctrl+Z)")}>
            <Icon name="undo" size={16} />
          </button>
          <button className="pill-btn" onClick={() => step(false)} disabled={saving || !draft.redo.length}
            aria-label="Redo" title={keys("Redo (Ctrl+Shift+Z)")}>
            <Icon name="redo" size={16} />
          </button>
        </div>
        {active && <form className="page-field" onSubmit={e => {
          e.preventDefault();
          move(active.key, (e.currentTarget.elements.namedItem("position") as HTMLInputElement).valueAsNumber);
        }}>
          <label htmlFor="page-position">Move page {active.page} to</label>
          <input key={`${active.key}-${position}`} id="page-position" name="position" type="number" required
            min={1} max={rows.length} defaultValue={position} disabled={saving} />
          <button className="link small" disabled={saving}>Move</button>
        </form>}
      </div>
      <div className="sidebar-scroll">
        <Thumbnails pdf={pdf} page={active?.page ?? page} rotation={rotation} onSelect={onSelect}
          rows={rows} activeKey={activeKey} picks={{ selected: picked, onPick: pick }} onMove={saving ? undefined : move} />
      </div>
      <div className="organize-actions">
        <button className="btn ghost" onClick={() => onDraft(null)} disabled={saving}>{onOpenCopy ? "Done" : "Cancel"}</button>
        <button className="btn primary" onClick={save} disabled={!changed || saving}>{saving ? "Saving…" : "Save organized copy"}</button>
      </div>
      {onOpenCopy && <div className="organize-actions"><button className="link small" onClick={onOpenCopy}>
        <Icon name="book" size={14} /> Open organized copy
      </button></div>}
    </aside>
  );
}

type PageMenuTarget = { x: number; y: number; thumbnail: HTMLButtonElement };

function PageMenu({ target, count, all, onExport, onOrganize, onClose }: {
  target: PageMenuTarget; count: number; all: boolean; onExport: () => void; onOrganize: (action: PageAction) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.left = Math.max(4, Math.min(target.x, window.innerWidth - el.offsetWidth - 4)) + "px";
    el.style.top = Math.max(4, Math.min(target.y, window.innerHeight - el.offsetHeight - 4)) + "px";
    el.querySelector("button")!.focus({ preventScroll: true });
  }, [target]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const dismiss = () => { onClose(); target.thumbnail.focus({ preventScroll: true }); };
  const run = (action: () => void) => () => { dismiss(); action(); };
  return createPortal(
    <div ref={ref} className="menu page-export-menu" role="menu" aria-label="Page actions" onKeyDown={e => {
      if (e.key === "Escape" || e.key === "Tab") { e.stopPropagation(); dismiss(); }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }}>
      <button role="menuitem" onClick={run(() => onOrganize("delete"))} disabled={all}
        title={all ? "A PDF needs at least one page." : undefined}>
        <Icon name="trash" size={16} />{count === 1 ? "Delete page" : `Delete ${count} pages`}
      </button>
      <hr />
      <button role="menuitem" onClick={run(onExport)}>
        <Icon name="download" size={16} />{count === 1 ? "Export this page…" : `Export ${count} selected pages…`}
      </button>
    </div>, document.body);
}

function Thumbnails({ pdf, page, rotation, onSelect, rows, activeKey, picks, onMove, onExportPages, onOrganize, bookmarkedPages,
  onToggleBookmark, bookmarkedOnly = false }: ThumbnailProps & {
  /** The organizer's pages, in their draft order. */
  rows?: ThumbRow[];
  activeKey?: string;
  /** The organizer keeps its own selection. */
  picks?: { selected: ReadonlySet<string>; onPick: (key: string, e: ReactMouseEvent) => void };
  onMove?: (key: string, to: number) => void;
  onExportPages?: Props["onExportPages"];
  onOrganize?: (pages: number[], action: PageAction) => void;
  bookmarkedPages?: Props["bookmarkedPages"];
  onToggleBookmark?: Props["onToggleBookmark"];
  bookmarkedOnly?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragType = `application/x-folio-page-${pdf.loadingTask.docId.toLowerCase()}`;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [sizes, setSizes] = useState<(PageSize | undefined)[] | null>(null);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const pages = useMemo(() => {
    if (rows) return rows.map(row => row.page);
    if (!bookmarkedOnly) return undefined;
    return (bookmarkedPages ?? []).filter(n => Number.isInteger(n) && n >= 1 && n <= pdf.numPages);
  }, [rows, bookmarkedOnly, bookmarkedPages, pdf.numPages]);
  const count = pages?.length ?? pdf.numPages;
  const rowKeys = useMemo(() => rows ? rows.map(row => row.key) : Array.from({ length: count }, (_, i) => String(pages?.[i] ?? i + 1)),
    [rows, pages, count]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const [menu, setMenu] = useState<PageMenuTarget | null>(null);
  useLayoutEffect(() => {
    setPicked(null);
    setMenu(null);
    anchor.current = null;
  }, [bookmarkedOnly]);
  const selected = useMemo(() => {
    if (picks) return picks.selected;
    const selection = picked ?? new Set([String(page)]);
    return bookmarkedOnly ? new Set(rowKeys.filter(key => selection.has(key))) : selection;
  }, [picks, picked, page, rowKeys, bookmarkedOnly]);
  const select = (key: string, e: ReactMouseEvent) => {
    if (picks) { picks.onPick(key, e); return; }
    if (!onExportPages) { onSelect(Number(key)); return; }
    const next = extendSelection(e, key, rowKeys, selected, anchor.current ?? String(page));
    if (next) {
      setPicked(next);
      if (!e.shiftKey) anchor.current = key;
    } else {
      setPicked(null);
      anchor.current = null;
      onSelect(Number(key));
    }
  };
  const openMenu = (thumbnail: HTMLButtonElement, x: number, y: number) => {
    const key = thumbnail.dataset.key!;
    if (selected.has(key)) setPicked(new Set(selected));
    else { setPicked(new Set([key])); anchor.current = key; }
    setMenu({ x, y, thumbnail });
  };
  const menuPages = () => [...selected].map(Number).sort((a, b) => a - b);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const loaderRef = useRef<ReturnType<typeof loadPageSizes> | null>(null);
  // Filtering or reordering changes which page belongs in a row, but keeps the scale of the full document.
  const layout = useMemo(() => thumbLayout(sizes, pdf.numPages, rotation, pages), [sizes, pdf, rotation, pages]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const activeIndex = rows ? Math.max(0, rowKeys.indexOf(activeKey!)) : pages ? Math.max(0, pages.indexOf(page)) : page - 1;
  const thumbKey = (target: EventTarget) => (target as Element).closest<HTMLElement>(".thumb")?.dataset.key;

  // Every page's own size, so a drawing sheet or a landscape page isn't squeezed into page 1's shape.
  // Sizes arrive a few at a time, visible rows first, and are applied once per frame.
  useEffect(() => {
    setSizes(null);
    const known: (PageSize | undefined)[] = new Array(pdf.numPages);
    let frame = 0;
    const loader = loadPageSizes(pdf, (index, size) => {
      known[index] = size;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        setSizes(known.slice());
      });
    });
    loaderRef.current = loader;
    loader.prioritize(rangeRef.current.start, rangeRef.current.end, pagesRef.current);
    return () => {
      loader.stop();
      cancelAnimationFrame(frame);
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [pdf]);

  useEffect(() => {
    loaderRef.current?.prioritize(range.start, range.end, pages);
  }, [range, pages]);

  // As sizes arrive, rows above the viewport change height. Keep the row at the top of the list where it was
  // so the thumbnails don't drift while the reader looks at them.
  const anchorRef = useRef({ pdf, tops: layout.tops });
  useLayoutEffect(() => {
    const previous = anchorRef.current;
    anchorRef.current = { pdf, tops: layout.tops };
    if (previous.pdf !== pdf || previous.tops === layout.tops) return;
    const scroll = listRef.current!.parentElement!;
    const next = anchoredScrollTop(previous.tops, layout.tops, scroll.scrollTop);
    if (Math.abs(next - scroll.scrollTop) >= 1) scroll.scrollTop = next;
  }, [pdf, layout]);

  useEffect(() => {
    const scroll = listRef.current!.parentElement!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const start = Math.max(0, Math.min(count - 1, rowAt(layout.tops, scroll.scrollTop) - 4));
      const end = Math.min(count, rowAt(layout.tops, scroll.scrollTop + scroll.clientHeight) + 5);
      setRange(previous => previous.start === start && previous.end === end ? previous : { start, end });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    scroll.addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
    };
  }, [count, layout]);

  // Keep the active thumbnail in view as the reader scrolls. Not on every size update, or the list would
  // snap back to the active page while the reader scrolls it during loading.
  useEffect(() => {
    if (activeIndex < 0) return;
    const { tops } = layoutRef.current;
    const scroll = listRef.current!.parentElement!;
    const top = tops[activeIndex] ?? 0;
    const rowHeight = (tops[activeIndex + 1] ?? top) - top;
    if (top < scroll.scrollTop || top + rowHeight > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = Math.max(0, top - (scroll.clientHeight - rowHeight) / 2);
      scroll.dispatchEvent(new Event("scroll"));
    }
  }, [pdf, activeIndex, rotation, bookmarkedOnly]);

  const total = layout.tops[count];
  // The first render, before anything is measured, can ask for more rows than a short document has.
  const end = Math.min(range.end, count);
  return (
    <div className="thumbs" ref={listRef} style={{ gap: 0 }}
      onContextMenu={e => {
        if (!onExportPages) return;
        const target = e.target as Element;
        if (!target.closest(".thumb, .thumb-num")) return;
        const thumbnail = target.closest(".thumb-row")?.querySelector<HTMLButtonElement>(".thumb");
        if (!thumbnail) return;
        e.preventDefault();
        openMenu(thumbnail, e.clientX, e.clientY);
      }}
      onKeyDown={e => {
        if (!onExportPages || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
        const thumbnail = (e.target as Element).closest<HTMLButtonElement>(".thumb");
        if (!thumbnail) return;
        e.preventDefault(); e.stopPropagation();
        const box = thumbnail.getBoundingClientRect();
        openMenu(thumbnail, box.left + box.width / 2, box.top + box.height / 2);
      }}
      onDragStart={e => {
        if (!onMove) return;
        const source = thumbKey(e.target);
        if (!source) return;
        // The virtual list may unmount the source before dragend. Keep this drag out of the file opener.
        e.stopPropagation();
        e.dataTransfer.clearData();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(dragType, source);
      }}
      onDragOver={e => {
        if (!onMove || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(thumbKey(e.target) ?? null);
      }}
      onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }}
      onDrop={e => {
        if (!onMove || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        const target = thumbKey(e.target);
        if (target) onMove(e.dataTransfer.getData(dragType), rowKeys.indexOf(target) + 1);
        setDropTarget(null);
      }}
      onDragEnd={() => setDropTarget(null)}>
      {count === 0 && <div className="empty-outline" role="status">
        <Icon name="bookmark" size={22} />
        <p>No bookmarked pages yet.</p>
      </div>}
      <div aria-hidden="true" style={{ height: layout.tops[Math.min(range.start, count)], flexShrink: 0 }} />
      {Array.from({ length: Math.max(0, end - range.start) }, (_, i) => {
        const index = range.start + i;
        const n = pages?.[index] ?? index + 1;
        const key = rowKeys[index];
        return <Thumb key={`${key}-${rotation}`} pdf={pdf} n={n} rowKey={key} size={layout.frames[index]} rotation={rotation}
          active={rows ? key === activeKey : page === n}
          selected={onExportPages || picks ? selected.has(key) : undefined} showSelection={!!picks || picked !== null || !!menu}
          bookmarked={bookmarkedPages?.includes(n)} onToggleBookmark={onToggleBookmark}
          position={rows ? index + 1 : undefined} draggable={!!onMove} dropTarget={dropTarget === key} onSelect={select} />;
      })}
      <div aria-hidden="true" style={{ height: Math.max(0, total - (layout.tops[end] ?? total)), flexShrink: 0 }} />
      {menu && selected.size > 0 && onExportPages && onOrganize && <PageMenu target={menu} count={selected.size}
        all={selected.size >= pdf.numPages} onClose={() => setMenu(null)}
        onExport={() => void onExportPages(menuPages())} onOrganize={action => onOrganize(menuPages(), action)} />}
    </div>
  );
}

const Thumb = memo(function Thumb({
  pdf,
  n,
  rowKey,
  size,
  rotation,
  active,
  selected,
  showSelection,
  position,
  draggable,
  dropTarget,
  onSelect,
  bookmarked,
  onToggleBookmark,
}: {
  pdf: PDFDocumentProxy;
  n: number;
  rowKey: string;
  size: { width: number; height: number };
  rotation: number;
  active: boolean;
  selected?: boolean;
  showSelection: boolean;
  position?: number;
  draggable: boolean;
  dropTarget: boolean;
  onSelect: (key: string, e: ReactMouseEvent) => void;
  bookmarked?: boolean;
  onToggleBookmark?: Props["onToggleBookmark"];
}) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    let cancelled = false;
    const controller = new AbortController();
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        renderThumbnail(pdf, n, canvasRef.current!, size.width, rotation, controller.signal)
          .then(() => !cancelled && setReady(true))
          .catch(() => {});
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      controller.abort();
      io.disconnect();
    };
  }, [pdf, n, rotation, size.width]);

  return (
    <div className="thumb-row" style={{ height: size.height + THUMB_ROW_EXTRA }}>
      <button ref={ref} id={id} data-page={n} data-key={rowKey} draggable={draggable}
        className={`thumb ${(showSelection ? selected : active) ? "on" : ""} ${dropTarget ? "drop-target" : ""}`}
        onClick={e => onSelect(rowKey, e)} aria-current={active ? "page" : undefined} aria-pressed={selected}
        aria-haspopup={selected !== undefined && !position ? "menu" : undefined}
        aria-label={position ? `Page ${n}, position ${position}` : `Page ${n}`}>
        <span className="thumb-frame" style={{ width: size.width, height: size.height, flexShrink: 0 }}>
          <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
          {showSelection && selected && <span className="thumb-check"><Icon name="check" size={13} /></span>}
        </span>
        {position && <span className="thumb-num">{position} · Page {n}</span>}
      </button>
      {onToggleBookmark && <div className="thumb-caption">
        <label className="thumb-num" htmlFor={id} onClick={e => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) {
            e.preventDefault(); ref.current?.focus({ preventScroll: true }); onSelect(rowKey, e);
          }
        }}>{n}</label>
        <button type="button" className="thumb-bookmark" disabled={bookmarked === undefined}
          aria-label={`Bookmark page ${n}`} aria-pressed={bookmarked ?? false}
          title={bookmarked ? `Remove bookmark from page ${n}` : `Bookmark page ${n}`} onClick={() => onToggleBookmark(n)}>
          <Icon name="bookmark" size={15} />
        </button>
      </div>}
    </div>
  );
});
