import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export interface SelectionInfo {
  text: string;
  page: number;
  /** Center x and top/bottom of the selection, relative to the stage. */
  x: number;
  top: number;
  bottom: number;
}

const POPOVER_H = 44;

/** Tracks the reader's text selection inside the document (hidden while the mouse is still dragging). */
export function useTextSelection(container: HTMLElement | null, enabled: boolean) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  useEffect(() => {
    if (!enabled || !container) {
      setInfo(null);
      return;
    }
    let frame = 0;
    let pointerDown = false;
    const update = () => {
      frame = 0;
      const selection = document.getSelection();
      if (pointerDown || !selection || selection.isCollapsed || !selection.rangeCount) return setInfo(null);
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
      if (!anchor || !container.contains(anchor) || !anchor.closest(".textLayer")) return setInfo(null);
      const text = selection.toString().replace(/\s+/g, " ").trim();
      const rects = [...selection.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!text || !rects.length) return setInfo(null);
      const stage = (container.parentElement ?? container).getBoundingClientRect();
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      setInfo({
        text,
        page: Number((anchor.closest(".page") as HTMLElement | null)?.dataset.pageNumber) || 1,
        x: (left + right) / 2 - stage.left,
        top: Math.min(...rects.map((r) => r.top)) - stage.top,
        bottom: Math.max(...rects.map((r) => r.bottom)) - stage.top,
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const down = (e: PointerEvent) => { if (e.button === 0) { pointerDown = true; setInfo(null); } };
    const up = () => { if (pointerDown) { pointerDown = false; schedule(); } };
    document.addEventListener("selectionchange", schedule);
    container.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      container.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [container, enabled]);
  return info;
}

/** Places a floating card above (or, near the top edge, below) a selection, kept inside the stage. */
function place(info: { x: number; top: number; bottom: number }, width: number, height: number, stageWidth: number) {
  const left = Math.min(Math.max(8, info.x - width / 2), Math.max(8, stageWidth - width - 8));
  const top = info.top - height - 10 >= 8 ? info.top - height - 10 : info.bottom + 10;
  return { left, top };
}

interface PopoverProps {
  info: SelectionInfo;
  stageWidth: number;
  colors: { name: string; hex: string }[];
  current: string;
  onHighlight: (hex: string) => void;
  onNote: () => void;
  onAsk: () => void;
}

export function SelectionPopover({ info, stageWidth, colors, current, onHighlight, onNote, onAsk }: PopoverProps) {
  const [copied, setCopied] = useState(false);
  const width = 30 * colors.length + 250;
  return (
    <div
      className="selection-popover"
      role="toolbar"
      aria-label="Selected text"
      style={place(info, width, POPOVER_H, stageWidth)}
      // Keep the text selection alive while clicking these buttons.
      onMouseDown={(e) => e.preventDefault()}
    >
      {colors.map((c) => (
        <button
          key={c.hex}
          className={`swatch-btn ${c.hex === current ? "on" : ""}`}
          style={{ "--swatch": c.hex } as React.CSSProperties}
          title={`Highlight ${c.name.toLowerCase()}${c.hex === current ? " (H)" : ""}`}
          aria-label={`Highlight ${c.name.toLowerCase()}`}
          onClick={() => onHighlight(c.hex)}
        />
      ))}
      <span className="divider" />
      <button className="pop-btn" onClick={onNote} title="Highlight and add a note (N)">
        <Icon name="note" size={15} /> Note
      </button>
      <button className="pop-btn" onClick={onAsk} title="Ask AI about this passage">
        <Icon name="sparkle" size={15} /> Ask AI
      </button>
      <button
        className="pop-btn icon-only"
        title={copied ? "Copied" : "Copy"}
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(info.text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={15} />
      </button>
    </div>
  );
}

interface NoteBoxProps {
  anchor: { x: number; top: number; bottom: number };
  stageWidth: number;
  quote: string;
  initial: string;
  onSave: (note: string) => void;
  onClose: () => void;
}

/** A small floating box for writing the note attached to a highlight. */
export function NoteBox({ anchor, stageWidth, quote, initial, onSave, onClose }: NoteBoxProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => {
    onSave(value.trim());
    onClose();
  };
  return (
    <div className="note-box" role="dialog" aria-label="Note" style={place(anchor, 320, 170, stageWidth)}>
      {quote && <blockquote>{quote.length > 140 ? quote.slice(0, 140) + "…" : quote}</blockquote>}
      <textarea
        ref={ref}
        value={value}
        placeholder="Add a note…"
        rows={3}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        }}
      />
      <div className="note-actions">
        <span className="hint">Ctrl+Enter to save</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}
