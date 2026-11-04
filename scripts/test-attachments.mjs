import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../src/attachments.ts", import.meta.url), "utf8");
const compiled = stripTypeScriptTypes(source);
const { AttachmentBroker, discoverAttachments } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const fakePdf = getAttachmentContent => ({ loadingTask: { onPassword: null }, getAttachmentContent });
const request = (retrievalId, intent = "save", owner = "parent") => ({ retrievalId, intent, owner });
const aborted = error => error.name === "AbortError";

test("discovery publishes catalog early, scans unvisited pages, and never extracts bytes", async () => {
  const pages = deferred(), states = [];
  const pdf = {
    getAttachments: async () => new Map([["catalog-id", { filename: "same.pdf", description: "Catalog description" }]]),
    getAnnotationsByType: (types, skip) => { assert.deepEqual([...types], [17]); assert.equal(skip.size, 0); return pages.promise; },
    getMetadata: async () => ({ info: { IsCollectionPresent: true } }),
    getAttachmentContent: () => assert.fail("Metadata discovery extracted bytes"),
  };
  const discovery = discoverAttachments(pdf, state => states.push(state));
  await turn();
  assert.equal(states.at(-1).items[0].retrievalId, "catalog-id");
  assert.equal(states.at(-1).pagesLoading, true);
  assert.equal(states.at(-1).complete, false);
  pages.resolve([
    { fileId: "page-id", file: { filename: "same.pdf" }, pageIndex: 8 },
    { fileId: "page-id", file: { filename: "same.pdf" }, pageIndex: 1 },
    { fileId: "catalog-id", file: { filename: "same.pdf" }, pageIndex: 2 },
  ]);
  const result = await discovery;
  assert.equal(result.complete, true);
  assert.equal(result.isCollection, true);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.find(item => item.key === "annotation:page-id").pageNumbers, [2, 9]);
  assert.equal(new Set(result.items.map(item => item.key)).size, 3);
});

test("discovery preserves partial entries and reports independent failures and truncation", async () => {
  const result = await discoverAttachments({
    getAttachments: async () => new Map([["a", { filename: "" }], ["b", { filename: "" }]]),
    getAnnotationsByType: async () => { throw new Error("broken page"); },
    getMetadata: async () => { throw new Error("broken metadata"); },
  }, () => {}, { maxEntries: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].filename, "");
  assert.equal(result.truncated, true);
  assert.equal(result.errors.length, 2);
  assert.equal(result.complete, true);
});

test("null discovery is empty and canceled discovery never publishes late state", async () => {
  const pages = deferred(), controller = new AbortController(), states = [];
  const done = discoverAttachments({
    getAttachments: async () => null, getAnnotationsByType: () => pages.promise,
    getMetadata: async () => ({ info: {} }),
  }, state => states.push(state), { signal: controller.signal });
  await turn(); controller.abort(); const count = states.length;
  pages.resolve(null); await done;
  assert.equal(states.length, count);
  assert.equal(states.at(-1).items.length, 0);
});

test("Save, Read, and page-content share one slot until the underlying call settles", async () => {
  const first = deferred(), calls = [];
  const broker = new AttachmentBroker(fakePdf(id => { calls.push(id); return id === "a" ? first.promise : Promise.resolve(new Uint8Array([2])); }));
  const a = broker.enqueue(request("a"));
  const b = broker.enqueue(request("b", "read", "child"));
  const c = broker.enqueue(request("c", "page-content"));
  assert.deepEqual(calls, ["a"]);
  const rejection = assert.rejects(a.promise, aborted);
  a.cancel(); await rejection;
  assert.deepEqual(calls, ["a"], "UI cancellation must retain the occupied PDF.js slot");
  first.resolve(new Uint8Array([1]));
  assert.deepEqual(await b.promise, new Uint8Array([2]));
  assert.deepEqual(await c.promise, new Uint8Array([2]));
  assert.deepEqual(calls, ["a", "b", "c"]);
  broker.dispose();
});

test("cancel before first challenge answers the late challenge with Error", async () => {
  const pending = deferred(), answers = [], calls = [];
  const pdf = fakePdf(id => { calls.push(id); return id === "first" ? pending.promise : Promise.resolve(new Uint8Array()); });
  const broker = new AttachmentBroker(pdf, { onPassword: () => assert.fail("Canceled owner received a password UI") });
  const a = broker.enqueue(request("first")); const rejected = assert.rejects(a.promise, aborted);
  const b = broker.enqueue(request("next")); a.cancel(); await rejected;
  pdf.loadingTask.onPassword(answer => { answers.push(answer); pending.reject(answer); }, 1);
  assert.equal(answers[0] instanceof Error, true);
  await b.promise; assert.deepEqual(calls, ["first", "next"]);
  broker.dispose();
});

test("wrong-password re-prompt stays with the owner; stale submissions cannot answer a later challenge", async () => {
  const pending = deferred(), challenges = [], answers = [];
  const pdf = fakePdf(() => pending.promise);
  const broker = new AttachmentBroker(pdf, { onPassword: value => { if (value) challenges.push(value); } });
  const action = broker.enqueue(request("read-id", "read", "child-7"));
  pdf.loadingTask.onPassword(value => answers.push(value), 1);
  challenges[0].submit("wrong");
  pdf.loadingTask.onPassword(value => answers.push(value), 2);
  assert.equal(challenges[1].owner, "child-7"); assert.equal(challenges[1].intent, "read");
  challenges[0].submit("stale"); assert.deepEqual(answers, ["wrong"]);
  challenges[1].submit("correct"); pending.resolve(new Uint8Array([9]));
  await action.promise; assert.deepEqual(answers, ["wrong", "correct"]);
  broker.dispose();
});

test("cancel after submission rejects a late retry challenge and keeps the next action queued", async () => {
  const pending = deferred(), challenges = [], answers = [], calls = [];
  const pdf = fakePdf(id => { calls.push(id); return id === "first" ? pending.promise : Promise.resolve(new Uint8Array()); });
  const broker = new AttachmentBroker(pdf, { onPassword: value => { if (value) challenges.push(value); } });
  const a = broker.enqueue(request("first")); const rejected = assert.rejects(a.promise, aborted);
  const b = broker.enqueue(request("second"));
  pdf.loadingTask.onPassword(value => answers.push(value), 1); challenges[0].submit("wrong"); a.cancel(); await rejected;
  pdf.loadingTask.onPassword(value => answers.push(value), 2);
  assert.equal(answers[1] instanceof Error, true); assert.deepEqual(calls, ["first"]);
  challenges[0].submit("stale"); assert.equal(answers.length, 2);
  pending.reject(answers[1]); await b.promise;
  assert.deepEqual(calls, ["first", "second"]); broker.dispose();
});

test("page-content cancellation and failures resolve null; empty bytes remain a valid file", async () => {
  const pending = deferred(), errors = [];
  const pdf = fakePdf(id => id === "pending" ? pending.promise : id === "empty" ? Promise.resolve(new Uint8Array()) : id === "missing" ? Promise.resolve(null) : Promise.reject(new Error("decode failed")));
  const broker = new AttachmentBroker(pdf, { onError: state => errors.push(state) });
  const active = broker.enqueue(request("pending", "page-content"));
  const queued = broker.enqueue(request("never-called", "page-content")); queued.cancel();
  assert.equal(await queued.promise, null); active.cancel(); assert.equal(await active.promise, null);
  pending.resolve(null); await turn();
  assert.equal(await broker.enqueue(request("failure", "page-content")).promise, null);
  await assert.rejects(broker.enqueue(request("missing")).promise, /unavailable/);
  assert.equal((await broker.enqueue(request("empty")).promise).byteLength, 0);
  assert.equal(errors.length, 2); broker.dispose();
});

test("dispose settles password and queued consumers before best-effort destruction", async () => {
  const pending = deferred(), answers = [], challenges = [];
  const pdf = fakePdf(() => pending.promise);
  const broker = new AttachmentBroker(pdf, { onPassword: value => { if (value) challenges.push(value); } });
  const active = broker.enqueue(request("a", "read", "child")); const rejected = assert.rejects(active.promise, aborted);
  const page = broker.enqueue(request("b", "page-content"));
  pdf.loadingTask.onPassword(value => answers.push(value), 1);
  broker.dispose();
  await rejected; assert.equal(await page.promise, null); assert.equal(answers[0] instanceof Error, true);
  await assert.rejects(Promise.reject(new Error("destruction rejected")), /destruction/);
  pdf.loadingTask.onPassword(value => answers.push(value), 2);
  assert.equal(answers[1] instanceof Error, true);
  challenges[0].submit("stale"); assert.equal(answers.length, 2);
  pending.reject(answers[0]); await turn();
});

test("duplicate row requests share one action, while different parents proceed independently", async () => {
  const pending = deferred(); let calls = 0;
  const one = new AttachmentBroker(fakePdf(() => { calls++; return pending.promise; }));
  const a = one.enqueue({ ...request("same"), key: "document:same" });
  const duplicate = one.enqueue({ ...request("same", "read", "child"), key: "document:same" });
  assert.equal(a, duplicate); assert.equal(calls, 1);
  const two = new AttachmentBroker(fakePdf(async () => new Uint8Array([4])));
  assert.deepEqual(await two.enqueue(request("other")).promise, new Uint8Array([4]));
  pending.resolve(new Uint8Array([1])); await a.promise; one.dispose(); two.dispose();
});

test("decoded acceptance limit reports owner error and preserves the queue", async () => {
  const broker = new AttachmentBroker(fakePdf(async () => new Uint8Array([1, 2])), { maxBytes: 1 });
  await assert.rejects(broker.enqueue(request("big")).promise, /larger/);
  assert.equal(await broker.enqueue(request("big", "page-content")).promise, null);
  broker.dispose();
});

test("attachment hook returns original consumer bytes, keeps normal link methods, and soft-fails", async () => {
  const source = await readFile(new URL("../src/attachmentLinkService.ts", import.meta.url), "utf8");
  const compiled = stripTypeScriptTypes(source).replace(
    /import \{ PDFLinkService \} from "pdfjs-dist\/web\/pdf_viewer.mjs";/,
    "class PDFLinkService { constructor(options) { this.options = options; } goToDestination(dest) { return dest; } }",
  );
  const { AttachmentLinkService } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const bytes = new Uint8Array([1, 2, 3]); const ids = [];
  const parent = new AttachmentLinkService({ eventBus: {} }, async id => { ids.push(id); return bytes; });
  assert.equal(await parent.getAttachmentContent("opaque-media-or-file-id"), bytes);
  assert.deepEqual(ids, ["opaque-media-or-file-id"]);
  assert.equal(parent.goToDestination("chapter"), "chapter");
  const failure = new AttachmentLinkService({ eventBus: {} }, async () => { throw new Error("unavailable"); });
  assert.equal(await failure.getAttachmentContent("file"), null);
  let explained = false;
  const child = new AttachmentLinkService({ eventBus: {} }, async () => { explained = true; return null; });
  assert.equal(await child.getAttachmentContent("nested"), null); assert.equal(explained, true);
});
