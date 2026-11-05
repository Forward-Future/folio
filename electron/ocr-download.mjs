import catalog from "./ocr-models.json" with { type: "json" };

// This is also the desktop IPC boundary. Only the pinned, immutable model files may be fetched.
export async function downloadOcrModel(code, fetchFile = fetch, signal = AbortSignal.timeout(90_000)) {
  if (typeof code !== "string" || !Object.hasOwn(catalog.languages, code)) throw new Error("Unknown scan language.");
  const model = catalog.languages[code];
  const response = await fetchFile(`${catalog.baseUrl}${code}.traineddata.gz`, {
    credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal,
  });
  if (!response.ok || !response.body) throw new Error("Language download failed.");
  const data = new Uint8Array(model.bytes);
  const reader = response.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > data.length - length) throw new Error("Unexpected language file size.");
      data.set(value, length);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (length !== data.length) throw new Error("Incomplete language file.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== model.sha256) throw new Error("Language file verification failed.");
  return data;
}
