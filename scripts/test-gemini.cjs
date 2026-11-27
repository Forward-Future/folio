const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGemini, validModel } = require("../electron/gemini.cjs");

const key = "test-only-gemini-key";
const question = {
  model: "gemini-2.5-flash",
  document: { name: "Example.pdf", text: "[Page 1] A sample", truncated: false, recognized: false },
  messages: [{ role: "user", content: "What is the topic?" }],
};
const flashModel = {
  name: "models/gemini-2.5-flash",
  displayName: "Gemini 2.5 Flash",
  inputTokenLimit: 1_048_576,
  supportedGenerationMethods: ["generateContent", "countTokens"],
};

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "folio-test-gemini-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = name => path.join(home, name);
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async value => Buffer.from(value).map(b => b ^ 128),
    decryptStringAsync: async bytes => ({ result: bytes.map(b => b ^ 128).toString() }),
  };
  const calls = [];
  const net = {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ models: [flashModel] });
    },
  };
  return {
    gemini: createGemini({ safeStorage, net, file, writeAtomic: (name, bytes) => fs.writeFileSync(file(name), bytes) }),
    calls, net, safeStorage, file,
  };
}

function stream(...pieces) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
      controller.close();
    },
  }));
}

test("key setup sends the key only in a header, validates before saving, preserves a working key on error, and removes unreadable keys", async t => {
  const { gemini, calls, net, safeStorage, file } = fixture(t);
  assert.deepEqual(gemini.status(), { configured: false });
  await gemini.save(key);
  assert.deepEqual(gemini.status(), { configured: true });
  const bytes = fs.readFileSync(file("gemini-key.bin"));
  assert.equal(bytes.includes(key), false);
  await gemini.check();
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
    assert.equal(url.includes(key), false);
    assert.equal(options.headers["x-goog-api-key"], key);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.body, undefined);
  }
  // Gemini returns HTTP 400 with API_KEY_INVALID for a wrong API key.
  net.fetch = async () => Response.json({
    error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
      details: [{ reason: "API_KEY_INVALID" }] },
  }, { status: 400 });
  await assert.rejects(gemini.save("another-fake-key"), /rejected this key/);
  assert.deepEqual(fs.readFileSync(file("gemini-key.bin")), bytes);
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(gemini.save(key), /system key store/);
  safeStorage.decryptStringAsync = async () => { throw new Error("locked"); };
  await assert.rejects(gemini.check(), /unlock/);
  await gemini.remove();
  assert.equal(fs.existsSync(file("gemini-key.bin")), false);
});

test("model listing filters to generateContent, follows pagination, strips the models/ prefix, and sorts Gemini models first", async t => {
  const { gemini, net } = fixture(t);
  await gemini.save(key);
  const urls = [];
  net.fetch = async (url, options) => {
    urls.push(url);
    assert.equal(options.headers["x-goog-api-key"], key);
    if (!url.includes("pageToken=")) {
      return Response.json({
        models: [
          { name: "models/text-embedding-004", displayName: "Embedding", inputTokenLimit: 2048, supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemma-3-27b-it", displayName: "Gemma 3 27B", inputTokenLimit: 131072, supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
        ],
        nextPageToken: "page-2",
      });
    }
    return Response.json({
      models: [
        { name: "models/gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash-Lite", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
        flashModel,
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1_048_576, supportedGenerationMethods: ["generateContent"] },
      ],
    });
  };
  const models = await gemini.models();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /pageToken=page-2/);
  assert.deepEqual(models, [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLength: 1_048_576 },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextLength: 1_048_576 },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite", contextLength: 1_048_576 },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextLength: 1_048_576 },
    { id: "gemma-3-27b-it", name: "Gemma 3 27B", contextLength: 131072 },
  ]);
});

test("model IDs reject path traversal and URL syntax", () => {
  for (const good of ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-flash-preview", "gemma-3-27b-it"]) {
    assert.equal(validModel(good), true, good);
  }
  for (const bad of ["", "../other", "models/gemini-2.5-flash", "gemini?key=1", "gemini#frag", "gemini..flash", "gemini flash"]) {
    assert.equal(validModel(bad), false, bad);
  }
});

test("answers stream text while skipping thoughts, merge consecutive user turns, and scope selection questions", async t => {
  const { gemini, net } = fixture(t);
  await gemini.save(key);
  const sent = [];
  net.fetch = async (url, options) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    assert.equal(options.headers["x-goog-api-key"], key);
    sent.push(JSON.parse(options.body));
    return stream(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"thinking...","thought":true},{"text":"Read "}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"(p. 1)"}]},"finishReason":"STOP"}]}\n\n',
    );
  };
  const received = [], signal = new AbortController().signal;
  await gemini.ask({
    ...question,
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow up" },
    ],
  }, text => received.push(text), signal);
  assert.deepEqual(received, ["Read ", "(p. 1)"]);
  assert.match(sent[0].systemInstruction.parts[0].text, /untrusted data/);
  // Document payload and first user message are merged into one user turn so roles alternate cleanly.
  assert.deepEqual(sent[0].contents.map(c => c.role), ["user", "model", "user"]);
  assert.equal(JSON.parse(sent[0].contents[0].parts[0].text).document.text, question.document.text);
  assert.equal(sent[0].contents[0].parts[1].text, "First question");
  assert.equal(sent[0].contents[1].parts[0].text, "First answer");
  assert.equal(sent[0].contents[2].parts[0].text, "Follow up");

  const large = { ...question, document: { ...question.document, truncated: true, recognized: true } };
  await assert.rejects(gemini.ask(large, () => {}, signal), /whole-document limit/);
  assert.equal(sent.length, 1);
  await gemini.ask({ ...large, messages: [{ ...question.messages[0], context: { text: "Excerpt", page: 2 } }] }, () => {}, signal);
  assert.equal(JSON.parse(sent[1].contents[0].parts[0].text).document.text, "[Page 2]\nExcerpt");
  assert.match(sent[1].systemInstruction.parts[0].text, /recognition errors/);
  assert.doesNotMatch(JSON.stringify(sent[1]), /A sample/);
});

test("requests surface quota, unavailable models, context limits, safety blocks, incomplete streams and cancellation", async t => {
  const { gemini, net } = fixture(t);
  await gemini.save(key);
  const signal = new AbortController().signal;
  await assert.rejects(gemini.ask({ ...question, model: "../bad" }, () => {}, signal), /Choose a Gemini model/);
  for (const [status, body, expected] of [
    [403, { error: { message: "blocked" } }, /permissions/],
    [429, { error: { status: "RESOURCE_EXHAUSTED" } }, /quota/],
    [404, { error: { message: "not found" } }, /model ID/],
    [400, { error: { message: "The input token count exceeds the maximum number of tokens allowed" } }, /context exceed/],
    [503, [{ error: { status: "UNAVAILABLE" } }], /unavailable/],
  ]) {
    net.fetch = async () => Response.json(body, { status });
    await assert.rejects(gemini.ask(question, () => {}, signal), expected);
  }
  for (const [event, expected] of [
    [{ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, /quota/],
    [{ promptFeedback: { blockReason: "SAFETY" } }, /declined/],
    [{ candidates: [{ finishReason: "SAFETY" }] }, /declined/],
    [{ candidates: [{ finishReason: "MAX_TOKENS" }] }, /output limit/],
    [{ candidates: [{ content: { parts: [{ text: "partial" }] } }] }, /without a complete answer/],
    [{ candidates: [{ content: { parts: [{ text: "only thought", thought: true }] }, finishReason: "STOP" }] }, /without a complete answer/],
  ]) {
    net.fetch = async () => stream("data: " + JSON.stringify(event) + "\n\n");
    await assert.rejects(gemini.ask(question, () => {}, signal), expected);
  }
  const controller = new AbortController();
  net.fetch = async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  };
  await assert.rejects(gemini.ask(question, () => {}, controller.signal));
});
