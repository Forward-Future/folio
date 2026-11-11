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
// Public names resolve to a public address; "localhost", "*.lan" and 192.168.* count as local, as network.cjs decides.
// mixed.lan resolves to one local and one public address.
function destination(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "missing.example.test") throw new Error("not found");
  if (host === "mixed.lan") return { origin: url.origin, addresses: ["192.168.1.20", "93.184.216.34"], local: true, allLocal: false };
  const local = host === "localhost" || host.endsWith(".lan") || host.startsWith("192.168.") || host === "::1" || host.startsWith("127.");
  const addresses = local ? [host === "localhost" ? "127.0.0.1" : host.endsWith(".lan") ? "192.168.1.20" : host] : ["93.184.216.34"];
  return { origin: url.origin, addresses, local, allLocal: local };
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "folio-test-endpoint-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = name => path.join(home, name);
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptStringAsync: async value => Buffer.from(value).map(b => b ^ 128),
    decryptStringAsync: async bytes => ({ result: bytes.map(b => b ^ 128).toString() }) };
  const calls = [], asked = [];
  const net = { fetch: async (url, options) => Response.json({ data: [{ id: "sample-model" }] }), answer: true };
  const writes = { writeAtomic: (name, bytes) => fs.writeFileSync(file(name), bytes) };
  const endpoint = createCustomEndpoint({ safeStorage, file, writeAtomic: (name, bytes) => writes.writeAtomic(name, bytes),
    resolve: async url => destination(url),
    confirmLocal: async (url, addresses) => { asked.push({ host: url.host, addresses }); return net.answer; },
    fetch: async (url, options, approvedLocal) => { calls.push({ url, options, approvedLocal }); return net.fetch(url, options, approvedLocal); } });
  return { endpoint, calls, asked, net, safeStorage, file, writes };
}

function stream(...pieces) {
  return new Response(new ReadableStream({ start(controller) {
    for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece));
    controller.close();
  } }));
}

test("addresses are plain http or https, without credentials, queries or fragments", () => {
  assert.equal(endpointAddress(" https://api.example.com/v1/ "), "https://api.example.com/v1");
  assert.equal(endpointAddress("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.equal(endpointAddress("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
  for (const rejected of ["ftp://example.com", "file:///etc/passwd", "https://user:pass@example.com/v1",
    "https://example.com/v1?key=1", "https://example.com/v1#x", "not a url", "", 42, "https://" + "a".repeat(520) + ".com"]) {
    assert.equal(endpointAddress(rejected), null, String(rejected));
  }
});

test("plain http is refused unless the address resolves to this computer or the local network", async t => {
  const { endpoint, calls, asked } = fixture(t);
  await assert.rejects(endpoint.save({ baseUrl: "http://api.example.com/v1", key }), /Use an https:\/\/ address/);
  // Every address must be local: a name with one local and one public address isn't.
  await assert.rejects(endpoint.save({ baseUrl: "http://mixed.lan:8000/v1", key }), /Use an https:\/\/ address/);
  await assert.rejects(endpoint.save({ baseUrl: "https://missing.example.test/v1", key }), /Couldn't find missing\.example\.test/);
  assert.equal(calls.length, 0);
  assert.equal(asked.length, 0);
  assert.equal(endpoint.status().configured, false);
});

test("a local address is confirmed before anything is sent, and only the approved addresses are used", async t => {
  const { endpoint, calls, asked, net, file } = fixture(t);
  net.answer = false;
  await assert.rejects(endpoint.save({ baseUrl: "http://ollama.lan:11434/v1", key: "" }), /didn't connect to ollama\.lan:11434/);
  assert.deepEqual(asked, [{ host: "ollama.lan:11434", addresses: ["192.168.1.20"] }]);
  assert.equal(calls.length, 0, "nothing is sent when the person declines");
  assert.equal(endpoint.status().configured, false);
  net.answer = true;
  await endpoint.save({ baseUrl: "http://ollama.lan:11434/v1", key: "" });
  const approved = { origin: "http://ollama.lan:11434", addresses: ["192.168.1.20"] };
  assert.deepEqual(calls.map(c => c.approvedLocal), [approved]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file("custom-endpoint.json"), "utf8")).local, approved);
  await endpoint.models();
  assert.deepEqual(calls.at(-1).approvedLocal, approved, "later requests carry the same approval");
  assert.equal(asked.length, 2, "approval is asked once per connection, not per request");
  // A public https endpoint never carries a local approval.
  await endpoint.save({ baseUrl: base, key });
  assert.equal(calls.at(-1).approvedLocal, null);
  assert.equal(asked.length, 2);
  // If the guard refuses an address that wasn't approved, say so instead of "couldn't reach".
  net.fetch = async () => { throw Object.assign(new Error("refused"), { code: "local_refused" }); };
  await assert.rejects(endpoint.models(), /haven't approved\. Connect it again in Settings/);
  // If a plain http name later points outside the local network, nothing is sent and the message says why.
  net.fetch = async () => { throw Object.assign(new Error("refused"), { code: "public_refused" }); };
  await assert.rejects(endpoint.models(), /outside this computer and your local network, so Folio sent nothing over plain http/);
  // A saved http address without an approval (hand-edited) isn't trusted.
  fs.writeFileSync(file("custom-endpoint.json"), JSON.stringify({ baseUrl: "http://ollama.lan:11434/v1", hasKey: false, local: null }));
  assert.equal(endpoint.status().configured, false);
  fs.writeFileSync(file("custom-endpoint.json"), JSON.stringify({ baseUrl: "http://ollama.lan:11434/v1", hasKey: false,
    local: { origin: "http://other.lan:11434", addresses: ["192.168.1.20"] } }));
  assert.equal(endpoint.status().configured, false);
});

test("setup checks the server before saving, encrypts the key, and keyless servers work without one", async t => {
  const { endpoint, calls, net, safeStorage, file, writes } = fixture(t);
  assert.deepEqual(endpoint.status(), { configured: false, baseUrl: "", hasKey: false });
  await endpoint.save({ baseUrl: base + "/", key });
  assert.deepEqual(endpoint.status(), { configured: true, baseUrl: base, hasKey: true });
  assert.equal(fs.existsSync(file("custom-endpoint-key.bin")), false);
  assert.equal(fs.readFileSync(file("custom-endpoint.json"), "utf8").includes(key), false);
  await endpoint.check();
  for (const { url, options } of calls) {
    assert.equal(url, base + "/models");
    assert.equal(options.headers.Authorization, "Bearer " + key);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
  }
  // A rejected key leaves the working setup in place.
  const saved = fs.readFileSync(file("custom-endpoint.json"));
  net.fetch = async () => Response.json({ error: { message: "bad key" } }, { status: 401 });
  await assert.rejects(endpoint.save({ baseUrl: base, key: "another-fake-key" }), /llm\.example\.test rejected this key/);
  assert.deepEqual(fs.readFileSync(file("custom-endpoint.json")), saved);
  // Interrupt the commit: nothing else on disk may pair the new key with the old server.
  net.fetch = async () => Response.json({ data: [{ id: "sample-model" }] });
  const { writeAtomic } = writes;
  const attempted = [];
  writes.writeAtomic = (name) => { attempted.push(name); throw new Error("disk full"); };
  await assert.rejects(endpoint.save({ baseUrl: "https://other.example.test/v1", key: "another-fake-key" }), /Couldn't save the endpoint securely/);
  assert.deepEqual(attempted, ["custom-endpoint.json"]);
  writes.writeAtomic = writeAtomic;
  assert.deepEqual(fs.readFileSync(file("custom-endpoint.json")), saved);
  assert.equal(endpoint.status().baseUrl, base);
  await endpoint.check();
  assert.equal(calls.at(-1).url, base + "/models");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer " + key);
  // A key never goes in plain text, but a keyless server needs no key store.
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  await assert.rejects(endpoint.save({ baseUrl: base, key }), /system key store/);
  net.fetch = async () => Response.json({ data: [] });
  await endpoint.save({ baseUrl: "http://localhost:11434/v1", key: "" });
  assert.deepEqual(endpoint.status(), { configured: true, baseUrl: "http://localhost:11434/v1", hasKey: false });
  assert.equal(fs.existsSync(file("custom-endpoint-key.bin")), false);
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  await endpoint.remove();
  assert.equal(endpoint.status().configured, false);
  assert.equal(fs.existsSync(file("custom-endpoint.json")), false);
});

test("a legacy key is usable until a new connection is committed", async t => {
  const { endpoint, calls, file, safeStorage } = fixture(t);
  fs.writeFileSync(file("custom-endpoint-key.bin"), await safeStorage.encryptStringAsync(key));
  fs.writeFileSync(file("custom-endpoint.json"), JSON.stringify({ baseUrl: base, hasKey: true, local: null }));
  await endpoint.check();
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer " + key);
  const next = "https://new.example.test/v1";
  await endpoint.save({ baseUrl: next, key: "new-test-key" });
  assert.equal(fs.existsSync(file("custom-endpoint-key.bin")), false);
  await endpoint.check();
  assert.equal(calls.at(-1).url, next + "/models");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer new-test-key");
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
  const large = { ...question, document: { ...question.document, truncated: true, recognized: true } };
  await assert.rejects(endpoint.ask(large, () => {}, signal), /whole-document limit/);
  await endpoint.ask({ ...large, messages: [{ ...question.messages[0], context: { text: "Excerpt", page: 2 } }] }, () => {}, signal);
  assert.equal(JSON.parse(sent[1].messages[1].content).document.text, "[Page 2]\nExcerpt");
  assert.match(sent[1].messages[0].content, /recognition errors/);
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
  // A 404 that isn't an API error points at the base URL (such as a missing /v1), not the model.
  net.fetch = async () => new Response("404 page not found", { status: 404 });
  await assert.rejects(endpoint.ask(question, () => {}, signal), /no Chat Completions API at this address\. Check the base URL/);
  net.fetch = async () => stream("data: " + JSON.stringify({ choices: [{ delta: { content: "partial" } }] }) + "\n\n");
  await assert.rejects(endpoint.ask(question, () => {}, signal), /without a complete answer/);
  const controller = new AbortController();
  net.fetch = async (_url, options) => {
    controller.abort();
    options.signal.throwIfAborted();
  };
  await assert.rejects(endpoint.ask(question, () => {}, controller.signal), error => error.name === "AbortError");
});

test("an answer that runs past the time limit gets a clear message, not the raw abort error", async t => {
  const { endpoint, net } = fixture(t);
  await endpoint.save({ baseUrl: base, key });
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", ms => timeout(ms >= 60_000 ? 20 : ms));
  net.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ choices: [{ delta: { content: "slow" } }] }) + "\n\n"));
    options.signal.addEventListener("abort", () => controller.error(options.signal.reason));
  } }));
  const alive = setInterval(() => {}, 1000); // AbortSignal.timeout doesn't keep Node running by itself
  try { await assert.rejects(endpoint.ask(question, () => {}, new AbortController().signal), /didn't finish answering within 5 minutes/); }
  finally { clearInterval(alive); }
});
