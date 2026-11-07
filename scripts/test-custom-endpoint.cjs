const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCustomEndpoint, endpointAddress } = require("../electron/custom-endpoint.cjs");

const key = "test-only-example-key";
const base = "https://llm.example.test/v1";
const question = { model: "sample-model", document: { name: "Example.pdf", text: "[Page 1] A sample", truncated: false },
  messages: [{ role: "user", content: "What is the topic?" }] };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "folio-test-endpoint-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = name => path.join(home, name);
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async value => Buffer.from(value).map(b => b ^ 128),
    decryptStringAsync: async bytes => ({ result: bytes.map(b => b ^ 128).toString() }) };
  const calls = [];
  const net = { fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: [{ id: "sample-model" }] });
  } };
  return { endpoint: createCustomEndpoint({ safeStorage, net, file, writeAtomic: (name, bytes) => fs.writeFileSync(file(name), bytes) }),
    calls, net, safeStorage, file };
}

function stream(...pieces) {
  return new Response(new ReadableStream({ start(controller) {
    for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
    controller.close();
  } }));
}

test("addresses need https, except for this computer and the local network", () => {
  assert.equal(endpointAddress(" https://api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(endpointAddress("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(endpointAddress("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.equal(endpointAddress("http://192.168.1.20:8080/v1"), "http://192.168.1.20:8080/v1");
  assert.equal(endpointAddress("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
  for (const rejected of ["http://api.example.com/v1", "http://8.8.8.8/v1", "ftp://example.com", "https://user:pass@example.com/v1",
    "https://example.com/v1?key=1", "https://example.com/v1#x", "not a url", "", 42, "https://" + "a".repeat(520) + ".com"]) {
    assert.equal(endpointAddress(rejected), null, String(rejected));
  }
});

test("setup checks the server before saving, encrypts the key, and keyless servers work without one", async t => {
  const { endpoint, calls, net, safeStorage, file } = fixture(t);
  assert.deepEqual(endpoint.status(), { configured: false, baseUrl: "", hasKey: false });
  await assert.rejects(endpoint.save({ baseUrl: "http://api.example.com/v1", key }), /https/);
  assert.equal(calls.length, 0);
  await endpoint.save({ baseUrl: base + "/", key });
  assert.deepEqual(endpoint.status(), { configured: true, baseUrl: base, hasKey: true });
  assert.equal(fs.readFileSync(file("custom-endpoint-key.bin")).includes(key), false);
  assert.equal(fs.readFileSync(file("custom-endpoint.json"), "utf8").includes(key), false);
  await endpoint.check();
  for (const { url, options } of calls) {
    assert.equal(url, base + "/models");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
  }
  // A rejected key leaves the working setup in place.
  const saved = fs.readFileSync(file("custom-endpoint-key.bin"));
  net.fetch = async () => Response.json({ error: { message: "bad key" } }, { status: 401 });
  await assert.rejects(endpoint.save({ baseUrl: base, key: "another-fake-key" }), /llm\.example\.test rejected this key/);
  assert.deepEqual(fs.readFileSync(file("custom-endpoint-key.bin")), saved);
  // A key never goes in plain text, but a keyless server needs no key store.
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(endpoint.save({ baseUrl: base, key }), /system key store/);
  net.fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ data: [] }); };
  await endpoint.save({ baseUrl: "http://localhost:11434/v1", key: "" });
  assert.deepEqual(endpoint.status(), { configured: true, baseUrl: "http://localhost:11434/v1", hasKey: false });
  assert.equal(fs.existsSync(file("custom-endpoint-key.bin")), false);
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  await endpoint.remove();
  assert.equal(endpoint.status().configured, false);
  assert.equal(fs.existsSync(file("custom-endpoint.json")), false);
});

test("model lists are optional, sorted, and skip unusable IDs", async t => {
  const { endpoint, net } = fixture(t);
  await endpoint.save({ baseUrl: base, key });
  net.fetch = async () => Response.json({ data: [{ id: "zeta", context_length: 8192 }, { id: "alpha", name: "Alpha" }, { id: "has space" }, {}] });
  assert.deepEqual(await endpoint.models(), [{ id: "alpha", name: "Alpha", contextLength: null }, { id: "zeta", name: "zeta", contextLength: 8192 }]);
  net.fetch = async () => new Response("Not found", { status: 404 });
  assert.deepEqual(await endpoint.models(), []);
  await endpoint.check();
  net.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(endpoint.models(), /Couldn't reach llm\.example\.test/);
});

test("answers stream from the configured address, and selection questions omit other pages", async t => {
  const { endpoint, net } = fixture(t);
  await assert.rejects(endpoint.ask(question, () => {}, new AbortController().signal), /Connect a custom endpoint/);
  await endpoint.save({ baseUrl: base, key });
  const sent = [];
  net.fetch = async (url, options) => {
    assert.equal(url, base + "/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    sent.push(JSON.parse(options.body));
    return stream("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"Read \"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"(p. 1)\"},\"finish_reason\":\"stop\"}]}\n\n", "data: [DONE]\n\n");
  };
  const received = [], signal = new AbortController().signal;
  await endpoint.ask(question, text => received.push(text), signal);
  assert.deepEqual(received, ["Read ", "(p. 1)"]);
  assert.equal(sent[0].model, "sample-model");
  assert.equal(sent[0].stream, true);
  assert.equal(sent[0].plugins, undefined);
  assert.match(sent[0].messages[0].content, /untrusted data/);
  const large = { ...question, document: { ...question.document, truncated: true } };
  await assert.rejects(endpoint.ask(large, () => {}, signal), /whole-document limit/);
  await endpoint.ask({ ...large, messages: [{ ...question.messages[0], context: { text: "Excerpt", page: 2 } }] }, () => {}, signal);
  assert.equal(JSON.parse(sent[1].messages[1].content).document.text, "[Page 2]\nExcerpt");
  assert.doesNotMatch(JSON.stringify(sent[1]), /A sample/);
  await assert.rejects(endpoint.ask({ ...question, model: "has space" }, () => {}, signal), /Choose a model/);
});

test("errors name the server, and Stop cancels the request", async t => {
  const { endpoint, net } = fixture(t);
  await endpoint.save({ baseUrl: base, key });
  const signal = new AbortController().signal;
  for (const [status, detail, expected] of [[429, "", /llm\.example\.test is rate limiting/], [404, "", /model ID/],
    [400, "maximum context length exceeded", /context exceed/], [503, "", /unavailable/]]) {
    net.fetch = async () => Response.json({ error: { message: detail } }, { status });
    await assert.rejects(endpoint.ask(question, () => {}, signal), expected);
  }
  net.fetch = async () => stream("data: " + JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) + "\n\n");
  await assert.rejects(endpoint.ask(question, () => {}, signal), /without a complete answer/);
  const controller = new AbortController();
  net.fetch = async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  };
  await assert.rejects(endpoint.ask(question, () => {}, controller.signal), error => error.name === "AbortError");
});
