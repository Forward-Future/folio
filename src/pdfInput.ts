export const MAX_PDF_BYTES = 300 * 1024 * 1024;
// The viewer creates a page view and DOM element for every reported page, even with lazy rendering.
export const MAX_PDF_PAGES = 10_000;

export function checkPdfSize(size: number, limit = MAX_PDF_BYTES) {
  if (size > limit) throw new Error("That PDF is larger than 300 MB.");
}

export function checkPageCount(count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("The PDF has an invalid page count.");
  if (count > MAX_PDF_PAGES) throw new Error("Folio can open PDFs with up to 10,000 pages.");
}

export async function readPdfBlob(blob: Blob, signal: AbortSignal, limit = MAX_PDF_BYTES): Promise<Uint8Array> {
  checkPdfSize(blob.size, limit);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("The file may have been moved or deleted."));
    reader.onabort = () => reject(signal.reason);
    reader.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

export async function readPdfResponse(response: Response, signal: AbortSignal, limit = MAX_PDF_BYTES) {
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`The server responded with ${response.status}.`);
    checkPdfSize(Number(response.headers.get("content-length")), limit);
    if (!reader) throw new Error("The server sent an empty response.");
    // Content-Length may be missing or describe compressed data. Grow on actual bytes, keeping
    // one buffer so even a response split into tiny chunks has a bounded allocation.
    let data = new Uint8Array(0);
    let size = 0;
    let checkedHeader = false;
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      const nextSize = size + (value?.byteLength ?? 0);
      checkPdfSize(nextSize, limit);
      if (nextSize > data.length) {
        const grown = new Uint8Array(Math.min(limit, Math.max(nextSize, 1024, data.length * 2)));
        grown.set(data);
        data = grown;
      }
      if (value) data.set(value, size);
      size = nextSize;
      if (!checkedHeader && (size >= 1024 || done)) {
        if (!new TextDecoder().decode(data.subarray(0, Math.min(1024, size))).includes("%PDF-")) {
          throw new Error("That link isn't a PDF.");
        }
        checkedHeader = true;
      }
      if (done) return data.subarray(0, size);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}
