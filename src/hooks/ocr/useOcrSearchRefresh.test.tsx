// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrSession } from "../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../lib/ocr/types";
import { findControllerFor } from "../../testing/pdfjs";
import { useOcrSearchRefresh } from "./useOcrSearchRefresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Parameters<typeof useOcrSearchRefresh>[0];
function Harness(props: Props) {
  useOcrSearchRefresh(props);
  return null;
}

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const render = (props: Props) => act(async () => { root.render(<Harness {...props} />); });
const sessionAt = (version: number, id = "pdf") => ({ version, pdf: { id } }) as unknown as OcrSession & { version: number };

/** Stands in for PDFFindController, including what matters here: setDocument forgets the search. */
function fakeFind(request: object | null, highlightMatches = true) {
  const controller = {
    highlightMatches,
    state: request,
    setDocument: vi.fn(() => { controller.state = null; controller.highlightMatches = false; }),
  };
  return controller;
}
const SEARCH = { source: null, type: "again", query: "invoice", caseSensitive: true, entireWord: false, highlightAll: true, findPrevious: true, matchDiacritics: false };

/** What happens when the reader starts recognition: it runs, adds text, and ends. The hook only looks when the phase changes. */
async function recognizeMore(props: Props, version: number, end: OcrState["phase"] = "done") {
  await render({ ...props, phase: "running" });
  (props.session as { version: number }).version = version;
  await render({ ...props, phase: end });
}

function setup(overrides: Partial<Props> = {}, request: object | null = SEARCH, highlightMatches = true) {
  const controller = fakeFind(request, highlightMatches);
  const dispatch = vi.fn();
  const props: Props = {
    session: sessionAt(0), searchOpen: true, phase: "done" as OcrState["phase"],
    find: { current: controller as never }, bus: { current: { dispatch } as never }, ...overrides,
  };
  return { controller, dispatch, props };
}

describe("useOcrSearchRefresh", () => {
  it("leaves find alone when there is no document", async () => {
    const { controller, props } = setup({ session: null });
    await render(props);
    expect(controller.setDocument).not.toHaveBeenCalled();
  });

  it("leaves find alone while nothing has been recognized since it last looked", async () => {
    const { controller, props } = setup();
    await render(props);
    await render({ ...props, phase: "running" });
    await render({ ...props, phase: "done" });
    expect(controller.setDocument).not.toHaveBeenCalled();
  });

  it("points find at the document again once new text exists, and runs the search again", async () => {
    const { controller, dispatch, props } = setup();
    const session = props.session!;
    await render(props);
    await recognizeMore(props, 3);
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
    expect(controller.setDocument).toHaveBeenCalledWith(session.pdf);
    expect(dispatch).toHaveBeenCalledTimes(1);
    // Same words and options, but as a new forward search: not a repeat, and not backwards.
    expect(dispatch).toHaveBeenCalledWith("find", { ...SEARCH, type: "", findPrevious: false });
  });

  it("reads the search before find forgets it, and runs it only after find has been reset", async () => {
    const { controller, dispatch, props } = setup();
    await render(props);
    await recognizeMore(props, 1);
    expect(controller.state).toBeNull();
    expect(controller.setDocument.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0]);
  });

  it("waits while recognition is running, then refreshes once", async () => {
    // The find bar is opened mid-run, after some pages already have text: find would only be reset again by the next page.
    const { controller, dispatch, props } = setup({ phase: "running", searchOpen: false }, SEARCH, false);
    await render(props);
    (props.session as { version: number }).version = 2;
    await render({ ...props, searchOpen: true });
    expect(controller.setDocument).not.toHaveBeenCalled();
    (props.session as { version: number }).version = 5;
    await render({ ...props, searchOpen: true, phase: "done" });
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled(); // opened after the search was closed: nothing is showing to bring back
    await render({ ...props, searchOpen: true, phase: "offer" });
    await render({ ...props, searchOpen: true, phase: "done" });
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
  });

  it("brings the search back once a run that was going when it started has ended", async () => {
    const { controller, dispatch, props } = setup({ phase: "running" });
    await render(props);
    (props.session as { version: number }).version = 2;
    await render({ ...props, phase: "running" });
    expect(controller.setDocument).not.toHaveBeenCalled();
    await render({ ...props, phase: "offer" }); // stopped part way: the pages read so far are searchable
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("refreshes again for text that arrives later", async () => {
    const { controller, props } = setup();
    await render(props);
    await recognizeMore(props, 1);
    await recognizeMore(props, 2);
    expect(controller.setDocument).toHaveBeenCalledTimes(2);
  });

  it("holds off while the find bar is closed, and catches up when it opens", async () => {
    const { controller, dispatch, props } = setup({ searchOpen: false }, SEARCH, false);
    await render(props);
    await recognizeMore(props, 4);
    expect(controller.setDocument).not.toHaveBeenCalled();
    await render({ ...props, searchOpen: true });
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
    // The search that was last typed belongs to a find bar that has since been closed: the new one starts empty.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not bring back a search that was never typed", async () => {
    for (const request of [null, { ...SEARCH, query: "" }]) {
      const { controller, dispatch, props } = setup({}, request);
      await render(props);
      await recognizeMore(props, 1);
      expect(controller.setDocument).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("starts a new document from the text it was opened with", async () => {
    const { controller, props } = setup({ session: sessionAt(0, "first") });
    await render(props);
    // The second document was opened with text already recognized (restored from an earlier visit): find has seen it all.
    const second = sessionAt(7, "second");
    await render({ ...props, session: second });
    await render({ ...props, session: second, phase: "running" });
    await render({ ...props, session: second, phase: "done" });
    expect(controller.setDocument).not.toHaveBeenCalled();
    await recognizeMore({ ...props, session: second }, 8);
    expect(controller.setDocument).toHaveBeenCalledTimes(1);
    expect(controller.setDocument).toHaveBeenCalledWith(second.pdf);
  });
});

describe("with the real find controller", () => {
  /** A two-page document whose text can change after it was searched, like a scan being recognized. */
  function documentWith(text: Record<number, string>) {
    return {
      numPages: 2,
      getPage: async (n: number) => ({ getTextContent: async () => ({ items: text[n] ? [{ str: text[n], hasEOL: false }] : [] }) }),
    };
  }
  const query = (eventBus: { dispatch(name: string, data: object): void }, q: string) =>
    eventBus.dispatch("find", { source: null, type: "", query: q, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });

  it("finds words recognized after the search began, without the query being typed again", async () => {
    const text: Record<number, string> = { 1: "A typed cover page", 2: "" };
    const pdf = documentWith(text);
    const { controller, eventBus } = await findControllerFor(pdf as never);
    const session = sessionAt(0);
    (session as { pdf: unknown }).pdf = pdf;
    const props: Props = { session, searchOpen: true, phase: "running", find: { current: controller }, bus: { current: eventBus } };
    await render(props);

    query(eventBus, "invoice");
    await vi.waitFor(() => expect(controller.pageMatches).toHaveLength(2));
    expect(controller.pageMatches!.flat()).toEqual([]);

    // Page 2 is recognized.
    text[2] = "Invoice number 42";
    (session as { version: number }).version = 1;
    await render({ ...props, phase: "done" });

    await vi.waitFor(() => expect(controller.pageMatches![1]).toEqual([0]));
    expect(controller.pageMatchesLength![1]).toEqual([7]);
    expect((controller as unknown as { state: { query: string } }).state.query).toBe("invoice");
  });
});
