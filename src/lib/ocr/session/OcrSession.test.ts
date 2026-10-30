import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOcrPages: vi.fn(async (_id: string) => new Map<number, unknown[]>()),
  saveOcrPage: vi.fn(async (_id: string, _page: number, _items: unknown[]) => {}),
  createWorker: vi.fn(),
}));
vi.mock("../storage/ocrStore", () => ({ getOcrPages: mocks.getOcrPages, saveOcrPage: mocks.saveOcrPage }));
vi.mock("../../../pdf", () => ({
  pdfjs: { OPS: { save: 10, restore: 11, transform: 12, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83 } },
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));

import type { OcrState } from "../types";
import { OcrSession, ocrSession } from "./OcrSession";

// ── Fakes ──────────────────────────────────────────────────────────────────────────────────
// A page is 612 x 792 points; at 300 dpi it is drawn 4.1667 pixels to the point.
const SCALE = 300 / 72;

interface PageOptions {
  /** Text the PDF itself carries. */
  items?: object[];
  /** A picture covering the whole page. */
  image?: boolean;
}

const textItem = (x: number, y: number, width: number, height: number, str = "text") => ({
  str, dir: "ltr", fontName: "f", hasEOL: false, transform: [height, 0, 0, height, x, y], width, height,
});
/** Enough text to be a typed page (about 13% of it). */
const TYPED = [textItem(0, 0, 612, 100)];
/** A small stamp, like the one on a scan with a filing number. */
const STAMP = [textItem(50, 700, 50, 10)];

function makePage({ items = [], image = false }: PageOptions = {}) {
  return {
    view: [0, 0, 612, 792],
    streamTextContent: vi.fn(() => new ReadableStream({ start(controller) { if (items.length) controller.enqueue({ items, styles: {} }); controller.close(); } })),
    getOperatorList: vi.fn(async () => (image ? { fnArray: [12, 85], argsArray: [[612, 0, 0, 792, 0, 0], ["img"]] } : { fnArray: [], argsArray: [] })),
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale, convertToPdfPoint: (x: number, y: number) => [x / scale, 792 - y / scale] }),
    render: vi.fn((_params: { canvas: { width: number; height: number }; background?: string }) => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
}
type FakePage = ReturnType<typeof makePage>;

function makePdf(pages: FakePage[]) {
  return { numPages: pages.length, getPage: async (n: number) => pages[n - 1] } as unknown as ConstructorParameters<typeof OcrSession>[0];
}

/** What Tesseract returns for one line of words, each given as [text, x0, x1, confidence] in pixels. */
function recognized(...words: [string, number, number, number?][]) {
  return {
    data: { blocks: [{ paragraphs: [{ lines: [{
      words: words.map(([text, x0, x1, confidence = 95]) => ({ text, confidence, bbox: { x0, y0: 80, x1, y1: 110 } })),
      bbox: { x0: 0, y0: 80, x1: 400, y1: 110 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 100 },
    }] }] }] },
  };
}
const nothing = { data: { blocks: null } };

function makeWorker(result: object = recognized(["Hello", 20, 100], ["world", 120, 220])) {
  const worker = { recognize: vi.fn(async (..._args: unknown[]) => result), terminate: vi.fn(async () => {}) };
  mocks.createWorker.mockResolvedValue(worker);
  return worker;
}

const readAll = async (stream: ReadableStream) => {
  const out: { items: { str: string }[]; lang?: string }[] = [];
  const reader = stream.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) return out; out.push(value); }
};

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

let canvases: { width: number; height: number }[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOcrPages.mockResolvedValue(new Map());
  mocks.createWorker.mockReset();
  canvases = [];
  vi.stubGlobal("document", { createElement: () => { const canvas = { width: 0, height: 0 }; canvases.push(canvas); return canvas; } });
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
});
afterEach(() => vi.unstubAllGlobals());

// ── Tests ──────────────────────────────────────────────────────────────────────────────────
describe("the page text override", () => {
  it("leaves a page's own text alone when nothing was recognized", async () => {
    const page = makePage({ items: STAMP });
    const pdf = makePdf([page]);
    new OcrSession(pdf, "k");
    const chunks = await readAll((await pdf.getPage(1)).streamTextContent());
    expect(chunks.map((c) => c.items.length)).toEqual([1]);
  });

  it("puts recognized words after the page's own text", async () => {
    const pdf = makePdf([makePage({ items: STAMP })]);
    const session = new OcrSession(pdf, "k");
    session.pages.set(1, [{ str: "recognized" }]);
    const chunks = await readAll((await pdf.getPage(1)).streamTextContent());
    expect(chunks.map((c) => c.items.map((i) => i.str))).toEqual([["text"], ["recognized"]]);
    expect(chunks[1].lang).toBe("en");
  });

  it("serves a page with no text of its own from the recognized words alone", async () => {
    const pdf = makePdf([makePage()]);
    new OcrSession(pdf, "k").pages.set(1, [{ str: "only" }]);
    const chunks = await readAll((await pdf.getPage(1)).streamTextContent());
    expect(chunks.map((c) => c.items.map((i) => i.str))).toEqual([["only"]]);
  });

  it("ignores a page that was read and had nothing to add", async () => {
    const pdf = makePdf([makePage({ items: STAMP })]);
    new OcrSession(pdf, "k").pages.set(1, []);
    expect(await readAll((await pdf.getPage(1)).streamTextContent())).toHaveLength(1);
  });

  it("is installed once per page, however often the page is asked for", async () => {
    const pdf = makePdf([makePage({ items: STAMP })]);
    new OcrSession(pdf, "k").pages.set(1, [{ str: "r" }]);
    await pdf.getPage(1);
    const again = await pdf.getPage(1);
    expect(await readAll(again.streamTextContent())).toHaveLength(2);
  });

  it("is looked up from the document", () => {
    const pdf = makePdf([makePage()]);
    const session = new OcrSession(pdf, "k");
    expect(ocrSession(pdf)).toBe(session);
    expect(ocrSession(makePdf([makePage()]))).toBeUndefined();
  });
});

describe("restore", () => {
  it("brings back pages recognized earlier and marks the text as changed", async () => {
    mocks.getOcrPages.mockResolvedValue(new Map([[1, [{ str: "a" }]], [3, []]]));
    const session = new OcrSession(makePdf([makePage(), makePage(), makePage()]), "doc-key");
    await session.restore();
    expect(mocks.getOcrPages).toHaveBeenCalledWith("doc-key");
    expect([...session.pages.keys()]).toEqual([1, 3]);
    expect(session.version).toBe(1);
  });

  it("leaves the version alone when there is nothing saved", async () => {
    const session = new OcrSession(makePdf([makePage()]), "doc-key");
    await session.restore();
    expect(session.version).toBe(0);
  });

  it("does not touch storage for a document that isn't stored", async () => {
    const session = new OcrSession(makePdf([makePage()]), null);
    await session.restore();
    expect(mocks.getOcrPages).not.toHaveBeenCalled();
  });
});

describe("detect", () => {
  it("offers recognition for a page that is only a picture", async () => {
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    await session.detect();
    expect(session.state).toEqual({ phase: "offer", total: 1, done: 0 });
  });

  it("offers it for a scan that carries a small stamp of real text", async () => {
    const session = new OcrSession(makePdf([makePage({ items: STAMP, image: true })]), "k");
    await session.detect();
    expect(session.state.phase).toBe("offer");
  });

  it("does not offer it for a typed page, even one with a picture on it", async () => {
    const session = new OcrSession(makePdf([makePage({ items: TYPED, image: true })]), "k");
    await session.detect();
    expect(session.state.phase).toBe("idle");
  });

  it("does not offer it for sparse text without a picture (a drawing or a cover page)", async () => {
    const session = new OcrSession(makePdf([makePage({ items: STAMP })]), "k");
    await session.detect();
    expect(session.state.phase).toBe("idle");
  });

  it("looks at pages across the document, not just the first", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => makePage(i % 2 === 1 ? { image: true } : { items: TYPED }));
    // The session replaces each page's stream method as it hands the page out, so keep the spies.
    const streams = pages.map((p) => p.streamTextContent);
    const session = new OcrSession(makePdf(pages), "k");
    await session.detect();
    // Pages 2, 4, 6, 8, 10 and 12 are the sample, and all of them are scans.
    expect(session.state.phase).toBe("offer");
    expect(streams[0]).not.toHaveBeenCalled();
    expect(streams[1]).toHaveBeenCalled();
  });

  it("needs half of the sampled pages to be scans", async () => {
    const mixed = (scanned: number[]) => Array.from({ length: 12 }, (_, i) => makePage(scanned.includes(i + 1) ? { image: true } : { items: TYPED }));
    const few = new OcrSession(makePdf(mixed([2, 4])), "k");
    await few.detect();
    expect(few.state.phase).toBe("idle");
    const half = new OcrSession(makePdf(mixed([2, 4, 6])), "k");
    await half.detect();
    expect(half.state.phase).toBe("offer");
  });

  it("reports a document as done when every page was recognized before", async () => {
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    session.pages.set(1, [{}]);
    session.pages.set(2, []);
    await session.detect();
    expect(session.state).toEqual({ phase: "done", total: 2, done: 2 });
  });

  it("offers the rest when only some pages were recognized before", async () => {
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    session.pages.set(1, [{}]);
    await session.detect();
    expect(session.state).toEqual({ phase: "offer", total: 2, done: 1 });
  });

  it("stays quiet if the document was closed while it looked", async () => {
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    session.destroy();
    await session.detect();
    expect(session.state.phase).toBe("idle");
  });
});

describe("start", () => {
  it("reads each scanned page, saves the result, and finishes", async () => {
    const worker = makeWorker();
    const pdf = makePdf([makePage({ image: true }), makePage({ image: true })]);
    const session = new OcrSession(pdf, "doc-key");
    await session.start(() => 1);

    expect(session.state).toEqual({ phase: "done", total: 2, done: 2, error: undefined });
    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect([...session.pages.keys()].sort()).toEqual([1, 2]);
    expect(mocks.saveOcrPage).toHaveBeenCalledTimes(2);
    expect(mocks.saveOcrPage).toHaveBeenCalledWith("doc-key", 1, expect.any(Array));
    expect(session.version).toBe(2);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("runs Tesseract from the app's own bundled files, in LSTM-only mode, without caching", async () => {
    makeWorker();
    await new OcrSession(makePdf([makePage({ image: true })]), "k").start(() => 1);
    expect(mocks.createWorker).toHaveBeenCalledWith("eng", 1, expect.objectContaining({
      workerPath: "http://localhost/ocr/worker.min.js", corePath: "http://localhost/ocr/core", langPath: "http://localhost/ocr/lang",
      workerBlobURL: false, cacheMethod: "none", gzip: true,
    }));
  });

  it("asks Tesseract for word boxes", async () => {
    const worker = makeWorker();
    await new OcrSession(makePdf([makePage({ image: true })]), "k").start(() => 1);
    expect(worker.recognize).toHaveBeenCalledWith(expect.anything(), {}, { blocks: true });
  });

  it("draws the page at 300 dpi on a white background and frees the pixels afterwards", async () => {
    makeWorker();
    const page = makePage({ image: true });
    await new OcrSession(makePdf([page]), "k").start(() => 1);
    expect(page.render).toHaveBeenCalledWith(expect.objectContaining({ background: "#ffffff" }));
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toEqual({ width: 0, height: 0 });
    expect(page.cleanup).toHaveBeenCalled();
  });

  it("caps the size of the picture it reads on a very large sheet", async () => {
    makeWorker();
    const page = makePage({ image: true });
    page.getViewport = ({ scale }: { scale: number }) => ({ width: 2384 * scale, height: 1684 * scale, convertToPdfPoint: (x: number, y: number) => [x, y] });
    let drawn = { width: 0, height: 0 };
    page.render = vi.fn((params: { canvas: { width: number; height: number } }) => { drawn = { ...params.canvas }; return { promise: Promise.resolve() }; });
    await new OcrSession(makePdf([page]), "k").start(() => 1);
    expect(Math.max(drawn.width, drawn.height)).toBeLessThanOrEqual(3301);
    expect(drawn.width).toBeGreaterThan(3000);
  });

  it("works from the page being read outwards", async () => {
    makeWorker();
    const pages = Array.from({ length: 5 }, () => makePage({ image: true }));
    await new OcrSession(makePdf(pages), "k").start(() => 4);
    const drawnOrder = pages.map((p, i) => ({ page: i + 1, at: p.render.mock.invocationCallOrder[0] })).sort((a, b) => a.at - b.at).map((p) => p.page);
    expect(drawnOrder).toEqual([4, 3, 5, 2, 1]);
  });

  it("follows the reader if they move to another page while it works", async () => {
    makeWorker();
    const pages = Array.from({ length: 6 }, () => makePage({ image: true }));
    let focus = 1;
    pages[0].render = vi.fn(() => { focus = 6; return { promise: Promise.resolve() }; });
    await new OcrSession(makePdf(pages), "k").start(() => focus);
    const order = pages.map((p, i) => ({ page: i + 1, at: p.render.mock.invocationCallOrder[0] })).sort((a, b) => a.at - b.at).map((p) => p.page);
    expect(order.slice(0, 3)).toEqual([1, 6, 5]);
  });

  it("leaves pages that have real text alone but still counts them as done", async () => {
    const worker = makeWorker();
    const session = new OcrSession(makePdf([makePage({ items: TYPED, image: true }), makePage({ image: true })]), "k");
    await session.start(() => 1);
    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect([...session.pages.keys()]).toEqual([2]);
    expect(session.state).toMatchObject({ phase: "done", done: 2, total: 2 });
  });

  it("skips pages it already has", async () => {
    const worker = makeWorker();
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    session.pages.set(1, [{ str: "earlier" }]);
    await session.start(() => 1);
    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect(session.pages.get(1)).toEqual([{ str: "earlier" }]);
  });

  it("drops recognized words that repeat the PDF's own stamp, and keeps the rest", async () => {
    // "Stamp" lands exactly where the page's own stamp text is: pixels 20..100 at baseline 100 -> page x 4.8, y 768.
    const stamp = textItem(20 / SCALE, 792 - 100 / SCALE, 80 / SCALE, 30 / SCALE, "Stamp");
    makeWorker(recognized(["Stamp", 20, 100], ["Other", 300, 400]));
    const session = new OcrSession(makePdf([makePage({ items: [stamp], image: true })]), "k");
    await session.start(() => 1);
    expect((session.pages.get(1) as { str: string }[]).map((i) => i.str)).toEqual(["Other"]);
  });

  it("remembers a page that gave nothing new, without announcing it", async () => {
    makeWorker(nothing);
    const session = new OcrSession(makePdf([makePage({ image: true })]), "doc-key");
    const heard = vi.fn();
    session.onPage(heard);
    await session.start(() => 1);
    expect(session.pages.get(1)).toEqual([]);
    expect(mocks.saveOcrPage).toHaveBeenCalledWith("doc-key", 1, []);
    expect(session.version).toBe(0);
    expect(heard).not.toHaveBeenCalled();
    expect(session.state.phase).toBe("done");
  });

  it("tells listeners which pages gained text, and the version moves with them", async () => {
    makeWorker();
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    const heard: number[] = [];
    session.onPage((n) => heard.push(n));
    await session.start(() => 1);
    expect(heard.sort()).toEqual([1, 2]);
    expect(session.version).toBe(2);
  });

  it("reports progress as it goes, never backwards", async () => {
    makeWorker();
    const session = new OcrSession(makePdf(Array.from({ length: 3 }, () => makePage({ image: true }))), "k");
    const seen: OcrState[] = [];
    session.subscribe(() => seen.push(session.state));
    await session.start(() => 1);
    expect(seen[0]).toMatchObject({ phase: "running", done: 0, total: 3 });
    expect(seen.at(-1)).toMatchObject({ phase: "done", done: 3 });
    const dones = seen.map((s) => s.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
  });

  it("does not store anything for a document that isn't stored (a password-protected one)", async () => {
    makeWorker();
    const session = new OcrSession(makePdf([makePage({ image: true })]), null);
    await session.start(() => 1);
    expect(mocks.saveOcrPage).not.toHaveBeenCalled();
    expect(session.pages.get(1)?.length).toBeGreaterThan(0);
  });

  it("uses two workers on a machine with enough cores, and one otherwise", async () => {
    vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
    makeWorker();
    await new OcrSession(makePdf([makePage({ image: true })]), "k").start(() => 1);
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);

    mocks.createWorker.mockClear();
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    makeWorker();
    await new OcrSession(makePdf([makePage({ image: true })]), "k").start(() => 1);
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
  });

  it("copes with a machine that doesn't report its cores", async () => {
    vi.stubGlobal("navigator", {});
    makeWorker();
    await new OcrSession(makePdf([makePage({ image: true })]), "k").start(() => 1);
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
  });

  it("ignores a second start while the first is running", async () => {
    makeWorker();
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    await Promise.all([session.start(() => 1), session.start(() => 1)]);
    expect(mocks.createWorker).toHaveBeenCalledTimes(1);
  });

  it("reports an error when the recognizer can't start", async () => {
    mocks.createWorker.mockRejectedValue(new Error("no wasm"));
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    await session.start(() => 1);
    expect(session.state).toMatchObject({ phase: "error", error: "Couldn't start text recognition." });
  });

  it("reports an error when no page could be read, but carries on past a bad page", async () => {
    const worker = makeWorker();
    worker.recognize.mockRejectedValue(new Error("bad page"));
    const allBad = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    await allBad.start(() => 1);
    expect(allBad.state).toMatchObject({ phase: "error", error: "Couldn't read this document's pages." });

    const second = makeWorker();
    second.recognize.mockRejectedValueOnce(new Error("bad page")).mockResolvedValue(recognized(["ok", 20, 60]));
    const some = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true }), makePage({ image: true })]), "k");
    await some.start(() => 1);
    expect(some.state).toMatchObject({ phase: "done", done: 3 });
    expect(some.pages.size).toBe(2);
  });

  it("can be tried again after an error", async () => {
    mocks.createWorker.mockRejectedValueOnce(new Error("no wasm"));
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    await session.start(() => 1);
    expect(session.state.phase).toBe("error");
    makeWorker();
    await session.start(() => 1);
    expect(session.state.phase).toBe("done");
    expect(session.state.error).toBeUndefined();
  });

  it("frees the page after drawing it even when reading it fails", async () => {
    const worker = makeWorker();
    worker.recognize.mockRejectedValue(new Error("bad page"));
    const page = makePage({ image: true });
    await new OcrSession(makePdf([page]), "k").start(() => 1);
    expect(page.cleanup).toHaveBeenCalled();
    expect(canvases[0]).toEqual({ width: 0, height: 0 });
  });
});

describe("cancel, dismiss, and destroy", () => {
  it("stops mid-page, keeps nothing half-done, and goes back to offering", async () => {
    const worker = makeWorker();
    const gate = deferred();
    worker.recognize.mockImplementationOnce(async () => { await gate.promise; return recognized(["late", 20, 80]); });
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    const run = session.start(() => 1);
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledTimes(1));

    session.cancel();
    expect(session.state.phase).toBe("offer");
    gate.resolve();
    await run;

    expect(session.state.phase).toBe("offer");
    expect(session.pages.size).toBe(0);
    expect(mocks.saveOcrPage).not.toHaveBeenCalled();
    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("keeps the pages finished before it was stopped", async () => {
    const worker = makeWorker();
    const gate = deferred();
    worker.recognize
      .mockResolvedValueOnce(recognized(["first", 20, 80]))
      .mockImplementationOnce(async () => { await gate.promise; return recognized(["second", 20, 80]); });
    const session = new OcrSession(makePdf([makePage({ image: true }), makePage({ image: true })]), "k");
    const run = session.start(() => 1);
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledTimes(2));
    session.cancel();
    gate.resolve();
    await run;
    expect([...session.pages.keys()]).toEqual([1]);
  });

  it("can start again after being stopped", async () => {
    const worker = makeWorker();
    const gate = deferred();
    worker.recognize.mockImplementationOnce(async () => { await gate.promise; return nothing; });
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    const first = session.start(() => 1);
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
    session.cancel();
    gate.resolve();
    await first;

    makeWorker();
    await session.start(() => 1);
    expect(session.state.phase).toBe("done");
  });

  it("dismissing hides the offer", () => {
    const session = new OcrSession(makePdf([makePage()]), "k");
    session.dismiss();
    expect(session.state.phase).toBe("idle");
  });

  it("stops listeners being called once unsubscribed", async () => {
    makeWorker();
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    const state = vi.fn();
    const page = vi.fn();
    session.subscribe(state)();
    session.onPage(page)();
    await session.start(() => 1);
    expect(state).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it("destroying drops the listeners and stops the workers", async () => {
    const worker = makeWorker();
    const gate = deferred();
    worker.recognize.mockImplementationOnce(async () => { await gate.promise; return nothing; });
    const session = new OcrSession(makePdf([makePage({ image: true })]), "k");
    const listener = vi.fn();
    session.subscribe(listener);
    const run = session.start(() => 1);
    await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
    listener.mockClear();
    session.destroy();
    gate.resolve();
    await run;
    expect(listener).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalled();
  });
});
