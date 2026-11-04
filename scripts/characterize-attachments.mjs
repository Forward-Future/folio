// Manual runtime spike: optional local fixture path; otherwise fetch the exact upstream fixture.
// This is separate from the offline regression suite and uses no user documents or credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { getDocument, version } from "pdfjs-dist/legacy/build/pdf.mjs";

const commit = "d0991a0d53f3bb3a7307e3b83f279c1d117aafb3";
const url = `https://raw.githubusercontent.com/mozilla/pdf.js/${commit}/test/pdfs/auth-event-ef-open.pdf`;
const hash = data => createHash("sha256").update(data).digest("hex");
const bytes = process.argv[2] ? new Uint8Array(await readFile(process.argv[2])) : await (async () => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fixture download returned ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
})();
assert.equal(version, "6.4.299");
assert.equal(hash(bytes), "144f617db7503a4d701d6383700add3254cb6a686741dd8f59b1284a82aca8ae");
const compiled = stripTypeScriptTypes(await readFile(new URL("../src/attachments.ts", import.meta.url), "utf8"));
const { AttachmentBroker } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const evidence = { pdfjs: version, fixture: url, fixtureBytes: bytes.byteLength, fixtureSha256: hash(bytes) };
const withPdf = async test => {
  const task = getDocument({ data: bytes.slice(), enableXfa: false });
  try { await test(await task.promise, task); }
  finally { await task.destroy(); }
};
await withPdf(async (pdf, task) => {
  const metadata = await pdf.getAttachments();
  assert.equal(metadata.get("attachment.pdf").content, undefined);
  const reasons = [];
  task.onPassword = (answer, reason) => { reasons.push(reason); answer(reason === 1 ? "wrong-password" : "000000"); };
  const content = await pdf.getAttachmentContent("attachment.pdf");
  assert.deepEqual(reasons, [1, 2]);
  assert.equal(content.byteLength, 760);
  evidence.lazyMetadata = [...metadata];
  evidence.retry = { reasons, contentBytes: content.byteLength, contentSha256: hash(content) };
});
await withPdf(async (pdf, task) => {
  const reasons = [];
  task.onPassword = (answer, reason) => { reasons.push(reason); answer(new Error("Characterization cancellation")); };
  await assert.rejects(pdf.getAttachmentContent("attachment.pdf"), /Characterization cancellation/);
  task.onPassword = answer => answer("000000");
  const content = await pdf.getAttachmentContent("attachment.pdf");
  assert.equal(content.byteLength, 760);
  evidence.errorCancellation = { reasons, rejected: true, retryOnSameParentBytes: content.byteLength };
});
await withPdf(async (pdf, task) => {
  const events = [];
  const broker = new AttachmentBroker(pdf, { onPassword: challenge => {
    if (!challenge) return;
    events.push({ owner: challenge.owner, intent: challenge.intent, reason: challenge.reason });
    if (challenge.owner === "child") {
      if (challenge.reason === 1) challenge.submit("wrong-password");
      else challenge.cancel();
    } else challenge.submit("000000");
  } });
  try {
    const read = broker.enqueue({ retrievalId: "attachment.pdf", intent: "read", owner: "child" });
    const save = broker.enqueue({ retrievalId: "attachment.pdf", intent: "save", owner: "parent" });
    await assert.rejects(read.promise, error => error.name === "AbortError");
    assert.equal((await save.promise).byteLength, 760);
    assert.deepEqual(events, [
      { owner: "child", intent: "read", reason: 1 },
      { owner: "child", intent: "read", reason: 2 },
      { owner: "parent", intent: "save", reason: 1 },
    ]);
    evidence.broker = { events, readCancelled: true, queuedSaveSucceeded: true };
  } finally { broker.dispose(); }
});
console.log(JSON.stringify(evidence, null, 2));
