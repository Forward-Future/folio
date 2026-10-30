// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchResults } from "./SearchResults";
import type { TextPiece } from "./lib/search";
import { deferred } from "./testing/deferred";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class Bus {
  #handlers = new Map<string, Set<() => void>>();
  on(name: string, fn: () => void) { this.#handlers.set(name, (this.#handlers.get(name) ?? new Set()).add(fn)); }
  off(name: string, fn: () => void) { this.#handlers.get(name)?.delete(fn); }
  emit(name: string) { for (const fn of [...(this.#handlers.get(name) ?? [])]) fn(); }
  count(name: string) { return this.#handlers.get(name)?.size ?? 0; }
}

type Pages = Record<number, TextPiece[] | Promise<TextPiece[]> | Error>;

function makePdf(pages: Pages) {
  const getTextContent = vi.fn();
  const getPage = vi.fn(async (n: number) => ({
    getTextContent: async (options: object) => {
      getTextContent(n, options);
      const page = pages[n];
      if (page instanceof Error) throw page;
      return { items: await page };
    },
  }));
  return { pdf: { getPage } as never, getPage, getTextContent };
}

/** Matches as the find controller reports them: per page, the offsets of each match and their lengths. */
function makeController(matches: Record<number, { offsets: number[]; length: number }>, pageCount = Math.max(...Object.keys(matches).map(Number))) {
  const pageMatches: (number[] | undefined)[] = Array.from({ length: pageCount }, (_, i) => matches[i + 1]?.offsets);
  const pageMatchesLength: (number[] | undefined)[] = Array.from({ length: pageCount }, (_, i) => matches[i + 1]?.offsets.map(() => matches[i + 1].length));
  return { pageMatches, pageMatchesLength };
}

const manyPages = (count: number): Pages => Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, [{ str: `page ${i + 1} has the word needle in it` }]]));
const manyMatches = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, { offsets: [i + 1 >= 10 ? 15 : 14], length: 6 }]));

let root: Root;
let container: HTMLElement;
let bus: Bus;
let onSelect: ReturnType<typeof vi.fn<(page: number) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  bus = new Bus();
  onSelect = vi.fn<(page: number) => void>();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const mount = async (pdf: never, controller: object) => {
  await act(async () => { root.render(<SearchResults pdf={pdf} controller={controller as never} bus={bus as never} onSelect={onSelect} />); });
};
/** Lets the debounce that follows a find event run, and the results that follow it. */
const settle = async (ms = 100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".search-result-list button")];
const heading = () => container.querySelector("h3")!.textContent;

describe("SearchResults", () => {
  it("asks for a search before there is anything to show", async () => {
    const { pdf } = makePdf({});
    await mount(pdf, { pageMatches: [], pageMatchesLength: [] });
    await settle();
    expect(container.textContent).toContain("Search above to see matching pages");
    expect(heading()).toBe("Matching pages 0");
    expect(rows()).toHaveLength(0);
  });

  it("copes with a controller that has no matches yet", async () => {
    const { pdf } = makePdf({});
    await mount(pdf, {});
    await settle();
    expect(heading()).toBe("Matching pages 0");
  });

  it("lists each page with its matches and the words around the first one", async () => {
    const { pdf } = makePdf({ 1: [{ str: "see the needle here" }], 3: [{ str: "x needle y needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [8], length: 6 }, 3: { offsets: [2, 11], length: 6 } }));
    await settle();
    expect(heading()).toBe("Matching pages 2");
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual(["Go to page 1, 1 matches", "Go to page 3, 2 matches"]);
    expect(rows()[0].querySelector("strong")!.textContent).toBe("Page 1 1 match");
    expect(rows()[1].querySelector("strong")!.textContent).toBe("Page 3 2 matches");
    expect(rows()[0].querySelector("mark")!.textContent).toBe("needle");
    expect(rows()[0].textContent).toContain("see the needle here");
  });

  it("puts a space where a line ends instead of running the words together", async () => {
    const { pdf } = makePdf({ 1: [{ str: "our identification.", hasEOL: true }, { str: "Invoice number" }] });
    await mount(pdf, makeController({ 1: { offsets: [19], length: 7 } }));
    await settle();
    expect(rows()[0].querySelector("span:not(strong span)")!.textContent).toBe("our identification. Invoice number");
    expect(rows()[0].querySelector("mark")!.textContent).toBe("Invoice");
  });

  it("reads each page's text the way find does, so the offsets line up", async () => {
    const { pdf, getTextContent } = makePdf({ 1: [{ str: "needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 } }));
    await settle();
    expect(getTextContent).toHaveBeenCalledWith(1, { disableNormalization: true });
  });

  it("shows no match text when the match has no recorded length", async () => {
    const { pdf } = makePdf({ 1: [{ str: "needle" }] });
    await mount(pdf, { pageMatches: [[0]] });
    await settle();
    expect(rows()[0].querySelector("mark")!.textContent).toBe("");
  });

  it("skips pages without matches", async () => {
    const { pdf, getPage } = makePdf({ 2: [{ str: "needle" }] });
    await mount(pdf, { pageMatches: [undefined, [0], []], pageMatchesLength: [undefined, [6], []] });
    await settle();
    expect(rows()).toHaveLength(1);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(2);
  });

  it("goes to the page that was clicked", async () => {
    const { pdf } = makePdf({ 4: [{ str: "needle" }] });
    await mount(pdf, makeController({ 4: { offsets: [0], length: 6 } }));
    await settle();
    await act(async () => { rows()[0].click(); });
    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it("shows a page it can't read with an empty snippet rather than failing the list", async () => {
    const { pdf } = makePdf({ 1: new Error("broken page"), 2: [{ str: "needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 }, 2: { offsets: [0], length: 6 } }));
    await settle();
    expect(rows()).toHaveLength(2);
    expect(rows()[0].querySelector("mark")!.textContent).toBe("");
    expect(rows()[1].querySelector("mark")!.textContent).toBe("needle");
  });

  it("marks a long text as cut on either side", async () => {
    const { pdf } = makePdf({ 1: [{ str: "a".repeat(80) + "needle" + "b".repeat(150) }] });
    await mount(pdf, makeController({ 1: { offsets: [80], length: 6 } }));
    await settle();
    const text = rows()[0].querySelector("span:not(strong span)")!.textContent!;
    expect(text.startsWith("..." + "a".repeat(55) + "needle")).toBe(true);
    expect(text.endsWith("b".repeat(100) + "...")).toBe(true);
  });

  it("refreshes when find reports new matches or new highlights, and reuses the text it already read", async () => {
    const { pdf, getPage } = makePdf({ 1: [{ str: "needle" }] });
    const controller = makeController({ 1: { offsets: [0], length: 6 } });
    await mount(pdf, controller);
    await settle();
    expect(getPage).toHaveBeenCalledTimes(1);
    bus.emit("updatetextlayermatches");
    await settle();
    bus.emit("updatefindmatchescount");
    await settle();
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  it("waits for find to go quiet before reading anything", async () => {
    const { pdf, getPage } = makePdf({ 1: [{ str: "needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 } }));
    getPage.mockClear();
    bus.emit("updatefindmatchescount");
    await settle(60);
    bus.emit("updatefindmatchescount");
    await settle(60);
    expect(getPage).not.toHaveBeenCalled();
    await settle(40);
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it("clears the list as soon as a new search starts", async () => {
    const { pdf } = makePdf({ 1: [{ str: "needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 } }));
    await settle();
    expect(rows()).toHaveLength(1);
    await act(async () => { bus.emit("find"); });
    expect(rows()).toHaveLength(0);
    expect(heading()).toBe("Matching pages 0");
    expect(container.textContent).toContain("Search above");
  });

  it("shows the first 100 matching pages and says so", async () => {
    const { pdf, getPage } = makePdf(manyPages(120));
    await mount(pdf, makeController(manyMatches(120)));
    await settle();
    await settle(); // the list is built in slices of ten, with a pause between
    for (let i = 0; i < 12; i++) await settle(1);
    expect(heading()).toBe("Matching pages 120");
    expect(rows()).toHaveLength(100);
    expect(getPage).toHaveBeenCalledTimes(100);
    expect(container.textContent).toContain("Showing the first 100 matching pages");
  });

  it("does not say the list is cut when everything is shown", async () => {
    const { pdf } = makePdf(manyPages(12));
    await mount(pdf, makeController(manyMatches(12)));
    await settle();
    for (let i = 0; i < 3; i++) await settle(1);
    expect(rows()).toHaveLength(12);
    expect(container.textContent).not.toContain("Showing the first 100");
  });

  it("shows the first slice of results while it reads on", async () => {
    const gate = deferred<TextPiece[]>();
    const pages = manyPages(12);
    pages[11] = gate.promise;
    const { pdf } = makePdf(pages);
    await mount(pdf, makeController(manyMatches(12)));
    await settle();
    expect(rows()).toHaveLength(10);
    gate.resolve([{ str: "page 11 needle" }]);
    await settle();
    expect(rows()).toHaveLength(12);
  });

  it("abandons a read that a newer search has replaced", async () => {
    const gate = deferred<TextPiece[]>();
    const { pdf, getPage } = makePdf({ 1: [{ str: "needle" }], 2: gate.promise, 3: [{ str: "needle" }] });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 }, 2: { offsets: [0], length: 6 }, 3: { offsets: [0], length: 6 } }));
    await settle();
    expect(getPage).toHaveBeenCalledTimes(2); // page 3 hasn't been asked for: page 2 is still being read
    await act(async () => { bus.emit("find"); });
    gate.resolve([{ str: "needle" }]);
    await settle(1);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(0);
  });

  it("does not publish a slice that a newer search has replaced", async () => {
    const gate = deferred<TextPiece[]>();
    const pages = manyPages(12);
    pages[10] = gate.promise;
    const { pdf } = makePdf(pages);
    await mount(pdf, makeController(manyMatches(12)));
    await settle();
    await act(async () => { bus.emit("find"); });
    gate.resolve([{ str: "page 10 needle" }]);
    await settle(1);
    expect(rows()).toHaveLength(0);
  });

  it("does not publish a finished list that a newer search has replaced", async () => {
    const gate = deferred<TextPiece[]>();
    const { pdf } = makePdf({ 1: gate.promise });
    await mount(pdf, makeController({ 1: { offsets: [0], length: 6 } }));
    await settle();
    await act(async () => { bus.emit("find"); });
    gate.resolve([{ str: "needle" }]);
    await settle(1);
    expect(rows()).toHaveLength(0);
  });

  it("starts afresh for another document", async () => {
    const first = makePdf({ 1: [{ str: "first needle" }] });
    await mount(first.pdf, makeController({ 1: { offsets: [6], length: 6 } }));
    await settle();
    expect(rows()[0].textContent).toContain("first needle");
    const second = makePdf({ 1: [{ str: "second needle" }] });
    await mount(second.pdf, makeController({ 1: { offsets: [7], length: 6 } }));
    await settle();
    expect(rows()[0].textContent).toContain("second needle");
    expect(bus.count("find")).toBe(1);
  });

  it("stops listening when it goes away", async () => {
    const { pdf } = makePdf({});
    await mount(pdf, { pageMatches: [] });
    expect(bus.count("find")).toBe(1);
    expect(bus.count("updatefindmatchescount")).toBe(1);
    expect(bus.count("updatetextlayermatches")).toBe(1);
    act(() => root.unmount());
    expect(bus.count("find") + bus.count("updatefindmatchescount") + bus.count("updatetextlayermatches")).toBe(0);
    root = createRoot(container); // so afterEach has something to unmount
  });
});
