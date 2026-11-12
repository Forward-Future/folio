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
});
