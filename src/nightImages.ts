// Night reading darkens pages by filtering the page canvas, which would also invert photos and figures.
// To keep images true to color, each rendered page gets an unfiltered overlay canvas holding just its
// image regions, copied from the original rendering. pdf.js records where images are drawn
// (normalized to the canvas) the first time a page renders with image recording on.
// The overlay is only displayed in night reading (see reading-tools.css).
import type { EventBus } from "./viewer";

interface PageLike {
  imageCoordinates?: ArrayLike<number> | null;
}

/** The page rotation in effect when pdf.js recorded a page's image positions. */
const capturedRotation = new WeakMap<object, number>();

function rotatePoint(x: number, y: number, delta: number): [number, number] {
  switch (delta) {
    case 90: return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default: return [x, y];
  }
}

/** Draws the image regions of `source` into an overlay canvas inside `host` (removes it if there are none). */
export function paintImageOverlay(host: Element, source: HTMLCanvasElement, page: PageLike | null | undefined, rotation: number) {
  const coords = page?.imageCoordinates;
  let overlay = host.querySelector<HTMLCanvasElement>(":scope > canvas.folio-image-overlay");
  if (!page || !coords || coords.length < 6 || !source.width || !source.height) {
    overlay?.remove();
    return;
  }
  if (!capturedRotation.has(page)) capturedRotation.set(page, rotation);
  const delta = (((rotation - capturedRotation.get(page)!) % 360) + 360) % 360;
  if (!overlay) {
    overlay = document.createElement("canvas");
    overlay.className = "folio-image-overlay";
    overlay.setAttribute("aria-hidden", "true");
    host.append(overlay);
  }
  const { width, height } = source;
  overlay.width = width;
  overlay.height = height;
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i + 5 < coords.length; i += 6) {
    // Three corners of the image's parallelogram; the fourth follows from them.
    const p0 = [coords[i], coords[i + 1]];
    const p1 = [coords[i + 2], coords[i + 3]];
    const p2 = [coords[i + 4], coords[i + 5]];
    const p3 = [p1[0] + p2[0] - p0[0], p1[1] + p2[1] - p0[1]];
    const pts = [p0, p1, p2, p3].map(([x, y]) => rotatePoint(x, y, delta));
    const left = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) * width));
    const top = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) * height));
    const right = Math.min(width, Math.ceil(Math.max(...pts.map((p) => p[0])) * width));
    const bottom = Math.min(height, Math.ceil(Math.max(...pts.map((p) => p[1])) * height));
    if (right - left < 2 || bottom - top < 2) continue;
    ctx.drawImage(source, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
  }
}

/** Keeps the image overlays of the main viewer's pages up to date as they render. */
export function trackPageImages(eventBus: EventBus) {
  eventBus.on("pagerendered", ({ source }: { source: { canvas?: HTMLCanvasElement | null; pdfPage?: PageLike; viewport?: { rotation: number } } }) => {
    const canvas = source.canvas;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    paintImageOverlay(host, canvas, source.pdfPage, source.viewport?.rotation ?? 0);
  });
}
