// Recently opened files, kept locally in IndexedDB so they can be reopened with one click.

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  openedAt: number;
  lastPage: number;
  thumb: string;
  data: Blob;
}

const DB_NAME = "folio";
const STORE = "recent";
const LEGACY = "recentByName";
const NOTES = "notes";
const AI = "ai";
const MAX_RECENT = 8;
/** Bigger files aren't kept in Recent: each entry stores the whole PDF, so a few 300 MB downloads would be gigabytes of copies on disk. */
export const MAX_RECENT_FILE_BYTES = 50 * 1024 * 1024;
let connection: Promise<IDBDatabase> | null = null;

export function openFolioDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 6);
    req.onupgradeneeded = event => {
      const database = req.result;
      // Older cards can pair one file's preview and position with another file's bytes.
      if (event.oldVersion < 4) {
        if (database.objectStoreNames.contains(STORE)) req.transaction!.objectStore(STORE).name = LEGACY;
        database.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(NOTES)) database.createObjectStore(NOTES, { keyPath: "id" });
      if (!database.objectStoreNames.contains(AI)) database.createObjectStore(AI, { keyPath: "id" });
      if (event.oldVersion < 5) {
        database.createObjectStore("versions", { keyPath: "id" }).createIndex("byFamily", ["family", "number"], { unique: true });
        database.createObjectStore("versionPdfs");
      }
      database.createObjectStore("clearGenerations");
    };
    req.onsuccess = () => {
      const database = req.result;
      database.onversionchange = () => { database.close(); connection = null; };
      database.onclose = () => { connection = null; };
      // A migration that runs out of quota can retry next time. Notes and chat still work.
      migrateRecent(database).catch(() => {}).then(() => resolve(database));
    };
    req.onerror = () => { connection = null; reject(req.error); };
  });
  return connection;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const db = await openFolioDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const req = fn(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(req.result);
    transaction.onabort = () => reject(transaction.error);
    req.onerror = () => reject(req.error);
  });
}

export async function contentKey(data: Uint8Array) {
  // Up to 2 MiB the old key already hashed every byte. Larger sampled keys cannot prove
  // which file owns old notes or chat, even if a file with the same sample is still in Recent.
  const prefix = data.byteLength <= 2 * 1024 * 1024 ? "sha256:" : "sha256-full:";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
  return prefix + Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") + ":" + data.byteLength;
}

async function migrateRecent(database: IDBDatabase) {
  if (!database.objectStoreNames.contains(LEGACY)) return;
  const old = await new Promise<RecentFile[]>((resolve, reject) => {
    const request = database.transaction(LEGACY).objectStore(LEGACY).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const file of old.sort((a, b) => b.openedAt - a.openedAt)) {
    let id: string | undefined;
    if (file.data instanceof Blob && file.data.size <= MAX_RECENT_FILE_BYTES) {
      try { id = await contentKey(new Uint8Array(await file.data.arrayBuffer())); } catch { continue; }
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([LEGACY, STORE], "readwrite");
      const legacy = transaction.objectStore(LEGACY);
      const current = transaction.objectStore(STORE);
      // Two tabs can start the same migration. Moving each row atomically avoids resurrecting a removed card.
      const source = legacy.getKey(file.id);
      source.onsuccess = () => {
        if (source.result === undefined) return;
        legacy.delete(file.id);
        if (!id) return;
        const dest = current.getKey(id);
        dest.onsuccess = () => {
          if (dest.result === undefined) current.put({ ...file, id, size: file.data.size, thumb: "", lastPage: 1 });
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }
}

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const all = await tx<RecentFile[]>("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function getRecent(id: string): Promise<RecentFile | undefined> {
  try {
    return await tx<RecentFile | undefined>("readonly", (s) => s.get(id));
  } catch {
    return undefined;
  }
}

export async function saveRecent(file: RecentFile) {
  try {
    await tx("readwrite", (store) => {
      store.put(file);
      const all: IDBRequest<RecentFile[]> = store.getAll();
      all.onsuccess = () => {
        for (const old of all.result.sort((a, b) => b.openedAt - a.openedAt).slice(MAX_RECENT)) store.delete(old.id);
      };
      return all;
    });
  } catch {
    /* storage may be unavailable (private mode); recent files are best-effort */
  }
}

export async function updateLastPage(id: string, lastPage: number) {
  try {
    const database = await openFolioDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const file = request.result as RecentFile | undefined;
        if (file && file.lastPage !== lastPage) store.put({ ...file, lastPage });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {}
}

export async function clearRecent() {
  try {
    const db = await openFolioDatabase();
    const stores = db.objectStoreNames.contains(LEGACY) ? [STORE, LEGACY] : [STORE];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(stores, "readwrite");
      for (const name of stores) transaction.objectStore(name).clear();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    /* ignore */
  }
}

export async function removeRecent(id: string) {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

// ── Highlights and notes ──────────────────────────────────────────────
// Saved per document (same id as Recent) so markup survives closing Folio.

export interface StoredMark {
  id: string;
  type: "highlight" | "ink" | "freetext";
  shape?: import("./shapes").Shape;
  page: number; // 0-based
  text: string;
  note: string;
  color: string;
  createdAt: number;
  /** pdf.js editor serialization, used to recreate the mark. */
  data: Record<string, unknown>;
}

export interface DocNotes {
  id: string;
  note: string;
  marks: StoredMark[];
  bookmarkedPages?: number[]; // One-based, absent in older records.
  updatedAt: number;
}

export type StoredCategory = typeof NOTES | typeof AI;
const CLEAR_CHANNEL = "folio:stored-data-cleared";

export function onStoredDataCleared(listener: (category: StoredCategory, generation: number) => void) {
  const channel = new BroadcastChannel(CLEAR_CHANNEL);
  channel.onmessage = ({ data }) => listener(data.category, data.generation);
  return () => channel.close();
}

export async function countStoredData() {
  const [notes, ai] = await Promise.all([NOTES, AI].map(store => tx("readonly", s => s.count(), store)));
  return { notes, ai };
}

// Read the generation in the same transaction as the record. A suspended tab or an old autosave
// can then never write a cleared annotation or conversation back, even before its notification arrives.
async function withGeneration<T>(category: StoredCategory, mode: IDBTransactionMode,
  run: (store: IDBObjectStore, generation: number, generations: IDBObjectStore) => IDBRequest<T> | void) {
  const db = await openFolioDatabase();
  return new Promise<{ value: T | undefined; generation: number }>((resolve, reject) => {
    const transaction = db.transaction([category, "clearGenerations"], mode);
    const generations = transaction.objectStore("clearGenerations");
    const read = generations.get(category);
    let result: IDBRequest<T> | void;
    read.onsuccess = () => { result = run(transaction.objectStore(category), read.result ?? 0, generations); };
    transaction.oncomplete = () => resolve({ value: result?.result, generation: read.result ?? 0 });
    transaction.onabort = () => reject(transaction.error ?? new Error("Stored data is unavailable."));
  });
}

export async function clearStoredData(category: StoredCategory) {
  const { generation } = await withGeneration(category, "readwrite", (store, current, generations) => {
    generations.put(current + 1, category);
    return store.clear();
  });
  const channel = new BroadcastChannel(CLEAR_CHANNEL);
  channel.postMessage({ category, generation: generation + 1 });
  channel.close();
}

async function readStored<T>(category: StoredCategory, id: string) {
  try { return await withGeneration<T | undefined>(category, "readonly", store => store.get(id)); }
  catch { return { value: undefined, generation: 0 }; }
}

async function saveStored(category: StoredCategory, id: string, value: unknown, generation: number) {
  try {
    await withGeneration(category, "readwrite", (store, current) => {
      if (generation !== current) return;
      if (value) store.put(value);
      else store.delete(id);
    });
  } catch { /* Autosaves are best effort when storage is unavailable. */ }
}

export function getNotes(id: string) {
  return readStored<DocNotes>(NOTES, id);
}

export function saveNotes(notes: DocNotes, generation: number) {
  const keep = notes.note.trim() || notes.marks.length || notes.bookmarkedPages?.length;
  return saveStored(NOTES, notes.id, keep ? notes : undefined, generation);
}

// ── Ask AI conversations ──────────────────────────────────────────────
// One conversation per document (same content-based id as notes), so it's there when the document is reopened.

export interface StoredAiMessage {
  role: "user" | "assistant";
  content: string;
  context?: { text: string; page: number };
}

export async function getAiHistory(id: string) {
  const { value, generation } = await readStored<{ messages: StoredAiMessage[] }>(AI, id);
  return { messages: Array.isArray(value?.messages) ? value.messages : [], generation };
}

export function saveAiHistory(id: string, messages: StoredAiMessage[], generation: number) {
  return saveStored(AI, id, messages.length ? { id, messages, updatedAt: Date.now() } : undefined, generation);
}
