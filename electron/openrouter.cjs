const fs = require("node:fs");
const { chatRequest } = require("./ai-prompt.cjs");
const { providerError: sharedError, readAnswer, secureStorageAvailable, serial } = require("./chat-completions.cjs");

const API = "https://openrouter.ai/api/v1";
const KEY_FILE = "openrouter-key.bin";
const validModel = (id) => typeof id === "string" && /^[a-z\d_~@.-]+\/[a-z\d_:./~@-]+$/i.test(id) && id.length <= 256;

const NAME = "OpenRouter";
const providerError = (status, detail) => sharedError(NAME, status, detail);

function createOpenRouter({ net, safeStorage, file, writeAtomic }) {
  const status = () => ({ configured: fs.existsSync(file(KEY_FILE)) });
  async function credential() {
    if (!status().configured) throw new Error("Connect an OpenRouter API key in Settings.");
    try {
      const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file(KEY_FILE)));
      return result;
    } catch { throw new Error("Couldn't unlock the OpenRouter key. Unlock your system key store or replace the key in Settings."); }
  }

  async function request(endpoint, key, options = {}) {
    const signal = options.signal || AbortSignal.timeout(20_000);
    let response;
    try {
      response = await net.fetch(API + endpoint, {
        ...options, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        headers: { Accept: options.body ? "text/event-stream" : "application/json", Authorization: "Bearer " + key,
          ...(options.body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch { throw new Error("Couldn't reach OpenRouter. Check your connection and try again."); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw providerError(response.status, body?.error ?? {});
    }
    return response;
  }

  async function check(key) {
    const response = await request("/key", key);
    const data = await response.json().catch(() => null);
    if (!data?.data || typeof data.data !== "object") throw new Error("OpenRouter couldn't verify the API key.");
  }

  // Order writes across windows, so removing a key during a connection check takes effect last.
  const change = serial();
  return {
    status,
    check: async () => check(await credential()),
    save: (input) => change(async () => {
      if (typeof input !== "string" || !/^[\x21-\x7e]{8,512}$/.test(input.trim())) throw new Error("Enter a valid OpenRouter API key.");
      const key = input.trim();
      if (!(await secureStorageAvailable(safeStorage))) {
        throw new Error("Unlock or enable your system key store to save an OpenRouter key.");
      }
      await check(key);
      try { writeAtomic(KEY_FILE, await safeStorage.encryptStringAsync(key)); }
      catch { throw new Error("Couldn't save the key securely. Check your system key store and try again."); }
    }),
    remove: () => change(() => fs.rmSync(file(KEY_FILE), { force: true })),
    models: async () => {
      const response = await request("/models?input_modalities=text&output_modalities=text", await credential());
      const { data } = await response.json();
      if (!Array.isArray(data)) throw new Error("Couldn't read the model list. Enter a model ID or try again.");
      return data.filter(m => validModel(m?.id) && m.architecture?.input_modalities?.includes("text") && m.architecture?.output_modalities?.includes("text"))
        .map(m => ({ id: m.id, name: typeof m.name === "string" ? m.name.slice(0, 160) : m.id,
          contextLength: Number.isSafeInteger(m.context_length) && m.context_length > 0 ? m.context_length : null }));
    },
    ask: async ({ model, document, messages }, emit, signal) => {
      if (!validModel(model)) throw new Error("Choose an OpenRouter model in Settings.");
      const passage = messages.at(-1)?.context;
      if (document.truncated && !passage) throw new Error("This document exceeds Folio’s whole-document limit. Select a passage and ask again.");
      const { instructions, input } = chatRequest(model, passage
        ? { ...document, text: `[Page ${passage.page}]\n${passage.text}`, truncated: true } : document, messages);
      // Small-context endpoints can otherwise silently drop the middle of the document.
      const body = JSON.stringify({ model, messages: [{ role: "system", content: instructions }, ...input], stream: true,
        plugins: [{ id: "context-compression", enabled: false }] });
      const timer = AbortSignal.timeout(5 * 60_000);
      const response = await request("/chat/completions", await credential(), { method: "POST", body, signal: AbortSignal.any([signal, timer]) });
      await readAnswer(NAME, response, emit);
    },
  };
}

module.exports = { createOpenRouter };
