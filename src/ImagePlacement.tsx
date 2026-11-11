import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { checkImageDimensions, checkImageFileSize } from "./pdfInput";
import type { PageViewport } from "pdfjs-dist";

export type ImageBox = [number, number, number, number];
export interface ImageDraft { file: File; page: number; rotation: number; box: ImageBox }

const corners = [
  ["nw", "top left"], ["ne", "top right"], ["sw", "bottom left"], ["se", "bottom right"],
] as const;
type Handle = typeof corners[number][0] | "move";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function pdfBox(viewport: PageViewport, left: number, top: number, right: number, bottom: number): ImageBox {
  const [x1,y1] = viewport.convertToPdfPoint(left, top);
  const [x2,y2] = viewport.convertToPdfPoint(right, bottom);
  return [Math.min(x1,x2), Math.min(y1,y2), Math.max(x1,x2), Math.max(y1,y2)];
}

export async function newImageDraft(file: File, page: number, viewport: PageViewport, visible?: DOMRect): Promise<ImageDraft> {
  checkImageFileSize(file.size);
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  const png = header.length === 24 && new DataView(header.buffer).getUint32(0) === 0x89504e47;
  if (!png && !(header[0] === 0xff && header[1] === 0xd8)) throw new Error("Choose a PNG or JPEG image.");
  if (png) {
    const view = new DataView(header.buffer);
    checkImageDimensions(view.getUint32(16), view.getUint32(20));
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Couldn't read this image."); });
  let width, height;
  try {
    checkImageDimensions(bitmap.width, bitmap.height);
    const scale = Math.min(viewport.scale*0.75, viewport.width*0.5/bitmap.width, viewport.height*0.5/bitmap.height);
    width = bitmap.width*scale; height = bitmap.height*scale;
  } finally { bitmap.close(); }
  const cx = visible ? visible.x + visible.width/2 : viewport.width/2;
  const cy = visible ? visible.y + visible.height/2 : viewport.height/2;
  const left = clamp(cx-width/2, 0, viewport.width-width);
  const top = clamp(cy-height/2, 0, viewport.height-height);
  return { file, page, rotation: viewport.rotation, box: pdfBox(viewport, left, top, left+width, top+height) };
}

function rectangle(viewport: PageViewport, box: ImageBox) {
  const [x1,y1] = viewport.convertToViewportPoint(box[0], box[1]);
  const [x2,y2] = viewport.convertToViewportPoint(box[2], box[3]);
  return { left: Math.min(x1,x2), top: Math.min(y1,y2), width: Math.abs(x2-x1), height: Math.abs(y2-y1) };
}

function shifted(box: ImageBox, viewport: PageViewport, handle: Handle, dx: number, dy: number) {
  const { left, top, width, height } = rectangle(viewport, box);
  if (handle === "move") {
    const x = clamp(left+dx, 0, viewport.width-width), y = clamp(top+dy, 0, viewport.height-height);
    return pdfBox(viewport, x, y, x+width, y+height);
  }
  const west = handle.endsWith("w"), north = handle.startsWith("n");
  const fixedX = west ? left+width : left, fixedY = north ? top+height : top;
  // Project the drag onto the diagonal so the opposite corner and the aspect ratio stay fixed.
  const scale = 1 + ((west ? -dx : dx)*width + (north ? -dy : dy)*height)/(width*width + height*height);
  const max = Math.min((west ? fixedX : viewport.width-fixedX)/width, (north ? fixedY : viewport.height-fixedY)/height);
  const fit = clamp(scale, Math.min(max, 1, 8/Math.min(width,height)), max);
  return pdfBox(viewport, fixedX, fixedY, fixedX+(west ? -1 : 1)*width*fit, fixedY+(north ? -1 : 1)*height*fit);
}

export function ImagePlacement({ draft, viewport, onChange, disabled }: {
  draft: ImageDraft; viewport: PageViewport; onChange: (draft: ImageDraft) => void; disabled: boolean;
}) {
  const [src, setSrc] = useState("");
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; handle: Handle; x: number; y: number; box: ImageBox } | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(draft.file);
    setSrc(url);
    frame.current?.focus({ preventScroll: true });
    return () => URL.revokeObjectURL(url);
  }, [draft.file]);
  const rect = rectangle(viewport, draft.box);
  const angle = (viewport.rotation-draft.rotation+360)%360;
  const change = (box: ImageBox) => onChange({ ...draft, box });
  const down = (event: PointerEvent<HTMLElement>, handle: Handle) => {
    if (disabled || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, handle, x: event.clientX, y: event.clientY, box: draft.box };
  };
  const move = (event: PointerEvent) => {
    const start = drag.current, host = frame.current?.parentElement?.getBoundingClientRect();
    if (disabled || !start || start.id !== event.pointerId || !host?.width || !host.height) return;
    change(shifted(start.box, viewport, start.handle, (event.clientX-start.x)*viewport.width/host.width,
      (event.clientY-start.y)*viewport.height/host.height));
  };
  const key = (event: KeyboardEvent<HTMLElement>, handle: Handle) => {
    if (disabled || !["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return;
    event.stopPropagation(); event.preventDefault();
    const step = (event.shiftKey ? 10 : 1)*viewport.scale;
    change(shifted(draft.box, viewport, handle, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
  };
  return <div ref={frame} className="folio-image-placement" role="group" aria-label="Move inserted image" tabIndex={0}
    style={rect} onPointerDown={e => down(e, "move")} onPointerMove={move} onPointerUp={e => {
      if (drag.current?.id === e.pointerId) { move(e); drag.current = null; }
    }} onPointerCancel={e => {
      if (drag.current?.id === e.pointerId) { change(drag.current.box); drag.current = null; }
    }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={e => key(e, "move")}>
    {src && <img src={src} alt="" draggable={false} style={{ width: angle%180 ? rect.height : rect.width,
      height: angle%180 ? rect.width : rect.height, transform: `translate(-50%, -50%) rotate(${angle}deg)` }} />}
    {corners.map(([handle,label]) => <button key={handle} type="button" className={"image-corner "+handle} disabled={disabled}
      aria-label={"Resize image from "+label} onPointerDown={e => down(e, handle)} onKeyDown={e => key(e, handle)} />)}
  </div>;
}
