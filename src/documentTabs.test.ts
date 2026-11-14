// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { DocumentTabs, type Reader } from "./documentTabs";

function reader(text: string, locked = false) {
  return {
    open: vi.fn(),
    flush: async () => {},
    text: () => Promise.resolve({ text, truncated: false, recognized: false }),
    locked: () => locked,
    goTo: vi.fn(),
  } satisfies Reader;
}

function twoTabs(lockedB = false) {
  const tabs = new DocumentTabs(document.createElement("div"));
  tabs.library();
  tabs.open([{ kind: "sample", name: "A.pdf" }, { kind: "sample", name: "B.pdf" }]);
  const [a, b] = tabs.all.map((tab) => tab.key);
  const readerB = reader("[Page 1]\nB text", lockedB);
  tabs.bind(a, reader("[Page 1]\nA text"));
  tabs.bind(b, readerB);
  tabs.opened(a, "id-a", "A.pdf");
  tabs.opened(b, "id-b", "B.pdf");
  return { tabs, a, b, readerB };
}

describe("DocumentTabs for Ask AI", () => {
  it("offers unvisited tabs and loads a chosen one without switching the active document", async () => {
    const tabs = new DocumentTabs(document.createElement("div"));
    tabs.open([{ kind: "sample", name: "A.pdf" }, { kind: "sample", name: "B.pdf" }]);
    const [a, b] = tabs.all.map(tab => tab.key);
    expect(tabs.documents(a)).toEqual([{ key: b, name: "B.pdf", locked: false }]);
    const prepared = tabs.prepareDocument(b);
    expect(tabs.active).toBe(a);
    expect(tabs.all[1].frame?.inert).toBe(true);
    expect(tabs.all[1].frame?.classList.contains("active")).toBe(false);
    let finish!: () => void;
    const readerB = reader("B text", true);
    readerB.open.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    tabs.bind(b, readerB);
    tabs.opened(b, "id-b", "B.pdf");
    let settled = false;
    void prepared.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // opened() precedes OCR restoration and the reader's password flag.
    finish();
    expect(await prepared).toEqual({ key: b, name: "B.pdf", contentId: "id-b", locked: true });
    expect(tabs.active).toBe(a);
  });

  it("settles an add when an unvisited tab closes before its reader binds", async () => {
    const tabs = new DocumentTabs(document.createElement("div"));
    tabs.open([{ kind: "sample", name: "A.pdf" }, { kind: "sample", name: "B.pdf" }]);
    const b = tabs.all[1].key;
    const prepared = tabs.prepareDocument(b);
    await tabs.close(b);
    expect(await prepared).toBeNull();
  });

  it("lets a locked or failed open finish without attaching an unreadable document", async () => {
    const tabs = new DocumentTabs(document.createElement("div"));
    tabs.open([{ kind: "sample", name: "A.pdf" }, { kind: "sample", name: "B.pdf" }]);
    const b = tabs.all[1].key;
    const prepared = tabs.prepareDocument(b);
    tabs.bind(b, { open: async () => {}, flush: async () => {}, text: () => null });
    expect(await prepared).toBeNull();
  });

  it("settles a rejected reader open without leaving a pending add", async () => {
    const tabs = new DocumentTabs(document.createElement("div"));
    tabs.open([{ kind: "sample", name: "A.pdf" }, { kind: "sample", name: "Broken.pdf" }]);
    const b = tabs.all[1].key;
    const prepared = tabs.prepareDocument(b);
    tabs.bind(b, { open: async () => { throw new Error("bad file"); }, flush: async () => {} });
    expect(await prepared).toBeNull();
    expect(tabs.documents(tabs.active)).toEqual([]);
  });

  it("lists documents open in other tabs and reads their text", async () => {
    const { tabs, a, b } = twoTabs(true);
    expect(tabs.documents(a)).toEqual([{ key: b, name: "B.pdf", contentId: "id-b", locked: true }]);
    expect(await tabs.documentText("id-b")).toEqual({ text: "[Page 1]\nB text", truncated: false, recognized: false, name: "B.pdf", locked: true });
  });

  it("stops matching a document once it is edited, and matches the edited version", async () => {
    const { tabs, a } = twoTabs();
    tabs.revised(tabs.all[1].key, "id-b2");
    expect(await tabs.documentText("id-b")).toBeNull();
    expect(tabs.documents(a).map((doc) => doc.contentId)).toEqual(["id-b2"]);
    // The tab still counts as the file it opened, so the library's dirty check keeps working.
    expect(tabs.all[1].contentId).toBe("id-b");
  });

  it("switches to the tab showing a cited page", () => {
    const { tabs, a, b, readerB } = twoTabs();
    tabs.select(a);
    expect(tabs.showPage("id-b", 3)).toBe(true);
    expect(tabs.active).toBe(b);
    expect(readerB.goTo).toHaveBeenCalledWith(3);
    expect(tabs.showPage("missing", 1)).toBe(false);
  });

  it("forgets a document when its tab closes", async () => {
    const { tabs, a, b } = twoTabs();
    await tabs.close(b);
    expect(tabs.documents(a)).toEqual([]);
    expect(await tabs.documentText("id-b")).toBeNull();
    expect(tabs.showPage("id-b", 1)).toBe(false);
  });

  it("lists identical live content only once even when an edited tab and a copy are open", () => {
    const { tabs, a, b } = twoTabs();
    tabs.revised(b, "edited-b");
    tabs.open([{ kind: "sample", name: "Copy.pdf" }]);
    const copy = tabs.active;
    tabs.bind(copy, reader("B text"));
    tabs.opened(copy, "edited-b", "Copy.pdf");
    expect(tabs.documents(a).filter(doc => doc.contentId === "edited-b")).toHaveLength(1);
  });

  it.each(["edit", "close"])("discards text if its tab changes during extraction: %s", async change => {
    const { tabs, b } = twoTabs();
    let finish!: (text: { text: string; truncated: boolean; recognized: boolean }) => void;
    tabs.bind(b, { ...reader(""), text: () => new Promise(resolve => { finish = resolve; }) });
    const text = tabs.documentText("id-b");
    if (change === "edit") tabs.revised(b, "new-b");
    else await tabs.close(b);
    finish({ text: "stale private text", truncated: false, recognized: false });
    expect(await text).toBeNull();
  });
});
