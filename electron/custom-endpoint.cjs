// Any server that speaks the OpenAI-style Chat Completions API: a hosted provider, a company gateway,
// or a model running on this computer (Ollama, LM Studio, llama.cpp). The person enters its address,
// an optional key, and a model ID. Folio talks only to that address.
const fs = require("node:fs");
const net = require("node:net");
const { chatRequest } = require("./ai-prompt.cjs");
const { isLocalAddress } = require("./network.cjs");
const { providerError, readAnswer, secureStorageAvailable, serial } = require("./chat-completions.cjs");

const CONFIG_FILE = "custom-endpoint.json";
const KEY_FILE = "custom-endpoint-key.bin";
const validModel = (id) => typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id);
const validKey = (key) => /^[\x21-\x7e]{1,1024}$/.test(key);

/** The address as Folio stores it, or null. Plain http is only for this computer or the local network. */
function endpointAddress(input) {
  if (typeof input !== "string" || input.trim().length > 512) return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || (net.isIP(host) !== 0 && isLocalAddress(host));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function createCustomEndpoint({ net: electronNet, safeStorage, file, writeAtomic }) {
  function config() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(CONFIG_FILE), "utf8"));
      const baseUrl = endpointAddress(saved?.baseUrl);
      return baseUrl ? { baseUrl, hasKey: saved.hasKey === true } : null;
    } catch { return null; }
  }
  const status = () => {
    const saved = config();
    return saved ? { configured: true, baseUrl: saved.baseUrl, hasKey: saved.hasKey } : { configured: false, baseUrl: "", hasKey: false };
  };
  const nameOf = (baseUrl) => new URL(baseUrl).host;

  async function connection() {
    const saved = config();
    if (!saved) throw new Error("Connect a custom endpoint in Settings.");
    if (!saved.hasKey) return { baseUrl: saved.baseUrl, key: "" };
    try {
      const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file(KEY_FILE)));
      return { baseUrl: saved.baseUrl, key: result };
    } catch { throw new Error("Couldn't unlock the endpoint's key. Unlock your system key store or enter the key again in Settings."); }
  }

  async function request({ baseUrl, key }, endpoint, options = {}) {
    const name = nameOf(baseUrl);
    let response;
    try {
      response = await electronNet.fetch(baseUrl + endpoint, {
        ...options, signal: options.signal || AbortSignal.timeout(20_000), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        headers: { Accept: options.body ? "text/event-stream" : "application/json", ...(key ? { Authorization: "Bearer " + key } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(`Couldn't reach ${name}. Check the address and your connection, and that the server is running.`);
    }
    return response;
  }
  async function failure(name, response) {
    const body = await response.json().catch(() => ({}));
    return providerError(name, response.status, body?.error ?? {});
  }

  /** Lists the server's models. Servers without a model list still work with a typed model ID. */
  async function listModels(endpoint) {
    const response = await request(endpoint, "/models");
    if (response.status === 404 || response.status === 405) return [];
    if (!response.ok) throw await failure(nameOf(endpoint.baseUrl), response);
    const data = (await response.json().catch(() => null))?.data;
    if (!Array.isArray(data)) return [];
    return data.filter(m => validModel(m?.id)).slice(0, 2000).map(m => ({ id: m.id,
      name: typeof m.name === "string" && m.name ? m.name.slice(0, 160) : m.id,
      contextLength: Number.isSafeInteger(m.context_length) && m.context_length > 0 ? m.context_length : null }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  const change = serial();
  return {
    status,
    check: async () => { await listModels(await connection()); },
    save: (input) => change(async () => {
      const baseUrl = endpointAddress(input?.baseUrl);
      if (!baseUrl) throw new Error("Enter the endpoint's address, such as https://api.example.com/v1. Plain http works only for this computer or your local network.");
      const key = typeof input?.key === "string" ? input.key.trim() : "";
      if (key && !validKey(key)) throw new Error("Enter a valid API key, or leave it empty if the server doesn't need one.");
      if (key && !(await secureStorageAvailable(safeStorage))) throw new Error("Unlock or enable your system key store to save an API key.");
      await listModels({ baseUrl, key });
      try {
        if (key) writeAtomic(KEY_FILE, await safeStorage.encryptStringAsync(key));
        else fs.rmSync(file(KEY_FILE), { force: true });
        writeAtomic(CONFIG_FILE, JSON.stringify({ baseUrl, hasKey: !!key }));
      } catch { throw new Error("Couldn't save the endpoint securely. Check your system key store and try again."); }
    }),
    remove: () => change(() => {
      fs.rmSync(file(CONFIG_FILE), { force: true });
      fs.rmSync(file(KEY_FILE), { force: true });
    }),
    models: async () => listModels(await connection()),
    ask: async ({ model, document, messages }, emit, signal) => {
      if (!validModel(model)) throw new Error("Choose a model for your custom endpoint in Settings.");
      const endpoint = await connection();
      const passage = messages.at(-1)?.context;
      if (document.truncated && !passage) throw new Error("This document exceeds Folio’s whole-document limit. Select a passage and ask again.");
      const { instructions, input } = chatRequest(model, passage
        ? { name: document.name, text: `[Page ${passage.page}]\n${passage.text}`, truncated: true } : document, messages);
      const body = JSON.stringify({ model, messages: [{ role: "system", content: instructions }, ...input], stream: true });
      const response = await request(endpoint, "/chat/completions", { method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) });
      if (!response.ok) throw await failure(nameOf(endpoint.baseUrl), response);
      await readAnswer(nameOf(endpoint.baseUrl), response, emit);
    },
  };
}

module.exports = { createCustomEndpoint, endpointAddress };
