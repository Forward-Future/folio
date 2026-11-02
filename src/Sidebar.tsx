import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderThumbnail, type OutlineItem, type PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";
import { anchoredScrollTop, loadPageSizes, rowAt, thumbLayout, THUMB_ROW_EXTRA, type PageSize } from "./thumbnails";

interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelectPage: (n: number) => void;
  onSelectDest: (dest: unknown) => void;
  order: number[] | null;
  onOrder: (order: number[] | null) => void;
  onSaveOrder: () => Promise<void>;
  onOpenCopy?: () => void;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  notes: ReactNode;
  noteCount: number;
}

export type SidebarTab = "pages" | "outline" | "notes";

export function Sidebar({ pdf, page, rotation, onSelectPage, onSelectDest, order, onOrder, onSaveOrder, onOpenCopy,
  tab, onTab: setTab, notes, noteCount }: Props) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);

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
      <div className="sidebar-scroll">
        {tab === "notes" ? (
          notes
        ) : tab === "pages" ? (
          <Thumbnails pdf={pdf} page={page} rotation={rotation} onSelect={onSelectPage} />
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

function Thumbnails({ pdf, page, rotation, onSelect, order, onMove }: ThumbnailProps & {
  order?: number[];
  onMove?: (source: number, to: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const dragType = `application/x-folio-page-${pdf.loadingTask.docId.toLowerCase()}`;
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [sizes, setSizes] = useState<(PageSize | undefined)[] | null>(null);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const orderRef = useRef(order);
  orderRef.current = order;
  const loaderRef = useRef<ReturnType<typeof loadPageSizes> | null>(null);
  // Rows follow the organizer's order, so a moved page takes its own shape with it.
  const layout = useMemo(() => thumbLayout(sizes, pdf.numPages, rotation, order), [sizes, pdf, rotation, order]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const activeIndex = order ? order.indexOf(page) : page - 1;
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
    loader.prioritize(rangeRef.current.start, rangeRef.current.end, orderRef.current);
    return () => {
      loader.stop();
      cancelAnimationFrame(frame);
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [pdf]);

  useEffect(() => {
    loaderRef.current?.prioritize(range.start, range.end, order);
  }, [range, order]);

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
      const start = Math.min(pdf.numPages - 1, Math.max(0, rowAt(layout.tops, scroll.scrollTop) - 4));
      const end = Math.min(pdf.numPages, rowAt(layout.tops, scroll.scrollTop + scroll.clientHeight) + 1 + 4);
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
  }, [pdf, layout]);

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
  }, [pdf, activeIndex, rotation]);

  const total = layout.tops[pdf.numPages] ?? 0;
  // The first render, before anything is measured, can ask for more rows than a short document has.
  const end = Math.min(range.end, pdf.numPages);
  return (
    <div className="thumbs" ref={listRef} style={{ gap: 0 }}
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
      <div aria-hidden="true" style={{ height: layout.tops[range.start] ?? 0, flexShrink: 0 }} />
      {Array.from({ length: Math.max(0, end - range.start) }, (_, i) => {
        const index = range.start + i;
        const n = order?.[index] ?? index + 1;
        return <Thumb key={`${n}-${rotation}`} pdf={pdf} n={n} size={layout.frames[index]} rotation={rotation} active={page === n}
          position={order ? index + 1 : undefined} draggable={!!onMove} dropTarget={dropTarget === n} onSelect={onSelect} />;
      })}
      <div aria-hidden="true" style={{ height: Math.max(0, total - (layout.tops[end] ?? total)), flexShrink: 0 }} />
    </div>
  );
}

const Thumb = memo(function Thumb({
  pdf,
  n,
  size,
  rotation,
  active,
  position,
  draggable,
  dropTarget,
  onSelect,
}: {
  pdf: PDFDocumentProxy;
  n: number;
  size: { width: number; height: number };
  rotation: number;
  active: boolean;
  position?: number;
  draggable: boolean;
  dropTarget: boolean;
  onSelect: (n: number) => void;
}) {
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
    <button ref={ref} data-page={n} draggable={draggable} className={`thumb ${active ? "on" : ""} ${dropTarget ? "drop-target" : ""}`}
      style={{ height: size.height + THUMB_ROW_EXTRA, flexShrink: 0 }} onClick={() => onSelect(n)}
      aria-label={position ? `Page ${n}, position ${position}` : `Page ${n}`}>
      <div className="thumb-frame" style={{ width: size.width, height: size.height, flexShrink: 0 }}>
        <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
      </div>
      <span className="thumb-num">{position ? `${position} · Page ${n}` : n}</span>
    </button>
  );
});
