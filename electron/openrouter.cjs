const fs = require("node:fs");
const { chatRequest } = require("./ai-prompt.cjs");

const API = "https://openrouter.ai/api/v1";
const KEY_FILE = "openrouter-key.bin";
const validModel = (id) => typeof id === "string" && /^[a-z\d_~@.-]+\/[a-z\d_:./~@-]+$/i.test(id) && id.length <= 256;

function providerError(status, detail = {}) {
  if (status === 401) return new Error("OpenRouter rejected this key. Check your API key in Settings.");
  if (status === 403) return new Error("OpenRouter declined this request. Check your key permissions or choose another model.");
  if (status === 402) return new Error("There are insufficient OpenRouter credits for this request. Check your balance or choose a less expensive model.");
  if (status === 429) return new Error("OpenRouter is rate limiting requests. Try again shortly.");
  if (status === 413 || /context.length|context.window|maximum context|too many tokens/i.test(String(detail.code) + " " + String(detail.message))) {
    return new Error("This question and its context exceed the model’s limit. Select a shorter passage or choose a larger-context model.");
  }
  if (status === 404 || status === 400 || status === 422) return new Error("OpenRouter couldn't use this model for the request. Check the model ID or choose another text model.");
  if (status === 502 || status === 503) return new Error("The model is unavailable. Try another OpenRouter model or try again later.");
  return new Error("OpenRouter couldn't complete the request. Please try again.");
}

async function readAnswer(response, emit) {
  if (!response.body) throw new Error("OpenRouter returned an empty answer.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", finished = false, received = false;
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { finished = true; return; }
    let packet;
    try { packet = JSON.parse(data); } catch { throw new Error("OpenRouter sent an unreadable answer. Please try again."); }
    const choice = packet?.choices?.[0];
    if (packet?.error || choice?.finish_reason === "error") throw providerError(Number(packet?.error?.code), packet?.error);
    if (choice?.finish_reason === "length") throw new Error("The model reached its output limit. Ask for a shorter answer.");
    if (choice?.finish_reason === "content_filter") throw new Error("The model declined to return this answer.");
    if (typeof choice?.delta?.content === "string" && choice.delta.content) { received = true; emit(choice.delta.content); }
    if (choice?.finish_reason === "stop") finished = true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let split;
      while ((split = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, split.index));
        buffer = buffer.slice(split.index + split[0].length);
      }
      if (buffer.length > 2_000_000) throw new Error("OpenRouter sent an oversized response.");
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!finished || !received) throw new Error("The OpenRouter connection ended without a complete answer. Please try again.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

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
  let changes = Promise.resolve();
  function change(action) {
    const result = changes.then(action);
    changes = result.catch(() => {});
    return result;
  }
  return {
    status,
    check: async () => check(await credential()),
    save: (input) => change(async () => {
      if (typeof input !== "string" || !/^[\x21-\x7e]{8,512}$/.test(input.trim())) throw new Error("Enter a valid OpenRouter API key.");
      const key = input.trim();
      if (!(await safeStorage.isAsyncEncryptionAvailable()) || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
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
        ? { name: document.name, text: `[Page ${passage.page}]\n${passage.text}`, truncated: true } : document, messages);
      // Small-context endpoints can otherwise silently drop the middle of the document.
      const body = JSON.stringify({ model, messages: [{ role: "system", content: instructions }, ...input], stream: true,
        plugins: [{ id: "context-compression", enabled: false }] });
      const timer = AbortSignal.timeout(5 * 60_000);
      const response = await request("/chat/completions", await credential(), { method: "POST", body, signal: AbortSignal.any([signal, timer]) });
      await readAnswer(response, emit);
    },
  };
}

module.exports = { createOpenRouter };
