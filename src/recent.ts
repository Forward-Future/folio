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
const MAX_RECENT = 8;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const fileId = (name: string, size: number) => `${name}:${size}`;

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
    await tx("readwrite", (s) => s.put(file));
    const all = await listRecent();
    for (const old of all.slice(MAX_RECENT)) await removeRecent(old.id);
  } catch {
    /* storage may be unavailable (private mode); recent files are best-effort */
  }
}

export async function updateLastPage(id: string, lastPage: number) {
  const file = await getRecent(id);
  if (file) await saveRecent({ ...file, lastPage });
}

export async function removeRecent(id: string) {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}
