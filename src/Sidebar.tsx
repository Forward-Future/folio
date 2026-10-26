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

  useEffect(() => {
    pdf.getPage(1).then((p) => {
      const vp = p.getViewport({ scale: 1, rotation: (p.rotate + rotation) % 360 });
      setRatio(vp.height / vp.width);
    });
  }, [pdf, rotation]);

  // Keep the active thumbnail in view as the reader scrolls.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [page]);

  return (
    <div className="thumbs" ref={listRef}>
      {Array.from({ length: pdf.numPages }, (_, i) => (
        <Thumb key={`${i}-${rotation}`} pdf={pdf} n={i + 1} ratio={ratio} rotation={rotation} active={page === i + 1} onSelect={onSelect} />
      ))}
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
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        io.disconnect();
        renderThumbnail(pdf, n, canvasRef.current!, THUMB_W, rotation)
          .then(() => !cancelled && setReady(true))
          .catch(() => {});
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [pdf, n, rotation]);

  return (
    <button ref={ref} data-page={n} className={`thumb ${active ? "on" : ""}`} onClick={() => onSelect(n)} aria-label={`Page ${n}`}>
      <div className="thumb-frame" style={{ width: THUMB_W, height: ready ? undefined : THUMB_W * ratio }}>
        <canvas ref={canvasRef} style={{ opacity: ready ? 1 : 0 }} />
      </div>
      <span className="thumb-num">{n}</span>
    </button>
  );
});
