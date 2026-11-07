import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// recent.ts keeps its database connection at module level, so each test gets a fresh module and a fresh database.
async function freshStore() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
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

  it("removes recognized text when a document is removed from Recent", async () => {
    const { saveOcrPage, getOcrPages, removeRecent } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "private" }]);
    await saveOcrPage("other", 1, [{ str: "keep" }]);
    await removeRecent("doc");
    expect((await getOcrPages("doc")).size).toBe(0);
    expect((await getOcrPages("other")).size).toBe(1);
  });

  it("clears saved OCR text when Recent is cleared", async () => {
    const { saveOcrPage, getOcrPages, clearRecent } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "private" }]);
    await clearRecent();
    expect((await getOcrPages("doc")).size).toBe(0);
  });

  it("clears recognized text independently without clearing notes", async () => {
    const { saveOcrPage, getOcrPages, clearRecognizedText, saveNotes, getNotes } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "private" }]);
    await saveNotes({ id: "doc", note: "keep", marks: [], updatedAt: 1 }, 0);
    await clearRecognizedText();
    expect((await getOcrPages("doc")).size).toBe(0);
    expect((await getNotes("doc")).value?.note).toBe("keep");
  });

  it("does not persist OCR when storage invalidation cannot be checked", async () => {
    const { saveOcrPage, getOcrPages } = await freshStore();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); } });
    await saveOcrPage("doc", 1, [{ str: "private" }]);
    expect((await getOcrPages("doc")).size).toBe(0);
  });

  it("reports an invalidation failure instead of falsely claiming deletion", async () => {
    const { clearRecognizedText } = await freshStore();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    await expect(clearRecognizedText()).rejects.toThrow("quota");
  });

  it("does not resurrect OCR from a reader open before data was cleared", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const store = await freshStore();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const { saveOcrPage, getOcrPages, clearRecent, ocrEpoch } = store;
    const previousEpoch = ocrEpoch("doc");
    await clearRecent();
    await saveOcrPage("doc", 1, [{ str: "old session" }], previousEpoch);
    expect((await getOcrPages("doc")).size).toBe(0);
    await saveOcrPage("doc", 1, [{ str: "new session" }], ocrEpoch("doc"));
    expect((await getOcrPages("doc")).size).toBe(1);
  });

  it("is stored with the other per-document data, not instead of it", async () => {
    const { saveOcrPage, saveNotes, getNotes } = await freshStore();
    await saveNotes({ id: "doc", note: "keep me", marks: [], updatedAt: 1 }, 0);
    await saveOcrPage("doc", 1, [{ str: "a" }]);
    expect((await getNotes("doc")).value?.note).toBe("keep me");
  });
});

describe("upgrading an existing library", () => {
  it.each(["main", "ocr"])("upgrades the version 5 %s schema and retains existing data", async (schema) => {
    vi.resetModules();
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("folio", 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ["recent", "notes", "ai"]) db.createObjectStore(name, { keyPath: "id" });
        if (schema === "main") {
          db.createObjectStore("versions", { keyPath: "id" }).createIndex("byFamily", ["family", "number"], { unique: true });
          db.createObjectStore("versionPdfs");
        } else db.createObjectStore("ocr", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("notes", "readwrite");
        tx.objectStore("notes").put({ id: "doc", note: "keep", marks: [], updatedAt: 1 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
    const { getNotes, openFolioDatabase } = await import("../../../recent");
    const { saveOcrPage, getOcrPages } = await import("./ocrStore");
    expect((await getNotes("doc")).value?.note).toBe("keep");
    const db = await openFolioDatabase();
    expect(["ocr", "versions", "versionPdfs"].every(name => db.objectStoreNames.contains(name))).toBe(true);
    expect(db.transaction("versions").objectStore("versions").indexNames.contains("byFamily")).toBe(true);
    await saveOcrPage("doc", 1, [{ str: "saved" }]);
    expect((await getOcrPages("doc")).get(1)).toEqual([{ str: "saved" }]);
  });

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

    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const { getNotes, getRecent } = await import("../../../recent");
    const { saveOcrPage, getOcrPages } = await import("./ocrStore");
    expect((await getNotes("old-doc")).value?.note).toBe("from before");
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


describe("language-aware recognized text", () => {
  it("keeps English legacy keys separate from other language selections", async () => {
    const { saveOcrPage, getOcrPages, tx, OCR } = await freshStore();
    await tx("readwrite", s => s.put({ id: "doc#1", items: [{ str: "legacy English" }] }), OCR);
    await saveOcrPage("doc", 1, [{ str: "Deutsch" }], undefined, ["deu"]);
    await saveOcrPage("doc", 1, [{ str: "mixed" }], undefined, ["eng", "deu"]);
    expect((await getOcrPages("doc")).get(1)).toEqual([{ str: "legacy English" }]);
    expect((await getOcrPages("doc", ["deu"])).get(1)).toEqual([{ str: "Deutsch" }]);
    expect((await getOcrPages("doc", ["eng", "deu"])).get(1)).toEqual([{ str: "mixed" }]);
    expect((await getOcrPages("doc", ["spa"])).size).toBe(0);
  });

  it("removes every language when a recent document is removed", async () => {
    const { saveOcrPage, getOcrPages, removeRecent } = await freshStore();
    await saveOcrPage("doc", 1, [{ str: "English" }]);
    await saveOcrPage("doc", 1, [{ str: "Deutsch" }], undefined, ["deu"]);
    await removeRecent("doc");
    expect((await getOcrPages("doc")).size).toBe(0);
    expect((await getOcrPages("doc", ["deu"])).size).toBe(0);
  });

  it.each(["main", "ocr"])("upgrades version 6 %s without losing notes, chats or generations", async schema => {
    vi.resetModules();
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("folio", 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ["recent", "notes", "ai"]) db.createObjectStore(name, { keyPath: "id" });
        db.createObjectStore("versions", { keyPath: "id" }).createIndex("byFamily", ["family", "number"], { unique: true });
        db.createObjectStore("versionPdfs");
        if (schema === "main") db.createObjectStore("clearGenerations");
        else db.createObjectStore("ocr", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(schema === "main" ? ["notes", "ai", "clearGenerations"] : ["notes", "ai"], "readwrite");
        transaction.objectStore("notes").put({ id: "doc", note: "keep", marks: [], updatedAt: 1 });
        transaction.objectStore("ai").put({ id: "doc", messages: [{ role: "user", content: "keep chat" }] });
        if (schema === "main") transaction.objectStore("clearGenerations").put(3, "notes");
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => reject(transaction.error);
      };
      request.onerror = () => reject(request.error);
    });
    const { openFolioDatabase, getNotes, getAiHistory, saveAiHistory, saveNotes, clearStoredData } = await import("../../../recent");
    const { saveOcrPage, getOcrPages } = await import("./ocrStore");
    const db = await openFolioDatabase();
    expect(db.version).toBe(7);
    expect([...db.objectStoreNames]).toEqual(expect.arrayContaining(["ocr", "clearGenerations", "versions", "versionPdfs"]));
    const before = await getNotes("doc");
    expect(before.value?.note).toBe("keep");
    expect(before.generation).toBe(schema === "main" ? 3 : 0);
    const chat = await getAiHistory("doc");
    expect(chat.messages[0].content).toBe("keep chat");
    await clearStoredData("ai");
    await saveAiHistory("doc", chat.messages, chat.generation);
    expect((await getAiHistory("doc")).messages).toEqual([]);
    await clearStoredData("notes");
    await saveNotes(before.value!, before.generation);
    expect((await getNotes("doc")).value).toBeUndefined();
    await saveOcrPage("doc", 1, [{ str: "Deutsch" }], undefined, ["deu"]);
    expect((await getOcrPages("doc", ["deu"])).size).toBe(1);
  });
});
