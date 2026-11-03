import type { PDFViewer } from "./viewer";

/** A mouse notch turns immediately. High-resolution touchpads send a stream of pixel
 * deltas (including momentum), so wait for deliberate travel and turn once per swipe. */
export function enableWheelPaging(container: HTMLElement, viewer: PDFViewer) {
  let lastTime = -Infinity;
  let travel = 0;
  let turned = false;
  const onWheel = (event: WheelEvent) => {
    if (!viewer.pdfDocument || !viewer.pagesCount || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
      || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
    event.preventDefault();
    // Chromium reports wheel detents in multiples of 120 even when its standard delta is in pixels.
    const ticks = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
    const sameSwipe = event.timeStamp - lastTime <= 160 && Math.sign(event.deltaY) === Math.sign(travel);
    const detent = (!!ticks && ticks % 120 === 0) || Math.abs(event.deltaY) % 100 === 0;
    if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && (sameSwipe || !detent)) {
      if (!sameSwipe) {
        travel = 0;
        turned = false;
      }
      lastTime = event.timeStamp;
      travel += event.deltaY;
      if (turned || Math.abs(travel) < 24) return;
      turned = true;
    } else {
      lastTime = -Infinity;
    }
    if (event.deltaY > 0) viewer.nextPage();
    else viewer.previousPage();
  };
  container.addEventListener("wheel", onWheel, { passive: false });
  return () => container.removeEventListener("wheel", onWheel);
}
