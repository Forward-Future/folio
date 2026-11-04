import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { transformWithOxc } from "vite";

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const brokerUrl = moduleUrl(stripTypeScriptTypes(await readFile(new URL("../src/attachments.ts", import.meta.url), "utf8")));
const sessionSource = (await readFile(new URL("../src/attachmentSession.ts", import.meta.url), "utf8"))
  .replace(/import \{[\s\S]*?\} from "\.\/attachments";/, `import { AttachmentBroker, discoverAttachments } from "${brokerUrl}";`)
  .replace('import { saveBlob } from "./download";', "export const downloads = []; const saveBlob = (blob, name) => downloads.push({ blob, name });");
const sessionCompiled = (await transformWithOxc(sessionSource, "attachmentSession.ts")).code;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
let moduleId = 0;
const fixture = async getContent => {
  const { AttachmentSession, downloads } = await import(`${moduleUrl(sessionCompiled)}#${++moduleId}`);
  let instance = 1, nextChild = 7;
  const commits = [], statuses = [], children = new Map();
  const tabs = {
    currentDocumentInstance: () => instance,
    setAttachmentPasswordPending() {},
    reserveAttachment(origin, name, actions) {
      const key = nextChild++;
      children.set(key, { origin, name, actions });
      return { key, created: true };
    },
    commitAttachment: (key, origin, blob) => { commits.push({ key, origin, blob }); return true; },
    setAttachmentStatus: (key, status) => statuses.push({ key, status }),
  };
  const pdf = { loadingTask: { onPassword: null }, getAttachmentContent: getContent };
  const session = new AttachmentSession(pdf, tabs, 1, 1);
  return { session, pdf, tabs, downloads, commits, statuses, children, replace: () => { instance++; } };
};
const item = { key: "document:file", sourceKind: "document", retrievalId: "file", filename: "file.pdf", description: "", pageNumbers: [] };

test("page-content discards bytes when parent changes before original consumer delivery", async () => {
  const gate = deferred(); const f = await fixture(() => gate.promise);
  const result = f.session.pageContent("media-or-file");
  gate.resolve(new Uint8Array([1, 2, 3]));
  // The broker settles first; the session must still check ownership at its delivery boundary.
  await Promise.resolve(); f.replace();
  assert.equal(await result, null);
  f.session.dispose();
});

test("page-content settles null on parent disposal even when decode never finishes", async () => {
  const gate = deferred(); const f = await fixture(() => gate.promise);
  const active = f.session.pageContent("active"), queued = f.session.pageContent("queued");
  f.session.dispose();
  assert.equal(await active, null); assert.equal(await queued, null);
  gate.resolve(new Uint8Array([1])); await turn();
});

test("Save and Read never save or commit stale parent bytes", async () => {
  for (const intent of ["save", "read"]) {
    const gate = deferred(); const f = await fixture(() => gate.promise);
    f.session[intent](item);
    gate.resolve(new Uint8Array([1, 2, 3]));
    await Promise.resolve(); f.replace();
    await turn();
    assert.equal(f.downloads.length, 0); assert.equal(f.commits.length, 0);
    f.session.dispose();
  }
});

test("Read extraction password belongs to its child and retry preserves that owner", async () => {
  const gates = [deferred(), deferred()]; let next = 0;
  const f = await fixture(() => gates[next++].promise);
  f.session.read(item);
  const child = [...f.children.keys()][0];
  const answers = [];
  f.pdf.loadingTask.onPassword(value => answers.push(value), 1);
  const firstPrompt = f.statuses.at(-1);
  assert.equal(firstPrompt.key, child); assert.equal(firstPrompt.status.state, "password");
  assert.equal(f.session.getSnapshot().password, null);
  firstPrompt.status.password.cancel();
  gates[0].reject(answers[0]); await turn();
  f.children.get(child).actions.retry();
  f.pdf.loadingTask.onPassword(value => answers.push(value), 2);
  const retryPrompt = f.statuses.at(-1);
  assert.equal(retryPrompt.key, child); assert.equal(retryPrompt.status.password.incorrect, true);
  firstPrompt.status.password.submit("stale"); assert.equal(answers.length, 1);
  retryPrompt.status.password.submit("correct");
  gates[1].resolve(new Uint8Array([1])); await turn();
  assert.deepEqual(answers.slice(1), ["correct"]);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].key, child);
  f.session.dispose();
});

test("Save and page-content prompts remain parent-owned without depending on the Files panel", async () => {
  for (const intent of ["save", "page-content"]) {
    const gate = deferred(); const f = await fixture(() => gate.promise);
    const result = intent === "save" ? (f.session.save(item), null) : f.session.pageContent("unknown-id");
    const answers = [];
    f.pdf.loadingTask.onPassword(value => answers.push(value), 1);
    const challenge = f.session.getSnapshot().password;
    assert.equal(challenge.owner, "parent"); assert.equal(challenge.intent, intent);
    assert.equal(f.children.size, 0);
    challenge.submit("correct"); gate.resolve(new Uint8Array([1]));
    if (result) assert.deepEqual(await result, new Uint8Array([1]));
    await turn();
    assert.equal(f.downloads.length, intent === "save" ? 1 : 0);
    f.session.dispose();
  }
});
