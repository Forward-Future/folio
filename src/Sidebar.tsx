import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderThumbnail, type OutlineItem, type PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";

interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelectPage: (n: number) => void;
  onSelectDest: (dest: unknown) => void;
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  notes: ReactNode;
  noteCount: number;
}

export type SidebarTab = "pages" | "outline" | "notes";

export function Sidebar({ pdf, page, rotation, onSelectPage, onSelectDest, tab, onTab: setTab, notes, noteCount }: Props) {
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);

  useEffect(() => {
    setOutline(null);
    pdf.getOutline().then((o) => setOutline((o as OutlineItem[] | null) ?? []));
  }, [pdf]);

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

function Thumbnails({ pdf, page, rotation, onSelect }: { pdf: PDFDocumentProxy; page: number; rotation: number; onSelect: (n: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const layout = useMemo(() => thumbLayout(sizes, pdf.numPages, rotation), [sizes, pdf, rotation]);

  // Every page's own size, so a drawing sheet or a landscape page isn't squeezed into page 1's shape.
  useEffect(() => {
    let cancelled = false;
    setSizes(null);
    Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((p) => {
      const vp = p.getViewport({ scale: 1, rotation: p.rotate });
      return { width: vp.width, height: vp.height };
    }))).then((all) => { if (!cancelled) setSizes(all); }).catch(() => {});
    return () => { cancelled = true; };
  }, [pdf]);

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

  // Keep the active thumbnail in view as the reader scrolls.
  useEffect(() => {
    const scroll = listRef.current!.parentElement!;
    const top = layout.tops[page - 1] ?? 0;
    const rowHeight = (layout.tops[page] ?? top) - top;
    if (top < scroll.scrollTop || top + rowHeight > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = Math.max(0, top - (scroll.clientHeight - rowHeight) / 2);
      scroll.dispatchEvent(new Event("scroll"));
    }
  }, [pdf, page, layout]);

  const total = layout.tops[pdf.numPages] ?? 0;
  // The first render, before anything is measured, can ask for more rows than a short document has.
  const end = Math.min(range.end, pdf.numPages);
  return (
    <div className="thumbs" ref={listRef} style={{ gap: 0 }}>
      <div aria-hidden="true" style={{ height: layout.tops[range.start] ?? 0, flexShrink: 0 }} />
      {Array.from({ length: Math.max(0, end - range.start) }, (_, index) => {
        const n = range.start + index + 1;
        return <Thumb key={`${n}-${rotation}`} pdf={pdf} n={n} size={layout.frames[n - 1]} rotation={rotation} active={page === n} onSelect={onSelect} />;
      })}
      <div aria-hidden="true" style={{ height: Math.max(0, total - (layout.tops[end] ?? total)), flexShrink: 0 }} />
    </div>
  );
}

const THUMB_W = 132;
// The tallest a thumbnail may be, so one long page can't fill the sidebar.
const THUMB_MAX_H = 212;
// Room below each thumbnail for its padding and page number.
const THUMB_ROW_EXTRA = 48;
// Thumbnails share one scale so pages keep their relative sizes, but none gets too small to recognize.
const THUMB_MIN = 40;

interface PageSize { width: number; height: number }

// One scale for every page, set by the largest page, so a letter page looks smaller than an 11x17 sheet beside it.
// A document of one page size comes out exactly as before: THUMB_W wide.
function thumbLayout(sizes: PageSize[] | null, count: number, rotation: number) {
  const turned = rotation % 180 !== 0;
  const pages = Array.from({ length: count }, (_, i) => {
    const s = sizes?.[i] ?? { width: 612, height: 792 };
    return turned ? { width: s.height, height: s.width } : s;
  });
  // A loop rather than Math.max(...pages), which overflows the stack on very long documents.
  let maxW = 1;
  let maxH = 1;
  for (const p of pages) {
    maxW = Math.max(maxW, p.width);
    maxH = Math.max(maxH, p.height);
  }
  const scale = Math.min(THUMB_W / maxW, THUMB_MAX_H / maxH);
  const frames = pages.map((p) => {
    const lift = Math.max(1, THUMB_MIN / Math.min(p.width * scale, p.height * scale));
    const width = Math.min(THUMB_W, Math.round(p.width * scale * lift));
    return { width, height: Math.round(width * (p.height / p.width)) };
  });
  const tops = [0];
  for (const f of frames) tops.push(tops[tops.length - 1] + f.height + THUMB_ROW_EXTRA);
  return { frames, tops };
}

// The row that contains offset y, by binary search over the rows' top edges.
function rowAt(tops: number[], y: number) {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const Thumb = memo(function Thumb({
  pdf,
  n,
  size,
  rotation,
  active,
  onSelect,
}: {
  pdf: PDFDocumentProxy;
  n: number;
  size: { width: number; height: number };
  rotation: number;
  active: boolean;
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
    <button ref={ref} data-page={n} className={`thumb ${active ? "on" : ""}`} style={{ height: size.height + THUMB_ROW_EXTRA, flexShrink: 0 }} onClick={() => onSelect(n)} aria-label={`Page ${n}`}>
      <div className="thumb-frame" style={{ width: size.width, height: size.height, flexShrink: 0 }}>
        <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
      </div>
      <span className="thumb-num">{n}</span>
    </button>
  );
});
