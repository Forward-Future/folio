// Shared by the providers that speak the OpenAI-style Chat Completions API (OpenRouter and custom endpoints).

function providerError(name, status, detail = {}) {
  if (status === 401) return new Error(`${name} rejected this key. Check your API key in Settings.`);
  if (status === 403) return new Error(`${name} declined this request. Check your key permissions or choose another model.`);
  if (status === 402) return new Error(`There are insufficient ${name} credits for this request. Check your balance or choose a less expensive model.`);
  if (status === 429) return new Error(`${name} is rate limiting requests. Try again shortly.`);
  if (status === 413 || /context.length|context.window|maximum context|too many tokens/i.test(String(detail.code) + " " + String(detail.message))) {
    return new Error("This question and its context exceed the model’s limit. Select a shorter passage or choose a larger-context model.");
  }
  if (status === 404 || status === 400 || status === 422) return new Error(`${name} couldn't use this model for the request. Check the model ID or choose another text model.`);
  if (status === 502 || status === 503) return new Error(`The model is unavailable. Try another ${name} model or try again later.`);
  return new Error(`${name} couldn't complete the request. Please try again.`);
}

/** Streams the text of a Chat Completions answer to `emit`; throws if it ends early or reports an error. */
async function readAnswer(name, response, emit) {
  if (!response.body) throw new Error(`${name} returned an empty answer.`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", finished = false, received = false;
  const consume = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
    if (!data) return;
    if (data === "[DONE]") { finished = true; return; }
    let packet;
    try { packet = JSON.parse(data); } catch { throw new Error(`${name} sent an unreadable answer. Please try again.`); }
    const choice = packet?.choices?.[0];
    if (packet?.error || choice?.finish_reason === "error") throw providerError(name, Number(packet?.error?.code), packet?.error);
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
      if (buffer.length > 2_000_000) throw new Error(`${name} sent an oversized response.`);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!finished || !received) throw new Error(`The ${name} connection ended without a complete answer. Please try again.`);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Saves secrets only where the operating system protects them (never Linux's plain-text fallback). */
async function secureStorageAvailable(safeStorage) {
  return (await safeStorage.isAsyncEncryptionAvailable())
    && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
}

/** Runs actions one after another, so removing a key during a connection check takes effect last. */
function serial() {
  let changes = Promise.resolve();
  return (action) => {
    const result = changes.then(action);
    changes = result.catch(() => {});
    return result;
  };
}

module.exports = { providerError, readAnswer, secureStorageAvailable, serial };
