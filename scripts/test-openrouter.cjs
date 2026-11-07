const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOpenRouter } = require("../electron/openrouter.cjs");

const key = "test-only-example-key";
const question = { model: "fixture/reader", document: { name: "Example.pdf", text: "[Page 1] A sample", truncated: false },
  messages: [{ role: "user", content: "What is the topic?" }] };
const model = { id: question.model, name: "Reader", context_length: 8192,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] } };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "folio-test-router-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = name => path.join(home, name);
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async value => Buffer.from(value).map(b => b ^ 128),
    decryptStringAsync: async bytes => ({ result: bytes.map(b => b ^ 128).toString() }) };
  const calls = [];
  const net = { fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: {} });
  } };
  return { router: createOpenRouter({ safeStorage, net, file, writeAtomic: (name, bytes) => fs.writeFileSync(file(name), bytes) }),
    calls, net, safeStorage, file };
}

test("key setup validates before encryption, preserves a good key on failure, and removes even an unreadable key", async t => {
  const { router, calls, net, safeStorage, file } = fixture(t);
  assert.deepEqual(router.status(), { configured: false });
  await router.save(key);
  assert.deepEqual(router.status(), { configured: true });
  const bytes = fs.readFileSync(file("openrouter-key.bin"));
  assert.equal(bytes.includes(key), false);
  await router.check();
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, "https://openrouter.ai/api/v1/key");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.body, undefined);
  }
  net.fetch = async () => Response.json({ error: { message: key } }, { status: 401 });
  await assert.rejects(router.save("another-fake-key"), /rejected this key/);
  assert.deepEqual(fs.readFileSync(file("openrouter-key.bin")), bytes);
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(router.save(key), /system key store/);
  safeStorage.decryptStringAsync = async () => { throw new Error("locked"); };
  await assert.rejects(router.check(), /unlock/);
  await router.remove();
  assert.equal(fs.existsSync(file("openrouter-key.bin")), false);
});

test("setup returns only compatible text models and their individual context windows", async t => {
  const { router, net } = fixture(t);
  await router.save(key);
  net.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/v1/models");
    assert.equal(options.body, undefined);
    return Response.json({ data: [model, { ...model, id: "fixture/picture", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }] });
  };
  assert.deepEqual(await router.models(), [{ id: model.id, name: model.name, contextLength: 8192 }]);
});

function stream(...pieces) {
  return new Response(new ReadableStream({ start(controller) {
    for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
    controller.close();
  } }));
}

test("answers stream page-marked content, selection questions omit other pages, and context overflow stays explicit", async t => {
  const { router, net } = fixture(t);
  await router.save(key);
  const sent = [];
  net.fetch = async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    sent.push(JSON.parse(options.body));
    return stream(": comment\r\n\r", "\ndata: {\"choices\":[{\"delta\":{\"content\":\"Read \"}}]}\r\n\r",
      "\ndata: {\"choices\":[{\"delta\":{\"content\":\"(p. 1)\"},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n");
  };
  const received = [], signal = new AbortController().signal;
  await router.ask(question, text => received.push(text), signal);
  assert.deepEqual(received, ["Read ", "(p. 1)"]);
  assert.equal(JSON.parse(sent[0].messages[1].content).document.text, question.document.text);
  assert.match(sent[0].messages[0].content, /untrusted data/);
  assert.deepEqual(sent[0].plugins, [{ id: "context-compression", enabled: false }]);
  const large = { ...question, document: { ...question.document, truncated: true } };
  await assert.rejects(router.ask(large, () => {}, signal), /whole-document limit/);
  assert.equal(sent.length, 1);
  await router.ask({ ...large, messages: [{ ...question.messages[0], context: { text: "Excerpt", page: 2 } }] }, () => {}, signal);
  assert.equal(JSON.parse(sent[1].messages[1].content).document.text, "[Page 2]\nExcerpt");
  assert.doesNotMatch(JSON.stringify(sent[1]), /A sample/);
});

test("requests surface billing, unavailable models, context limits, incomplete streams and cancellation", async t => {
  const { router, net } = fixture(t);
  await router.save(key);
  const signal = new AbortController().signal;
  for (const [status, detail, expected] of [[402, "", /insufficient/], [429, "", /rate limiting/], [404, "", /model ID/],
    [400, "maximum context length exceeded", /context exceed/], [503, "", /unavailable/]]) {
    net.fetch = async () => Response.json({ error: { message: detail } }, { status });
    await assert.rejects(router.ask(question, () => {}, signal), expected);
  }
  for (const [event, expected] of [[{error:{code:402}}, /insufficient/], [{choices:[{finish_reason:"length"}]}, /output limit/],
    [{choices:[{delta:{content:"partial"}}]}, /without a complete answer/]]) {
    net.fetch = async () => stream("data: " + JSON.stringify(event) + "\n\n");
    await assert.rejects(router.ask(question, () => {}, signal), expected);
  }
  const controller = new AbortController();
  net.fetch = async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  };
  await assert.rejects(router.ask(question, () => {}, controller.signal));
});
