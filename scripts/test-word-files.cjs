const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const JSZip = require("jszip");
const { stageWord, readRegular, cachedPdf, rememberPdf } = require("../electron/document-files.cjs");
const { boundedParts } = require("../electron/docx-parts.cjs");
const { publish } = require("../electron/word-publish.cjs");
const { systemPowerShell } = require("../electron/windows-powershell.cjs");

async function folder(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "folio-word-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("only the exact source and PDF can reuse an export", async (t) => {
  const root = await folder(t);
  const word = path.join(root, "Report.docx"), ready = path.join(root, "ready.pdf");
  const data = Buffer.from("folio PDF");
  await fs.writeFile(word, "original");
  await fs.writeFile(ready, data, { mode: 0o600 });
  if (process.platform === "darwin") execFileSync("/bin/chmod", ["+a", "everyone allow read", ready]);
  const staged = await stageWord(word, path.join(root, "source.docx"));
  const unrelated = path.join(root, "Report.pdf");
  await fs.writeFile(unrelated, "different");
  assert.equal(await cachedPdf(root, staged), null);
  const cwd = process.cwd();
  let index;
  try { index = await publish({ location: staged.location, ready }); } finally { process.chdir(cwd); }
  assert.equal(index, 2);
  const output = path.join(root, "Report (2).pdf");
  assert.equal(await fs.readFile(unrelated, "utf8"), "different");
  assert.deepEqual(await fs.readFile(output), data);
  if (process.platform === "win32") {
    const acl = execFileSync(systemPowerShell(), ["-NoProfile", "-NonInteractive", "-Command",
      "$acl = [IO.File]::GetAccessControl($env:FOLIO_FILE); $id = [Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      "$acl.AreAccessRulesProtected -and ($acl.Access.Count -eq 1) -and ($acl.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -eq $id)"],
      { env: { ...process.env, FOLIO_FILE: output }, encoding: "utf8", windowsHide: true });
    assert.equal(acl.trim(), "True");
  } else {
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    if (process.platform === "darwin") assert.doesNotMatch(execFileSync("/bin/ls", ["-le", output], { encoding: "utf8" }), /allow read/);
  }
  await rememberPdf(root, staged, index, data);
  assert.deepEqual(await cachedPdf(root, staged), { name: "Report (2).pdf", data });
  await fs.writeFile(output, "other PDF");
  assert.equal(await cachedPdf(root, staged), null);
  await fs.truncate(output, 301 * 1024 ** 2);
  assert.equal(await cachedPdf(root, staged), null);
  await fs.writeFile(output, data);
  await fs.writeFile(word, "modified");
  assert.equal(await cachedPdf(root, await stageWord(word, path.join(root, "new.docx"))), null);
  await assert.rejects(stageWord(word, path.join(root, "large.docx"), 5), /size limit/);
  await assert.rejects(readRegular(ready, 5), /size limit/);
});

test("a symlink never authorizes a neighboring export, and files cannot redirect a cached read", async (t) => {
  const root = await folder(t);
  const privateDoc = path.join(root, "private.docx"), link = path.join(root, "shared.docx");
  await fs.writeFile(privateDoc, "private");
  try { await fs.symlink(privateDoc, link); }
  catch (error) { if (error.code === "EPERM" && process.platform === "win32") return t.skip("symlink privilege unavailable"); throw error; }
  const staged = await stageWord(link, path.join(root, "copy.docx"));
  assert.equal(staged.location, null);
  await assert.rejects(readRegular(link), /regular file/);
});

test("a PDF that grows after its descriptor is sized is rejected", async (t) => {
  const root = await folder(t);
  const file = path.join(root, "growing.pdf");
  await fs.writeFile(file, "1234");
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = async (...options) => {
      const before = await stat(...options);
      const writer = await open(file, "a");
      try { await writer.write("5"); } finally { await writer.close(); }
      return before;
    };
    return handle;
  });
  await assert.rejects(readRegular(file, 4), /changed/);
});

test("replacing the source directory before publication cancels the save", async (t) => {
  const root = await folder(t);
  const dir = path.join(root, "selected"), newDir = path.join(root, "replacement");
  await fs.mkdir(dir);
  await fs.mkdir(newDir);
  const word = path.join(dir, "source.docx");
  await fs.writeFile(word, "private");
  const staged = await stageWord(word, path.join(root, "copy.docx"));
  await fs.rename(dir, path.join(root, "original"));
  await fs.symlink(newDir, dir, process.platform === "win32" ? "junction" : "dir");
  const cwd = process.cwd();
  try { assert.equal(await publish({ location: staged.location, ready: word }), null); }
  finally { process.chdir(cwd); }
  assert.deepEqual(await fs.readdir(newDir), []);
});

test("cross-volume export requires an enforceable private file", { skip: process.platform === "win32" }, async (t) => {
  const root = await folder(t);
  const word = path.join(root, "input.docx"), ready = path.join(root, "ready.pdf");
  await fs.writeFile(word, "doc");
  const staged = await stageWord(word, path.join(root, "copy.docx"));
  await fs.writeFile(ready, "pdf", { mode: 0o600 });
  t.mock.method(fs, "link", async () => { throw Object.assign(new Error("different volume"), { code: "EXDEV" }); });
  const cwd = process.cwd();
  let index;
  try { index = await publish({ location: staged.location, ready }); } finally { process.chdir(cwd); }
  if (process.platform === "darwin") {
    assert.equal(index, null);
    await assert.rejects(fs.stat(path.join(root, "input.pdf")), { code: "ENOENT" });
  } else {
    assert.equal(index, 1);
    assert.equal((await fs.stat(path.join(root, "input.pdf"))).mode & 0o777, 0o600);
  }
});

test("a named pipe without a writer is rejected immediately", { skip: process.platform === "win32" }, async (t) => {
  const root = await folder(t);
  const pipe = path.join(root, "pipe.doc");
  execFileSync("mkfifo", [pipe]);
  execFileSync(process.execPath, ["-e", `
    const { stageWord } = require(process.argv[1]);
    stageWord(process.argv[2], process.argv[3]).then(() => process.exit(2), (error) => {
      if (!/regular file/.test(error.message)) process.exit(3);
    });
  `, require.resolve("../electron/document-files.cjs"), pipe, path.join(root, "copy.doc")], { timeout: 3000 });
});

test("a working-directory PowerShell namesake cannot run", { skip: process.platform !== "win32" }, async (t) => {
  const cwd = await folder(t);
  await fs.writeFile(path.join(cwd, "powershell.exe"), "not an executable");
  const file = systemPowerShell();
  const actual = execFileSync(file, ["-NoProfile", "-NonInteractive", "-Command", "[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName"],
    { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(actual.trim().toLowerCase(), file.toLowerCase());
});

test("actual part bytes, archive totals, repeated image reads and UTF-8 HTML are limited", async () => {
  const zip = new JSZip();
  zip.file("image", Buffer.alloc(40));
  zip.file("second", "0123456789");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const limits = { entries: 2, part: 40, total: 50, html: 60 };
  const parts = await boundedParts(bytes, limits);
  assert.equal(await parts.read("second", "utf8"), "0123456789");
  assert.equal((await parts.read("image", "base64")).length, 56);
  assert.throws(() => parts.checkHtml("é".repeat(31)), /conversion limits/);
  await assert.rejects(parts.read("image", "base64"), /conversion limits/);
  assert.throws(() => parts.checkHtml("short"), /conversion limits/);
  await assert.rejects(boundedParts(bytes, { ...limits, total: 49 }), /conversion limits/);
  await assert.rejects(boundedParts(bytes, { ...limits, entries: 1 }), /conversion limits/);
  const forged = Buffer.from(bytes);
  forged.writeUInt32LE(1, 22); // local header
  forged.writeUInt32LE(1, forged.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 24); // central header
  await assert.rejects(boundedParts(forged, { ...limits, part: 10 }), /conversion limits/);
});

test("directory records are counted before duplicate or aliased ZIP names can be merged", async () => {
  const zip = new JSZip();
  for (const name of ["a", "b", "c"]) zip.file(name, name);
  zip.comment = "a normal ZIP comment";
  const valid = await zip.generateAsync({ type: "nodebuffer", streamFiles: true });
  const limits = { entries: 3, part: 10, total: 30, html: 30 };
  assert.equal(await (await boundedParts(valid, limits)).read("b", "utf8"), "b");

  const duplicates = Buffer.from(valid);
  const end = duplicates.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  let offset = duplicates.readUInt32LE(end + 16);
  for (let i = 0; i < 3; i++) {
    const local = duplicates.readUInt32LE(offset + 42);
    duplicates[local + 30] = duplicates[offset + 46] = 97;
    offset += 46 + duplicates.readUInt16LE(offset + 28) + duplicates.readUInt16LE(offset + 30) + duplicates.readUInt16LE(offset + 32);
  }
  await assert.rejects(boundedParts(duplicates, limits), /ZIP directory/);
  duplicates.writeUInt16LE(1, end + 8);
  duplicates.writeUInt16LE(1, end + 10);
  await assert.rejects(boundedParts(duplicates, { ...limits, entries: 2 }), /conversion limits/);
  await assert.rejects(boundedParts(duplicates, limits), /ZIP directory/);

  const zip64 = Buffer.from(valid);
  zip64.writeUInt16LE(0xffff, end + 8);
  zip64.writeUInt16LE(0xffff, end + 10);
  await assert.rejects(boundedParts(zip64, limits), /ZIP directory/);
  const alias = new JSZip();
  alias.file("word/../a", "1", { createFolders: false });
  await assert.rejects(boundedParts(await alias.generateAsync({ type: "nodebuffer" }), limits), /ZIP directory/);
});
