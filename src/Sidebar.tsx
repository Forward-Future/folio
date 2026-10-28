import { memo, useEffect, useRef, useState } from "react";
import { renderThumbnail, type OutlineItem, type PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";

interface Props {
  pdf: PDFDocumentProxy;
  page: number;
  rotation: number;
  onSelectPage: (n: number) => void;
  onSelectDest: (dest: unknown) => void;
}

export function Sidebar({ pdf, page, rotation, onSelectPage, onSelectDest }: Props) {
  const [tab, setTab] = useState<"pages" | "outline">("pages");
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);

  useEffect(() => {
    setOutline(null);
    pdf.getOutline().then((o) => setOutline((o as OutlineItem[] | null) ?? []));
  }, [pdf]);

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "pages"} className={tab === "pages" ? "on" : ""} onClick={() => setTab("pages")}>
          <Icon name="grid" size={15} /> Pages
        </button>
        <button role="tab" aria-selected={tab === "outline"} className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}>
          <Icon name="list" size={15} /> Outline
        </button>
      </div>
      <div className="sidebar-scroll">
        {tab === "pages" ? (
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
  const [ratio, setRatio] = useState(1.294);
  const [range, setRange] = useState({ start: 0, end: 12 });
  const rowHeight = Math.ceil(THUMB_W * ratio) + 48;

  useEffect(() => {
    let cancelled = false;
    pdf.getPage(1).then((p) => {
      const vp = p.getViewport({ scale: 1, rotation: (p.rotate + rotation) % 360 });
      if (!cancelled) setRatio(vp.height / vp.width);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pdf, rotation]);

  useEffect(() => {
    const scroll = listRef.current!.parentElement!;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const start = Math.min(pdf.numPages - 1, Math.max(0, Math.floor(scroll.scrollTop / rowHeight) - 4));
      const end = Math.min(pdf.numPages, Math.ceil((scroll.scrollTop + scroll.clientHeight) / rowHeight) + 4);
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
  }, [pdf, rowHeight]);

  // Keep the active thumbnail in view as the reader scrolls.
  useEffect(() => {
    const scroll = listRef.current!.parentElement!;
    const top = (page - 1) * rowHeight;
    if (top < scroll.scrollTop || top + rowHeight > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = Math.max(0, top - (scroll.clientHeight - rowHeight) / 2);
      scroll.dispatchEvent(new Event("scroll"));
    }
  }, [pdf, page, rowHeight]);

  return (
    <div className="thumbs" ref={listRef} style={{ gap: 0 }}>
      <div aria-hidden="true" style={{ height: range.start * rowHeight, flexShrink: 0 }} />
      {Array.from({ length: Math.max(0, range.end - range.start) }, (_, index) => (
        <Thumb key={`${range.start + index}-${rotation}`} pdf={pdf} n={range.start + index + 1} ratio={ratio} rotation={rotation} active={page === range.start + index + 1} onSelect={onSelect} />
      ))}
      <div aria-hidden="true" style={{ height: Math.max(0, pdf.numPages - range.end) * rowHeight, flexShrink: 0 }} />
    </div>
  );
}

const THUMB_W = 132;

const Thumb = memo(function Thumb({
  pdf,
  n,
  ratio,
  rotation,
  active,
  onSelect,
}: {
  pdf: PDFDocumentProxy;
  n: number;
  ratio: number;
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
        renderThumbnail(pdf, n, canvasRef.current!, THUMB_W, rotation, controller.signal)
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
  }, [pdf, n, rotation]);

  return (
    <button ref={ref} data-page={n} className={`thumb ${active ? "on" : ""}`} style={{ height: Math.ceil(THUMB_W * ratio) + 48, flexShrink: 0 }} onClick={() => onSelect(n)} aria-label={`Page ${n}`}>
      <div className="thumb-frame" style={{ width: THUMB_W, height: THUMB_W * ratio, flexShrink: 0 }}>
        <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
      </div>
      <span className="thumb-num">{n}</span>
    </button>
  );
});
