// Controller regressions use a tiny shell and injected storage; no PDF worker or visible window.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transformWithOxc } from "vite";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let membership = [], pendingMembership = [], startup = null, focus = null;
let recentListeners = [];
const env = {
  activeDocument: () => startup,
  setActiveDocument: value => { startup = value; },
  getRecent: async id => membership.find(file => file.id === id),
  listRecent: () => pendingMembership.shift()?.promise ?? Promise.resolve(membership),
  subscribeRecent: listener => { recentListeners.push(listener); return () => {}; },
};
globalThis.__attachmentTabsTest = env;
const source = (await readFile(new URL("../src/documentTabs.ts", import.meta.url), "utf8"))
  .replace(/^import .* from "\.\/(session|recent)";$/gm, "")
  .replace("export type AttachmentOrigin", "const {activeDocument,setActiveDocument,getRecent,listRecent,subscribeRecent} = globalThis.__attachmentTabsTest;\nexport type AttachmentOrigin");
const { code: js } = await transformWithOxc(source, "documentTabs.ts");
const { DocumentTabs } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

function shell() {
  membership = []; pendingMembership = []; startup = null; focus = null; recentListeners = [];
  const frames = [];
  const shellWindow = new EventTarget();
  shellWindow.confirm = () => true;
  globalThis.window = shellWindow;
  globalThis.location = { href: "http://folio.test/index.html" };
  globalThis.document = { title: "", fullscreenElement: null, createElement() {
    const frame = { classList: { toggle() {} }, focus() { focus = frame.name; }, remove() { frames.splice(frames.indexOf(frame), 1); } };
    return frame;
  } };
  const tabs = new DocumentTabs({ append: frame => frames.push(frame) });
  const normal = name => {
    const key = tabs.open([{ kind: "bytes", name, data: new Uint8Array([1]) }]);
    const instance = tabs.beginDocument(key);
    tabs.opened(key, name, name, instance);
    return { key, instance };
  };
  return { tabs, normal, frames };
}
const origin = parent => ({ parentTabKey: parent.key, parentDocumentInstance: parent.instance, sourceKind: "document", retrievalId: "inside" });
const reader = overrides => ({ open() {}, flush: async () => {}, ...overrides });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("ok  " + name); }

await check("reservation deduplicates origin immediately and commits without stealing focus", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  const child = tabs.reserveAttachment(o, "inside.pdf", { cancel() {} });
  assert.equal(child.created, true);
  assert.deepEqual(tabs.reserveAttachment(o, "inside.pdf", { cancel() {} }), { key: child.key, created: false });
  const statuses = [], opens = [];
  tabs.bind(child.key, reader({ open: source => opens.push(source), attachmentStatus: status => statuses.push(status.state) }));
  assert.deepEqual(statuses, ["queued"]);
  tabs.setAttachmentStatus(child.key, { state: "password", password: { incorrect: false, submit() {}, cancel() {} } });
  tabs.select(parent.key);
  const blob = new Blob([new Uint8Array([9, 8])]);
  assert.equal(tabs.commitAttachment(child.key, o, blob), true);
  assert.equal(tabs.active, parent.key);
  assert.equal(opens[0].blob, blob);
  assert.deepEqual(statuses, ["queued", "password", "ready"]);
  const distinct = tabs.reserveAttachment({ ...o, retrievalId: "other" }, "inside.pdf", { cancel() {} });
  assert.notEqual(distinct.key, child.key);
  assert.equal(tabs.commitAttachment(distinct.key, { ...o, retrievalId: "other" }, blob), true);
  assert.equal(tabs.all.filter(tab => tab.kind === "attachment").length, 2);
});

await check("parent close cancels only uncommitted children; snapshot survives and replays", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  let cancelled = 0;
  const pending = tabs.reserveAttachment(o, "pending.pdf", { cancel() { cancelled++; } });
  const committed = tabs.reserveAttachment({ ...o, retrievalId: "committed" }, "committed.pdf", { cancel() {} });
  const blob = new Blob(["snapshot"]);
  tabs.commitAttachment(committed.key, { ...o, retrievalId: "committed" }, blob);
  const token = tabs.readerDocumentLoaded(committed.key);
  await tabs.close(parent.key); await tick();
  assert.ok(cancelled > 0);
  assert.equal(tabs.all.some(tab => tab.key === pending.key), false);
  assert.equal(tabs.all.some(tab => tab.key === committed.key), true);
  assert.equal(tabs.canBackToParent(committed.key), false);
  tabs.readerDocumentUnloaded(committed.key, token);
  assert.ok(tabs.readerDocumentLoaded(committed.key));
  const replay = [];
  tabs.bind(committed.key, reader({ open: source => replay.push(source) }));
  assert.equal(replay[0].blob, blob);
  assert.equal(tabs.commitAttachment(pending.key, o, new Blob(["late"])), false);
});

await check("pending actual reload cancels, while stale binding refresh cannot unbind a newer reader", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  let cancelled = 0;
  const child = tabs.reserveAttachment(o, "inside.pdf", { cancel() { cancelled++; } });
  const token = tabs.readerDocumentLoaded(child.key);
  const oldUnbind = tabs.bind(child.key, reader({}));
  const states = [];
  tabs.bind(child.key, reader({ attachmentStatus: status => states.push(status.state) }));
  oldUnbind();
  tabs.setAttachmentStatus(child.key, { state: "extracting" });
  assert.deepEqual(states, ["queued", "extracting"]);
  tabs.readerDocumentUnloaded(child.key, token);
  await tick();
  assert.ok(cancelled > 0);
  assert.equal(tabs.all.some(tab => tab.key === child.key), false);
  assert.equal(tabs.commitAttachment(child.key, o, new Blob(["late"])), false);
});

await check("preflight failure keeps a usable parent and pending extraction", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  let cancelled = 0, disposed = 0;
  const child = tabs.reserveAttachment(o, "inside.pdf", { cancel() { cancelled++; } });
  tabs.bind(parent.key, reader({ flush: async () => { throw Error("flush"); }, dispose: async () => { disposed++; } }));
  const active = tabs.active;
  await tabs.close(parent.key);
  assert.equal(cancelled, 0); assert.equal(disposed, 0);
  assert.equal(tabs.active, active);
  assert.equal(tabs.canBackToParent(child.key), true);
  assert.equal(tabs.commitAttachment(child.key, o, new Blob(["valid"])), true);
  assert.equal(tabs.all.find(tab => tab.key === parent.key).closing, false);
});

await check("destructive cleanup failure still removes background tab without stealing focus", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  const child = tabs.reserveAttachment(o, "inside.pdf", { cancel() {} });
  tabs.bind(child.key, reader({ dispose: async () => { throw Error("destroy"); } }));
  tabs.select(parent.key);
  const focused = focus;
  await tabs.close(child.key);
  assert.equal(tabs.active, parent.key); assert.equal(focus, focused);
  assert.equal(tabs.all.some(tab => tab.key === child.key), false);
  assert.match(tabs.cleanupError, /resources/);
  let lateDisposed = 0;
  tabs.bind(child.key, reader({ dispose: async () => { lateDisposed++; } }));
  await tick(); assert.equal(lateDisposed, 1);
});

await check("Back addresses the exact parent instance; active close prefers its live parent", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf"), o = origin(parent);
  let focusedOrigin;
  tabs.bind(parent.key, reader({ focusAttachment: value => { focusedOrigin = value; } }));
  const child = tabs.reserveAttachment(o, "inside.pdf", { cancel() {} });
  tabs.commitAttachment(child.key, o, new Blob(["snapshot"]));
  normal("adjacent.pdf");
  tabs.select(child.key); tabs.backToParent(child.key);
  assert.equal(tabs.active, parent.key); assert.deepEqual(focusedOrigin, o);
  assert.equal(tabs.keyboardFocus, undefined, "tab layout effect must not steal focus from the origin row");
  tabs.select(child.key); await tabs.close(child.key);
  assert.equal(tabs.active, parent.key);
  const stale = tabs.reserveAttachment(o, "other.pdf", { cancel() {} });
  tabs.commitAttachment(stale.key, o, new Blob(["snapshot"]));
  tabs.beginDocument(parent.key);
  assert.equal(tabs.canBackToParent(stale.key), false);
  tabs.backToParent(stale.key); assert.equal(tabs.active, stale.key);
});

await check("normal content dedup remains separate from attachment identity", async () => {
  const { tabs, normal } = shell();
  const parent = normal("same.pdf"), o = origin(parent);
  const child = tabs.reserveAttachment(o, "same.pdf", { cancel() {} });
  tabs.commitAttachment(child.key, o, new Blob(["same"]));
  const duplicate = tabs.open([{ kind: "bytes", name: "another.pdf", data: new Uint8Array([1]) }]);
  const instance = tabs.beginDocument(duplicate);
  assert.equal(tabs.opened(duplicate, "same.pdf", "another.pdf", instance), false);
  await tick();
  assert.equal(tabs.all.some(tab => tab.key === child.key), true);
  assert.equal(tabs.all.some(tab => tab.key === duplicate), false);
});

await check("startup follows selection rank and confirmed membership, not completion order", async () => {
  const { tabs, normal } = shell();
  const a = normal("A"), b = normal("B");
  membership = [{ id: "A" }];
  recentListeners.forEach(fn => fn()); await tick();
  assert.equal(startup, "A");
  const child = tabs.reserveAttachment(origin(b), "inside.pdf", { cancel() {} });
  await tick(); assert.equal(startup, "A");
  const oldCheck = deferred(), newCheck = deferred();
  pendingMembership.push(oldCheck, newCheck);
  tabs.select(a.key); tabs.select(b.key);
  newCheck.resolve([{ id: "A" }, { id: "B" }]); await tick();
  assert.equal(startup, "B");
  oldCheck.resolve([{ id: "A" }]); await tick();
  assert.equal(startup, "B");
  membership = [{ id: "A" }, { id: "B" }];
  // A's later persistence cannot replace B's newer user selection.
  recentListeners.forEach(fn => fn()); await tick(); assert.equal(startup, "B");
  tabs.select(child.key); await tabs.close(b.key); await tick(); assert.equal(startup, "A");
  membership = []; recentListeners.forEach(fn => fn()); await tick(); assert.equal(startup, null);
});

await check("stale opened reports cannot restore a replaced or closed document", async () => {
  const { tabs, normal } = shell();
  const a = normal("A");
  membership = [{ id: "A" }]; recentListeners.forEach(fn => fn()); await tick();
  assert.equal(startup, "A");
  tabs.beginDocument(a.key);
  assert.equal(tabs.opened(a.key, "A", "A", a.instance), false);
  await tick(); assert.equal(startup, null);
  await tabs.close(a.key);
  assert.equal(tabs.opened(a.key, "A", "A", a.instance), false);
});

await check("protected or oversized normal remains ineligible even when old Recent bytes exist", async () => {
  const { tabs, normal } = shell();
  normal("A");
  const key = tabs.open([{ kind: "bytes", name: "protected", data: new Uint8Array([1]) }]);
  const instance = tabs.beginDocument(key);
  tabs.opened(key, "protected", "protected", instance, false);
  membership = [{ id: "A" }, { id: "protected" }];
  recentListeners.forEach(fn => fn()); await tick();
  assert.equal(startup, "A");
});

await check("close awaits disposal, then finalizes even when it rejects", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf");
  const child = tabs.reserveAttachment(origin(parent), "inside.pdf", { cancel() {} });
  const disposal = deferred();
  tabs.bind(child.key, reader({ dispose: () => disposal.promise }));
  const closing = tabs.close(child.key);
  await tick();
  assert.equal(tabs.all.find(tab => tab.key === child.key).disposing, true);
  disposal.reject(Error("destroy failed"));
  await closing;
  assert.equal(tabs.all.some(tab => tab.key === child.key), false);
  assert.equal(tabs.active, parent.key);
});

await check("iframe reload during rejected close preflight can mount a usable replacement reader", async () => {
  for (const kind of ["normal", "committed"]) {
    const { tabs, normal } = shell();
    const parent = normal("parent.pdf");
    let key = parent.key;
    let blob;
    if (kind === "committed") {
      key = tabs.reserveAttachment(origin(parent), "inside.pdf", { cancel() {} }).key;
      blob = new Blob(["snapshot"]);
      tabs.commitAttachment(key, origin(parent), blob);
    }
    const oldToken = tabs.readerDocumentLoaded(key);
    const preflight = deferred();
    tabs.bind(key, reader({ flush: () => preflight.promise }));
    const closing = tabs.close(key);
    tabs.readerDocumentUnloaded(key, oldToken);
    const newToken = tabs.readerDocumentLoaded(key);
    assert.ok(newToken);
    assert.equal(tabs.isReaderDocument(key, newToken), true);
    assert.equal(tabs.isReaderDocument(key, oldToken), false);
    let replacementDisposed = 0;
    const opens = [];
    tabs.bind(key, reader({ open: source => opens.push(source), dispose: async () => { replacementDisposed++; } }));
    preflight.reject(Error("flush rejected"));
    await closing;
    assert.equal(tabs.all.find(tab => tab.key === key).closing, false);
    assert.equal(replacementDisposed, 0);
    assert.equal(tabs.isReaderDocument(key, newToken), true);
    if (kind === "committed") assert.equal(opens[0].blob, blob);
  }
});

await check("pending attachment reload cancels even during a rejected close preflight", async () => {
  const { tabs, normal } = shell();
  const parent = normal("parent.pdf");
  let cancelled = 0;
  const key = tabs.reserveAttachment(origin(parent), "inside.pdf", { cancel() { cancelled++; } }).key;
  const token = tabs.readerDocumentLoaded(key);
  const preflight = deferred();
  tabs.bind(key, reader({ flush: () => preflight.promise }));
  const closing = tabs.close(key);
  tabs.readerDocumentUnloaded(key, token);
  assert.equal(tabs.readerDocumentLoaded(key), undefined);
  await tick();
  preflight.reject(Error("flush rejected"));
  await closing;
  assert.ok(cancelled > 0);
  assert.equal(tabs.all.some(tab => tab.key === key), false);
});

await check("whole-window reload preserves the confirmed normal startup choice", async () => {
  const { tabs, normal } = shell();
  const parent = normal("A");
  const token = tabs.readerDocumentLoaded(parent.key);
  membership = [{ id: "A" }]; recentListeners.forEach(fn => fn()); await tick();
  assert.equal(startup, "A");
  const stale = deferred(); pendingMembership.push(stale);
  tabs.select(parent.key);
  window.dispatchEvent(new Event("pagehide"));
  tabs.readerDocumentUnloaded(parent.key, token);
  stale.resolve([]); await tick();
  assert.equal(startup, "A");
});

await check("Recent mutations notify the top shell across reader frames even on failed writes", async () => {
  const source = await readFile(new URL("../src/recent.ts", import.meta.url), "utf8");
  const { code } = await transformWithOxc(source, "recent.ts");
  const recent = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const shared = new EventTarget();
  let notifications = 0;
  globalThis.window = { top: shared };
  const unsubscribe = recent.subscribeRecent(() => notifications++);
  // The mutation happens in another iframe realm/module consumer.
  globalThis.window = { top: shared };
  globalThis.indexedDB = { open() { throw Error("storage unavailable"); } };
  await recent.saveRecent({ id: "failed", data: new Blob([]) });
  await recent.removeRecent("failed");
  await recent.clearRecent();
  assert.equal(notifications, 3);
  unsubscribe();
  await recent.removeRecent("failed");
  assert.equal(notifications, 3);
});

console.log(`\n${passed} attachment tab regressions passed.`);
delete globalThis.__attachmentTabsTest;
