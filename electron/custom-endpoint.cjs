// Any server that speaks the OpenAI-style Chat Completions API: a hosted provider, a company gateway,
// or a model running on this computer (Ollama, LM Studio, llama.cpp). The person enters its address,
// an optional key, and a model ID. Folio talks only to that address.
//
// The address must use https, except on this computer or the local network. Folio asks before it
// connects to a local address, requests can only reach the local addresses the person approved, and a
// plain http address never reaches a public one (ai.cjs passes a fetch that runs through network.cjs's
// guarded session).
const fs = require("node:fs");
const { chatRequest } = require("./ai-prompt.cjs");
const { providerError, readAnswer, secureStorageAvailable, serial } = require("./chat-completions.cjs");

const CONFIG_FILE = "custom-endpoint.json";
const LEGACY_KEY_FILE = "custom-endpoint-key.bin";
const validModel = (id) => typeof id === "string" && /^[\x21-\x7e]{1,256}$/.test(id);
const validKey = (key) => /^[\x21-\x7e]{1,1024}$/.test(key);
const HTTPS_ONLY = "Use an https:// address. Plain http works only for this computer or your local network.";

/** The address as Folio stores it, or null. Whether plain http is allowed depends on where it resolves. */
function endpointAddress(input) {
  if (typeof input !== "string" || input.trim().length > 512) return null;
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** A saved local approval: the origin and the resolved addresses the person agreed to. */
function validApproval(local, baseUrl) {
  return local === null || (typeof local?.origin === "string" && local.origin === new URL(baseUrl).origin
    && Array.isArray(local.addresses) && local.addresses.length > 0 && local.addresses.length <= 64
    && local.addresses.every((a) => typeof a === "string" && a.length <= 64));
}

/**
 * `fetch(url, options, approvedLocal)` makes the request, reaching a local address only if it is in
 * `approvedLocal`. `resolve(url)` returns { origin, addresses, local }. `confirmLocal(url, addresses)`
 * asks the person and resolves to true if they allow it.
 */
function createCustomEndpoint({ fetch, resolve, confirmLocal, safeStorage, file, writeAtomic }) {
  function config() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(CONFIG_FILE), "utf8"));
      const baseUrl = endpointAddress(saved?.baseUrl);
      const local = saved?.local ?? null;
      if (!baseUrl || !validApproval(local, baseUrl)) return null;
      if (baseUrl.startsWith("http:") && !local) return null;
      return { baseUrl, hasKey: typeof saved.encryptedKey === "string" || saved.hasKey === true, encryptedKey: saved.encryptedKey, local };
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
    if (!saved.hasKey) return { baseUrl: saved.baseUrl, key: "", local: saved.local };
    try {
      const bytes = saved.encryptedKey === undefined ? fs.readFileSync(file(LEGACY_KEY_FILE)) : Buffer.from(saved.encryptedKey, "base64");
      const { result } = await safeStorage.decryptStringAsync(bytes);
      return { baseUrl: saved.baseUrl, key: result, local: saved.local };
    } catch { throw new Error("Couldn't unlock the endpoint's key. Unlock your system key store or enter the key again in Settings."); }
  }

  async function request({ baseUrl, key, local }, endpoint, options = {}) {
    try {
      return await fetch(baseUrl + endpoint, {
        ...options, signal: options.signal || AbortSignal.timeout(20_000), credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        headers: { Accept: options.body ? "text/event-stream" : "application/json", ...(key ? { Authorization: "Bearer " + key } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}) },
      }, local);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error?.code === "local_refused") {
        throw new Error(`${nameOf(baseUrl)} now leads to an address on this computer or your network that you haven't approved. Connect it again in Settings.`);
      }
      if (error?.code === "public_refused") {
        throw new Error(`${nameOf(baseUrl)} now leads to an address outside this computer and your local network, so Folio sent nothing over plain http. Check your network, or use an https:// address.`);
      }
      throw new Error(`Couldn't reach ${nameOf(baseUrl)}. Check the address and your connection, and that the server is running.`);
    }
  }
  async function failure(name, response) {
    const body = await response.json().catch(() => ({}));
    // A 404 without an API error usually means the base URL is wrong, not the model (for example a missing /v1).
    if (response.status === 404 && !body?.error) return new Error(`${name} has no Chat Completions API at this address. Check the base URL in Settings; many end in /v1.`);
    return providerError(name, response.status, body?.error ?? {});
  }

  /** Lists the server's models. Servers without a model list still work with a typed model ID. */
  async function listModels(endpoint) {
    const response = await request(endpoint, "/models");
    if (response.status === 404 || response.status === 405) { await response.body?.cancel().catch(() => {}); return []; }
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
      if (!baseUrl) throw new Error("Enter the endpoint's address, such as https://api.example.com/v1.");
      const key = typeof input?.key === "string" ? input.key.trim() : "";
      if (key && !validKey(key)) throw new Error("Enter a valid API key, or leave it empty if the server doesn't need one.");
      if (key && !(await secureStorageAvailable(safeStorage))) throw new Error("Unlock or enable your system key store to save an API key.");
      const url = new URL(baseUrl);
      let destination;
      try { destination = await resolve(url); } catch { throw new Error(`Couldn't find ${url.host}. Check the address.`); }
      if (url.protocol === "http:" && !destination.allLocal) throw new Error(HTTPS_ONLY);
      // Nothing is sent to a local address until the person agrees, in the same prompt Folio uses for links.
      if (destination.local && !(await confirmLocal(url, destination.addresses))) throw new Error(`Folio didn't connect to ${url.host}.`);
      const local = destination.local ? { origin: destination.origin, addresses: destination.addresses } : null;
      await listModels({ baseUrl, key, local });
      // One atomic rename keeps the key paired with its destination even if Folio exits during the save.
      try {
        const encryptedKey = key ? (await safeStorage.encryptStringAsync(key)).toString("base64") : null;
        writeAtomic(CONFIG_FILE, JSON.stringify({ baseUrl, encryptedKey, local }));
      } catch {
        throw new Error("Couldn't save the endpoint securely. Check your system key store and try again.");
      }
      // A previous version of this provider kept the encrypted key in a separate file.
      try { fs.rmSync(file(LEGACY_KEY_FILE), { force: true }); } catch {}
    }),
    remove: () => change(() => {
      fs.rmSync(file(CONFIG_FILE), { force: true });
      fs.rmSync(file(LEGACY_KEY_FILE), { force: true });
    }),
    models: async () => listModels(await connection()),
    ask: async ({ model, document, messages }, emit, signal) => {
      if (!validModel(model)) throw new Error("Choose a model for your custom endpoint in Settings.");
      const endpoint = await connection();
      const passage = messages.at(-1)?.context;
      if (document.truncated && !passage) throw new Error("This document exceeds Folio’s whole-document limit. Select a passage and ask again.");
      const { instructions, input } = chatRequest(model, passage
        ? { ...document, text: `[Page ${passage.page}]\n${passage.text}`, truncated: true } : document, messages);
      const body = JSON.stringify({ model, messages: [{ role: "system", content: instructions }, ...input], stream: true });
      const name = nameOf(endpoint.baseUrl), timer = AbortSignal.timeout(5 * 60_000);
      try {
        const response = await request(endpoint, "/chat/completions", { method: "POST", body, signal: AbortSignal.any([signal, timer]) });
        if (!response.ok) throw await failure(name, response);
        await readAnswer(name, response, emit);
      } catch (error) {
        if (timer.aborted && !signal.aborted) throw new Error(`${name} didn't finish answering within 5 minutes. Try again, or ask about a shorter passage.`);
        throw error;
      }
    },
  };
}

module.exports = { createCustomEndpoint, endpointAddress };
