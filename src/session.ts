export interface ReadingView {
  page: number;
  scale: string;
  rotation: number;
  sidebar: boolean;
  spread: boolean;
  top?: number;
  left?: number;
}

/** Zoom settings pdf.js resolves against the window, so they're saved and restored by name. */
export const FIT_SCALES = ["auto", "page-width", "page-fit"];

const pendingViews = new Map<string, ReadingView>();
let saveTimer = 0;

function flushViews() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  for (const [id, view] of pendingViews) {
    try { localStorage.setItem(`folio:content-view:${id}`, JSON.stringify(view)); } catch {}
  }
  pendingViews.clear();
}

window.addEventListener("pagehide", flushViews);
window.addEventListener("beforeunload", flushViews);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushViews(); });

export function readView(id: string): ReadingView | null {
  try {
    const view = pendingViews.get(id) ?? JSON.parse(localStorage.getItem(`folio:content-view:${id}`) || "null");
    if (!view || !Number.isInteger(view.page) || view.page < 1) return null;
    if (![0, 90, 180, 270].includes(view.rotation)) return null;
    if (typeof view.sidebar !== "boolean" || typeof view.spread !== "boolean") return null;
    if (!FIT_SCALES.includes(view.scale) &&
        !(Number.isFinite(Number(view.scale)) && Number(view.scale) >= 0.1 && Number(view.scale) <= 10)) return null;
    return view;
  } catch {
    return null;
  }
}

export function writeView(id: string, view: ReadingView) {
  pendingViews.set(id, { ...view });
  if (!saveTimer) saveTimer = window.setTimeout(flushViews, 250);
}

export function setActiveDocument(id: string | null) {
  try {
    if (id) localStorage.setItem("folio:active-content", id);
    else localStorage.removeItem("folio:active-content");
  } catch {}
}

export function activeDocument(): string | null {
  try {
    return localStorage.getItem("folio:active-content");
  } catch {
    return null;
  }
}
