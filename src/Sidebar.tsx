import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { renderThumbnail, type OutlineItem, type PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";
import { IS_MAC } from "./platform";
import { anchoredScrollTop, loadPageSizes, rowAt, thumbLayout, THUMB_ROW_EXTRA, type PageSize } from "./thumbnails";

interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelectPage: (n: number) => void;
  bookmarkedPages: number[] | null;
  onToggleBookmark: (n: number) => void;
  onSelectDest: (dest: unknown) => void;
  order: number[] | null;
  onOrder: (order: number[] | null) => void;
  onSaveOrder: () => Promise<void>;
  onExportPages: (pages: number[]) => Promise<void>;
  onOpenCopy?: () => void;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  notes: ReactNode;
  noteCount: number;
}

export type SidebarTab = "pages" | "outline" | "notes";

export function Sidebar({ pdf, page, rotation, onSelectPage, onSelectDest, order, onOrder, onSaveOrder, onOpenCopy, onExportPages,
  tab, onTab: setTab, notes, noteCount, bookmarkedPages, onToggleBookmark }: Props) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);

  useEffect(() => {
    setOutline(null);
    pdf.getOutline().then((o) => setOutline((o as OutlineItem[] | null) ?? []));
  }, [pdf]);

  if (order) return (
    <PageOrganizer pdf={pdf} page={page} rotation={rotation} onSelect={onSelectPage}
      order={order} onOrder={onOrder} onSave={onSaveOrder} onOpenCopy={onOpenCopy} />
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
            onSelect={onSelectPage} onExportPages={onExportPages}
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
          <button className="link small" onClick={() => onOrder(Array.from({ length: pdf.numPages }, (_, i) => i + 1))}>
            <Icon name="grid" size={14} /> Reorder pages
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

function PageOrganizer({ pdf, page, rotation, onSelect, order, onOrder, onSave, onOpenCopy }: ThumbnailProps & {
  order: number[];
  onOrder: Props["onOrder"];
  onSave: Props["onSaveOrder"];
  onOpenCopy?: () => void;
}) {
  const [selected, setSelected] = useState(page);
  const [saving, setSaving] = useState(false);
  const position = order.indexOf(selected) + 1;
  const changed = order.some((n, i) => n !== i + 1);

  const select = (n: number) => { setSelected(n); onSelect(n); };
  const move = (source: number, to: number) => {
    if (saving || !Number.isInteger(to) || to < 1 || to > order.length) return;
    const from = order.indexOf(source);
    if (from < 0 || from === to - 1) return;
    const next = order.slice();
    next.splice(from, 1);
    next.splice(to - 1, 0, source);
    onOrder(next);
    select(source);
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

  return (
    <aside className="sidebar" aria-label="Reorder pages">
      <div className="organize-head">
        <strong>Reorder pages</strong>
        <p>Drag a page to its new position, or enter a position below. Save the order as a new PDF.</p>
        <form className="page-field" onSubmit={e => {
          e.preventDefault();
          move(selected, (e.currentTarget.elements.namedItem("position") as HTMLInputElement).valueAsNumber);
        }}>
          <label htmlFor="page-position">Move page {selected} to</label>
          <input key={`${selected}-${position}`} id="page-position" name="position" type="number" required
            min={1} max={order.length} defaultValue={position} disabled={saving} />
          <button className="link small" disabled={saving}>Move</button>
        </form>
      </div>
      <div className="sidebar-scroll">
        <Thumbnails pdf={pdf} page={selected} rotation={rotation} onSelect={select} order={order} onMove={saving ? undefined : move} />
      </div>
      <div className="organize-actions">
        <button className="btn ghost" onClick={() => onOrder(null)} disabled={saving}>{onOpenCopy ? "Done" : "Cancel"}</button>
        <button className="btn primary" onClick={save} disabled={!changed || saving}>{saving ? "Saving…" : "Save reordered copy"}</button>
      </div>
      {onOpenCopy && <div className="organize-actions"><button className="link small" onClick={onOpenCopy}>
        <Icon name="book" size={14} /> Open reordered copy
      </button></div>}
    </aside>
  );
}

type PageMenuTarget = { x: number; y: number; thumbnail: HTMLButtonElement };

function PageExportMenu({ target, count, onExport, onClose }: {
  target: PageMenuTarget; count: number; onExport: () => void; onClose: () => void;
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
  return createPortal(
    <div ref={ref} className="menu page-export-menu" role="menu" aria-label="Page actions" onKeyDown={e => {
      if (e.key === "Escape" || e.key === "Tab") { e.stopPropagation(); dismiss(); }
    }}>
      <button role="menuitem" onClick={() => { dismiss(); onExport(); }}>
        <Icon name="download" size={16} />{count === 1 ? "Export this page…" : `Export ${count} selected pages…`}
      </button>
    </div>, document.body);
}

function Thumbnails({ pdf, page, rotation, onSelect, order, onMove, onExportPages, bookmarkedPages, onToggleBookmark, bookmarkedOnly = false }: ThumbnailProps & {
  order?: number[];
  onMove?: (source: number, to: number) => void;
  onExportPages?: Props["onExportPages"];
  bookmarkedPages?: Props["bookmarkedPages"];
  onToggleBookmark?: Props["onToggleBookmark"];
  bookmarkedOnly?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragType = `application/x-folio-page-${pdf.loadingTask.docId.toLowerCase()}`;
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [sizes, setSizes] = useState<(PageSize | undefined)[] | null>(null);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const pages = useMemo(() => {
    if (order || !bookmarkedOnly) return order;
    return (bookmarkedPages ?? []).filter(n => Number.isInteger(n) && n >= 1 && n <= pdf.numPages);
  }, [order, bookmarkedOnly, bookmarkedPages, pdf.numPages]);
  const count = pages?.length ?? pdf.numPages;
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const anchor = useRef<number | null>(null);
  const [menu, setMenu] = useState<PageMenuTarget | null>(null);
  useLayoutEffect(() => {
    setPicked(null);
    setMenu(null);
    anchor.current = null;
  }, [bookmarkedOnly]);
  const selected = useMemo(() => {
    const selection = picked ?? new Set([page]);
    return bookmarkedOnly && pages ? new Set(pages.filter(n => selection.has(n))) : selection;
  }, [picked, page, pages, bookmarkedOnly]);
  const select = (n: number, e: ReactMouseEvent) => {
    if (!onExportPages) { onSelect(n); return; }
    const toggle = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.shiftKey) {
      const base = anchor.current ?? page;
      const start = pages && !pages.includes(base) ? n : base;
      const first = Math.min(start, n), last = Math.max(start, n);
      const next = toggle ? new Set(selected) : new Set<number>();
      if (pages) {
        for (const i of pages) if (i >= first && i <= last) next.add(i);
      } else {
        for (let i = first; i <= last; i++) next.add(i);
      }
      setPicked(next);
    } else if (toggle) {
      const next = new Set(selected);
      if (next.has(n)) next.delete(n); else next.add(n);
      setPicked(next);
      anchor.current = n;
    } else {
      setPicked(null);
      anchor.current = null;
      onSelect(n);
    }
  };
  const openMenu = (thumbnail: HTMLButtonElement, x: number, y: number) => {
    const n = Number(thumbnail.dataset.page);
    if (selected.has(n)) setPicked(selected);
    else { setPicked(new Set([n])); anchor.current = n; }
    setMenu({ x, y, thumbnail });
  };
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const loaderRef = useRef<ReturnType<typeof loadPageSizes> | null>(null);
  // Filtering or reordering changes which page belongs in a row, but keeps the scale of the full document.
  const layout = useMemo(() => thumbLayout(sizes, pdf.numPages, rotation, pages), [sizes, pdf, rotation, pages]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const activeIndex = pages ? Math.max(0, pages.indexOf(page)) : page - 1;
  const thumbPage = (target: EventTarget) => Number((target as Element).closest<HTMLElement>(".thumb")?.dataset.page);

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
        const source = thumbPage(e.target);
        if (!source) return;
        // The virtual list may unmount the source before dragend. Keep this drag out of the file opener.
        e.stopPropagation();
        e.dataTransfer.clearData();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(dragType, String(source));
      }}
      onDragOver={e => {
        if (!onMove || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(thumbPage(e.target) || null);
      }}
      onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }}
      onDrop={e => {
        if (!onMove || !order || !e.dataTransfer.types.includes(dragType)) return;
        e.preventDefault();
        const target = thumbPage(e.target);
        if (target) onMove(Number(e.dataTransfer.getData(dragType)), order.indexOf(target) + 1);
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
        return <Thumb key={`${n}-${rotation}`} pdf={pdf} n={n} size={layout.frames[index]} rotation={rotation} active={page === n}
          selected={onExportPages ? selected.has(n) : undefined} showSelection={picked !== null || !!menu}
          bookmarked={bookmarkedPages?.includes(n)} onToggleBookmark={onToggleBookmark}
          position={order ? index + 1 : undefined} draggable={!!onMove} dropTarget={dropTarget === n} onSelect={select} />;
      })}
      <div aria-hidden="true" style={{ height: Math.max(0, total - (layout.tops[end] ?? total)), flexShrink: 0 }} />
      {menu && selected.size > 0 && onExportPages && <PageExportMenu target={menu} count={selected.size}
        onClose={() => setMenu(null)} onExport={() => void onExportPages([...selected].sort((a, b) => a - b))} />}
    </div>
  );
}

const Thumb = memo(function Thumb({
  pdf,
  n,
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
  size: { width: number; height: number };
  rotation: number;
  active: boolean;
  selected?: boolean;
  showSelection: boolean;
  position?: number;
  draggable: boolean;
  dropTarget: boolean;
  onSelect: (n: number, e: ReactMouseEvent) => void;
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
      <button ref={ref} id={id} data-page={n} draggable={draggable} className={`thumb ${(showSelection ? selected : active) ? "on" : ""} ${dropTarget ? "drop-target" : ""}`}
        onClick={e => onSelect(n, e)} aria-current={active ? "page" : undefined} aria-pressed={selected} aria-haspopup={selected !== undefined ? "menu" : undefined}
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
            e.preventDefault(); ref.current?.focus({ preventScroll: true }); onSelect(n, e);
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
