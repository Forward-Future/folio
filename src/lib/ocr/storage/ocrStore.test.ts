import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recent.ts keeps its database connection at module level, so each test gets a fresh module and a fresh database.
async function freshStore() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  return { ...(await import("../../../recent")), ...(await import("./ocrStore")) };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("recognized text storage", () => {
  it("saves a page and reads it back", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    const items = [{ str: "Hello ", transform: [1, 0, 0, 1, 2, 3] }];
    await saveOcrPage("doc", 1, items);
    expect(await getOcrPages("doc")).toEqual(new Map([[1, items]]));
  });

  it("returns every saved page of a document, with its number", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "a" }]);
    await saveOcrPage("doc", 12, [{ str: "b" }]);
    await saveOcrPage("doc", 100, [{ str: "c" }]);
    const pages = await getOcrPages("doc");
    expect([...pages.keys()].sort((a, b) => a - b)).toEqual([1, 12, 100]);
    expect(pages.get(12)).toEqual([{ str: "b" }]);
  });

  it("returns nothing for a document it has never seen", async () => {
    const { getOcrPages } = await freshStore();
    expect((await getOcrPages("unknown")).size).toBe(0);
  });

  it("keeps a page that gave nothing new, as empty, so it isn't read again", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    await saveOcrPage("doc", 3, []);
    const pages = await getOcrPages("doc");
    expect(pages.has(3)).toBe(true);
    expect(pages.get(3)).toEqual([]);
  });

  it("replaces a page saved before", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "old" }]);
    await saveOcrPage("doc", 1, [{ str: "new" }]);
    expect(await getOcrPages("doc")).toEqual(new Map([[1, [{ str: "new" }]]]));
  });

  it("keeps documents apart, including ids that start the same way", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    await saveOcrPage("sha256:abc:10", 1, [{ str: "short" }]);
    await saveOcrPage("sha256:abc:100", 1, [{ str: "long" }]);
    await saveOcrPage("sha256:abc:100", 2, [{ str: "long 2" }]);
    expect([...(await getOcrPages("sha256:abc:10")).values()]).toEqual([[{ str: "short" }]]);
    expect((await getOcrPages("sha256:abc:100")).size).toBe(2);
  });

  it("is stored with the other per-document data, not instead of it", async () => {
    const { saveOcrPage, saveNotes, getNotes } = await freshStore();
    await saveNotes({ id: "doc", note: "keep me", marks: [], updatedAt: 1 });
    await saveOcrPage("doc", 1, [{ str: "a" }]);
    expect((await getNotes("doc"))?.note).toBe("keep me");
  });
});

describe("upgrading an existing library", () => {
  it.each([3, 4])("upgrades a version %i library without losing notes", async (version) => {
    vi.resetModules();
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);

    // Both pre-migration and currently shipping libraries can contain notes.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("folio", version);
      request.onupgradeneeded = () => {
        for (const name of ["recent", "notes", "ai"]) request.result.createObjectStore(name, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(["notes", "recent"], "readwrite");
        tx.objectStore("notes").put({ id: "old-doc", note: "from before", marks: [{ id: "m" }], updatedAt: 1 });
        if (version === 4) tx.objectStore("recent").put({ id: "recent-doc", name: "saved.pdf", openedAt: 1, data: new Blob(["pdf"]) });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const { getNotes, getRecent } = await import("../../../recent");
    const { saveOcrPage, getOcrPages } = await import("./ocrStore");
    expect((await getNotes("old-doc"))?.note).toBe("from before");
    if (version === 4) expect((await getRecent("recent-doc"))?.name).toBe("saved.pdf");
    await saveOcrPage("old-doc", 1, [{ str: "new" }]);
    expect((await getOcrPages("old-doc")).get(1)).toEqual([{ str: "new" }]);
  });
});

describe("when storage isn't available", () => {
  it("reads as empty and doesn't throw on save", async () => {
    vi.resetModules();
    vi.stubGlobal("indexedDB", { open() { throw new Error("blocked"); } });
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const { saveOcrPage, getOcrPages } = await import("./ocrStore");
    await expect(saveOcrPage("doc", 1, [])).resolves.toBeUndefined();
    expect((await getOcrPages("doc")).size).toBe(0);
  });
});
