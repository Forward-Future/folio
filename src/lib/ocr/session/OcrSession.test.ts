import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOcrPages: vi.fn(async (_id: string, _languages: string[]) => new Map<number, unknown[]>()),
  saveOcrPage: vi.fn(async (_id: string, _page: number, _items: unknown[]) => {}),
  createWorker: vi.fn(),
}));
vi.mock("../storage/ocrStore", () => ({ getOcrPages: mocks.getOcrPages, saveOcrPage: mocks.saveOcrPage, ocrLanguageKey: (languages: string[]) => [...new Set(languages)].join("+") || "eng" }));
vi.mock("../../../pdf", () => ({
  pdfjs: { OPS: { save: 10, restore: 11, transform: 12, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83 } },
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));

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

/** `info` is what the document's info holds (or the error from reading it); documents without any can't be asked. */
function makePdf(pages: FakePage[], info?: object | Error) {
  const getMetadata = async () => { if (info instanceof Error) throw info; return { info }; };
  return { numPages: pages.length, getPage: async (n: number) => pages[n - 1], ...(info ? { getMetadata } : {}) } as unknown as ConstructorParameters<typeof OcrSession>[0];
}
/** The document info of a copy Folio saved with recognized text on these pages. pdf.js gives non-standard entries as a Map. */
const savedCopyInfo = (pages: string) => ({ Custom: new Map([["FolioOcrPages", pages]]) });

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
    expect(chunks[1].lang).toBeNull();
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
    expect(mocks.getOcrPages).toHaveBeenCalledWith("doc-key", ["eng"]);
    expect([...session.pages.keys()]).toEqual([1]);
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

  it("learns which pages a copy saved by Folio already carries recognized text for", async () => {
    const session = new OcrSession(makePdf([makePage(), makePage(), makePage(), makePage()], savedCopyInfo("1-2,4")), "k");
    await session.restore();
    expect([...session.embedded]).toEqual([1, 2, 4]);
    expect(session.pages.size).toBe(0);
    expect(session.version).toBe(0); // it is ordinary text in the PDF, which pdf.js already serves
  });

  it("learns it for a document that isn't stored too", async () => {
    const session = new OcrSession(makePdf([makePage(), makePage()], savedCopyInfo("2")), null);
    await session.restore();
    expect([...session.embedded]).toEqual([2]);
  });

  it("ignores a list that names pages the document doesn't have", async () => {
    const session = new OcrSession(makePdf([makePage(), makePage()], savedCopyInfo("1-99")), "k");
    await session.restore();
    expect([...session.embedded]).toEqual([1, 2]);
  });

  it("finds nothing embedded when the document info doesn't say so", async () => {
    for (const info of [{}, { Custom: new Map() }, { Custom: new Map([["Other", "1"]]) }, { Custom: new Map([["FolioOcrPages", 3]]) }]) {
      const session = new OcrSession(makePdf([makePage(), makePage()], info), "k");
      await session.restore();
      expect(session.embedded.size).toBe(0);
    }
  });

  it("carries on when the document info can't be read", async () => {
    mocks.getOcrPages.mockResolvedValue(new Map([[1, [{}]]]));
    const session = new OcrSession(makePdf([makePage()], new Error("bad info")), "k");
    await session.restore();
    expect(session.embedded.size).toBe(0);
    expect(session.pages.size).toBe(1);
  });
});

describe("recording the reader OCR result", () => {
  it("persists and exposes recognized text once", async () => {
    const pdf = makePdf([makePage()]);
    const session = new OcrSession(pdf, "key");
    const listener = vi.fn();
    session.onPage(listener);
    session.record(1, [{ str: "recognized" }]);
    session.record(1, [{ str: "duplicate" }]);
    expect(mocks.saveOcrPage).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(session.version).toBe(1);
    expect((await readAll((await pdf.getPage(1)).streamTextContent()))[0].items[0].str).toBe("recognized");
  });
  it("does not keep an empty result that would block a later successful read", () => {
    const session = new OcrSession(makePdf([makePage()]), null);
    session.record(1, []);
    session.record(1, [{ str: "later" }]);
    expect(session.pages.get(1)).toEqual([{ str: "later" }]);
  });
  it("does not retain late results after closing", () => {
    const session = new OcrSession(makePdf([makePage()]), "key");
    session.destroy();
    session.record(1, [{ str: "late" }]);
    expect(session.pages.size).toBe(0);
    expect(mocks.saveOcrPage).not.toHaveBeenCalled();
  });
});


describe("changing recognition languages", () => {
  it("clears the old text immediately, restores only the selected language, and notifies readers", async () => {
    const session = new OcrSession(makePdf([makePage()]), "key");
    session.record(1, [{ str: "English" }]);
    const listener = vi.fn();
    session.onPage(listener);
    mocks.getOcrPages.mockResolvedValue(new Map([[1, [{ str: "Deutsch" }]]]));
    const changing = session.setLanguages(["deu"]);
    expect(session.pages.size).toBe(0);
    expect(listener).toHaveBeenCalledWith(1);
    await changing;
    expect(mocks.getOcrPages).toHaveBeenLastCalledWith("key", ["deu"]);
    expect(session.pages.get(1)).toEqual([{ str: "Deutsch" }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not let an older restore overwrite a newer language selection", async () => {
    const session = new OcrSession(makePdf([makePage()]), "key");
    let finish!: (pages: Map<number, unknown[]>) => void;
    mocks.getOcrPages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = session.setLanguages(["deu"]);
    mocks.getOcrPages.mockResolvedValueOnce(new Map([[1, [{ str: "Spanish" }]]]));
    await session.setLanguages(["spa"]);
    finish(new Map([[1, [{ str: "German" }]]]));
    await old;
    expect(session.pages.get(1)).toEqual([{ str: "Spanish" }]);
  });

  it("does not restore into a closed session", async () => {
    const session = new OcrSession(makePdf([makePage()]), "key");
    let finish!: (pages: Map<number, unknown[]>) => void;
    mocks.getOcrPages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const restoring = session.setLanguages(["deu"]);
    session.destroy();
    finish(new Map([[1, [{ str: "late" }]]]));
    await restoring;
    expect(session.pages.size).toBe(0);
  });

  it("keeps embedded PDF text and does not read storage for private documents", async () => {
    const session = new OcrSession(makePdf([makePage()], savedCopyInfo("1")), null);
    await session.restore();
    session.pages.set(2, [{ str: "old" }]);
    await session.setLanguages(["deu"]);
    expect(session.pages.size).toBe(0);
    expect([...session.embedded]).toEqual([1]);
    expect(mocks.getOcrPages).not.toHaveBeenCalled();
  });
});
