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
let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => {
      const database = req.result;
      database.onversionchange = () => { database.close(); connection = null; };
      database.onclose = () => { connection = null; };
      resolve(database);
    };
    req.onerror = () => { connection = null; reject(req.error); };
  });
  return connection;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const req = fn(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(req.result);
    transaction.onabort = () => reject(transaction.error);
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
  try {
    const database = await open();
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
    await tx("readwrite", (s) => s.clear());
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
