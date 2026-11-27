// Google Gemini Developer API provider (https://generativelanguage.googleapis.com/v1beta).
// Runs in the main process so the API key stays in OS secure storage and never reaches the page.
const fs = require("node:fs");
const { chatRequest } = require("./ai-prompt.cjs");
const { secureStorageAvailable, serial } = require("./chat-completions.cjs");

const API = "https://generativelanguage.googleapis.com/v1beta";
const KEY_FILE = "gemini-key.bin";
const NAME = "Gemini";
const MAX_MODEL_PAGES = 5;
const BLOCK_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

const normalizeModel = (id) => (typeof id === "string" ? id.trim().replace(/^models\//, "") : "");
const validModel = (id) => typeof id === "string" && /^[a-z\d][a-z\d._-]{0,127}$/i.test(id) && !id.includes("..");

function geminiError(status, detail = {}) {
  const parts = [detail?.status, detail?.message];
  if (Array.isArray(detail?.details)) {
    for (const item of detail.details) parts.push(item?.reason, item?.message);
  }
  const text = parts.filter(Boolean).join(" ");
  if (status === 401 || /\bAPI_KEY_INVALID\b|api key not valid|invalid api key/i.test(text)) {
    return new Error(`${NAME} rejected this key. Check your API key in Settings.`);
  }
  if (status === 403) return new Error(`${NAME} declined this request. Check your API key permissions or choose another model.`);
  if (status === 429 || /\bRESOURCE_EXHAUSTED\b/i.test(text)) {
    return new Error(`${NAME} rate limit or quota exceeded. Check your plan or try again shortly.`);
  }
  if (status === 413 || /token count exceeds|exceeds the maximum number of tokens|input token count|context.length|context.window|maximum context|too many tokens/i.test(text)) {
    return new Error("This question and its context exceed the model’s limit. Select a shorter passage or choose a larger-context model.");
  }
  if (status === 404 || status === 400 || status === 422) {
    return new Error(`${NAME} couldn't use this model for the request. Check the model ID or choose another text model.`);
  }
  if (status === 502 || status === 503 || /\bUNAVAILABLE\b/i.test(text)) {
    return new Error(`The model is unavailable. Try another ${NAME} model or try again later.`);
  }
  return new Error(`${NAME} couldn't complete the request. Please try again.`);
}

/** Converts Folio's chat turns to Gemini's alternating user/model contents array. */
function buildContents(input) {
  const contents = [];
  for (const item of input) {
    const role = item.role === "assistant" ? "model" : "user";
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push({ text: item.content });
    else contents.push({ role, parts: [{ text: item.content }] });
  }
  return contents;
}

/** Streams text from Gemini's SSE response to `emit`; skips thinking parts and throws on blocks or truncation. */
async function readGeminiAnswer(response, emit) {
  if (!response.body) throw new Error(`${NAME} returned an empty answer.`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", finished = false, received = false;
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    let packet;
    try { packet = JSON.parse(data); } catch { throw new Error(`${NAME} sent an unreadable answer. Please try again.`); }
    if (packet?.error) throw geminiError(Number(packet.error.code), packet.error);
    if (packet?.promptFeedback?.blockReason) throw new Error("The model declined to return this answer.");
    const candidate = packet?.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text && !part.thought) { received = true; emit(part.text); }
      }
    }
    const reason = candidate?.finishReason;
    if (reason === "MAX_TOKENS") throw new Error("The model reached its output limit. Ask for a shorter answer.");
    if (reason && BLOCK_REASONS.has(reason)) throw new Error("The model declined to return this answer.");
    if (reason === "STOP") finished = true;
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
      if (buffer.length > 2_000_000) throw new Error(`${NAME} sent an oversized response.`);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!finished || !received) throw new Error(`The ${NAME} connection ended without a complete answer. Please try again.`);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function createGemini({ net, safeStorage, file, writeAtomic }) {
  const status = () => ({ configured: fs.existsSync(file(KEY_FILE)) });
  async function credential() {
    if (!status().configured) throw new Error("Connect a Gemini API key in Settings.");
    try {
      const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file(KEY_FILE)));
      return result;
    } catch { throw new Error("Couldn't unlock the Gemini key. Unlock your system key store or replace the key in Settings."); }
  }

  async function request(endpoint, key, options = {}) {
    const signal = options.signal || AbortSignal.timeout(20_000);
    let response;
    try {
      response = await net.fetch(API + endpoint, {
        ...options, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        // Pass the key in a header instead of the URL so it never lands in logs or error messages.
        headers: { Accept: options.body ? "text/event-stream" : "application/json", "x-goog-api-key": key,
          ...(options.body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error("Couldn't reach Gemini. Check your connection and try again.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = Array.isArray(body) ? body[0]?.error : body?.error;
      throw geminiError(response.status, detail ?? {});
    }
    return response;
  }

  async function check(key) {
    const response = await request("/models?pageSize=1", key);
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.models)) throw new Error("Gemini couldn't verify the API key.");
  }

  const change = serial();
  return {
    status,
    check: async () => check(await credential()),
    save: (input) => change(async () => {
      if (typeof input !== "string" || !/^[\x21-\x7e]{8,512}$/.test(input.trim())) throw new Error("Enter a valid Gemini API key.");
      const key = input.trim();
      if (!(await secureStorageAvailable(safeStorage))) {
        throw new Error("Unlock or enable your system key store to save a Gemini key.");
      }
      await check(key);
      try { writeAtomic(KEY_FILE, await safeStorage.encryptStringAsync(key)); }
      catch { throw new Error("Couldn't save the key securely. Check your system key store and try again."); }
    }),
    remove: () => change(() => fs.rmSync(file(KEY_FILE), { force: true })),
    models: async () => {
      const key = await credential();
      const seen = new Map();
      let pageToken = "";
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const query = pageToken ? `/models?pageSize=1000&pageToken=${encodeURIComponent(pageToken)}` : "/models?pageSize=1000";
        const data = await (await request(query, key)).json().catch(() => null);
        if (!Array.isArray(data?.models)) throw new Error("Couldn't read the model list. Enter a model ID or try again.");
        for (const m of data.models) {
          if (!Array.isArray(m?.supportedGenerationMethods) || !m.supportedGenerationMethods.includes("generateContent")) continue;
          const id = normalizeModel(m.name);
          if (!validModel(id) || seen.has(id)) continue;
          seen.set(id, {
            id,
            name: typeof m.displayName === "string" && m.displayName ? m.displayName.slice(0, 160) : id,
            contextLength: Number.isSafeInteger(m.inputTokenLimit) && m.inputTokenLimit > 0 ? m.inputTokenLimit : null,
          });
        }
        if (typeof data.nextPageToken !== "string" || !data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
      return [...seen.values()].sort((a, b) => {
        const aGemini = a.id.startsWith("gemini-"), bGemini = b.id.startsWith("gemini-");
        if (aGemini !== bGemini) return aGemini ? -1 : 1;
        if (a.id.startsWith(b.id + "-")) return 1;
        if (b.id.startsWith(a.id + "-")) return -1;
        return b.id.localeCompare(a.id, undefined, { numeric: true });
      });
    },
    ask: async ({ model, document, messages }, emit, signal) => {
      const id = normalizeModel(model);
      if (!validModel(id)) throw new Error("Choose a Gemini model in Settings.");
      const passage = messages.at(-1)?.context;
      if (document.truncated && !passage) throw new Error("This document exceeds Folio’s whole-document limit. Select a passage and ask again.");
      const { instructions, input } = chatRequest(id, passage
        ? { ...document, text: `[Page ${passage.page}]\n${passage.text}`, truncated: true } : document, messages);
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: buildContents(input),
      });
      const timer = AbortSignal.timeout(5 * 60_000);
      try {
        const response = await request(`/models/${id}:streamGenerateContent?alt=sse`, await credential(),
          { method: "POST", body, signal: AbortSignal.any([signal, timer]) });
        await readGeminiAnswer(response, emit);
      } catch (error) {
        if (timer.aborted && !signal.aborted) throw new Error("Gemini didn't finish answering within 5 minutes. Try again, or ask about a shorter passage.");
        throw error;
      }
    },
  };
}

module.exports = { createGemini, validModel };
