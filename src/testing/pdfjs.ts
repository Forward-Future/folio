// Real pdf.js (document loader and find controller) for tests that need the genuine article: what an offset or a
// text item means is decided by pdf.js, and a fake can only repeat what we already assumed.
//
// pdf.js 6 uses a few things Node only has from 22 on (which CI and the Electron toolchain use). Older Node gets them
// here so the tests still run there.
const promise = Promise as { withResolvers?: unknown };
if (!promise.withResolvers) {
  promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
const buffer = ArrayBuffer.prototype as { transferToFixedLength?: unknown };
if (!buffer.transferToFixedLength) {
  // (Without the part that detaches the original, which nothing here relies on.)
  buffer.transferToFixedLength = function (this: ArrayBuffer, length = this.byteLength) {
    const copy = new Uint8Array(length);
    copy.set(new Uint8Array(this).subarray(0, length));
    return copy.buffer;
  };
}

/** The core library, which runs in plain Node. */
async function loadCore() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** The viewer (find controller, event bus), which needs a DOM: use it from a test file that runs in jsdom. */
async function loadViewer() {
  // pdf_viewer.mjs reads the core library from globalThis.pdfjsLib at import time (see src/pdfjs-global.ts).
  (globalThis as { pdfjsLib?: unknown }).pdfjsLib = await loadCore();
  return import("pdfjs-dist/legacy/web/pdf_viewer.mjs");
}

export async function openPdf(bytes: Uint8Array, password?: string) {
  const pdfjsLib = await loadCore();
  return pdfjsLib.getDocument({ data: bytes.slice(), password, useSystemFonts: true }).promise;
}

/** A find controller wired to a document the way the app does it (event bus, and a link service that knows the page count). */
export async function findControllerFor(pdf: Awaited<ReturnType<typeof openPdf>>) {
  const viewer = await loadViewer();
  const eventBus = new viewer.EventBus();
  const linkService = { pagesCount: pdf.numPages, page: 1 };
  const controller = new viewer.PDFFindController({ eventBus, linkService: linkService as never });
  controller.setDocument(pdf);
  return { controller, eventBus, linkService };
}
