import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

// Every byte value, so a file that was decoded as text or cut short on its way to disk would differ.
const figures = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) % 256);
const notes = new TextEncoder().encode("Quarterly figures — see the spreadsheet.\n");

export async function attachmentsPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([420, 300]).drawText("Report with attached files", { x: 32, y: 240, size: 20, font });
  await pdf.attach(figures, "figures.bin", { description: "Raw figures" });
  await pdf.attach(notes, "notes.txt");
  // No extension: the name offered when saving must not gain one guessed from the contents.
  await pdf.attach(notes, "README");
  // A script: Folio shows its full name and asks before saving it.
  await pdf.attach(notes, "Quarterly report.pdf.bat");
  return pdf.save();
}

/** A PDF to mark up, with one file Folio saves and one, packed twice over, that it has to refuse. */
async function refusingPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 300]);
  page.drawText("Before", { x: 32, y: 240, size: 20, font });
  page.drawText("After", { x: 32, y: 180, size: 20, font });
  await pdf.attach(notes, "notes.txt");
  // (pdf-lib writes an attachment into the document only when asked to, or on saving.)
  await pdf.flush();
  const files = pdf.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  const twice = pdf.context.register(pdf.context.stream(deflateSync(deflateSync(notes)), { Type: "EmbeddedFile", Filter: ["FlateDecode", "FlateDecode"] }));
  files.push(PDFString.of("twice.bin"));
  files.push(pdf.context.obj({ Type: "Filespec", F: PDFString.of("twice.bin"), EF: { F: twice } }));
  return pdf.save();
}

export async function checkAttachments(app, page, folder, shots) {
  const open = (name, bytes) => app.evaluate(({ BrowserWindow }, { name, bytes }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name, data: Buffer.from(bytes) }),
    { name, bytes: Array.from(bytes) });
  // Each document is closed while it is the selected one, so this works with or without a tab bar.
  const close = async name => {
    await page.keyboard.press("ControlOrMeta+w");
    await page.window.waitForFunction(name => !document.title.startsWith(name), name);
  };
  const toggle = page.getByRole("button", { name: /Toggle sidebar/ });
  const filesTab = page.getByRole("tab", { name: /^Files/ });

  const plain = await PDFDocument.create();
  plain.addPage([420, 300]);
  await open("No files.pdf", await plain.save());
  await page.window.waitForFunction(() => document.title.startsWith("No files.pdf"));
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.getByRole("tab", { name: "Pages", exact: true }).waitFor();
  // The attachment list is asked for before the thumbnail, so once the page is drawn the answer is in.
  await page.waitForFunction(() => document.querySelector("aside.sidebar .thumb canvas")?.style.opacity === "1");
  assert.equal(await filesTab.count(), 0, "a PDF without attachments got a Files tab");
  await close("No files.pdf");

  await open("Report.pdf", await attachmentsPdf());
  await page.window.waitForFunction(() => document.title.startsWith("Report.pdf"));
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const sidebar = page.locator("aside.sidebar");
  await filesTab.waitFor();
  await sidebar.screenshot({ path: path.join(shots, "attachments-tab.png") });
  await filesTab.click();
  const list = sidebar.getByRole("list", { name: "Attached files" });
  assert.deepEqual(await list.locator(".attachment-name").allTextContents(), ["figures.bin", "notes.txt", "README", "Quarterly report.pdf.bat"]);
  assert.deepEqual(await list.locator(".attachment-description").allTextContents(), ["Raw figures"]);
  await sidebar.screenshot({ path: path.join(shots, "attachments-list.png") });

  const script = "Quarterly report.pdf.bat";
  const question = page.getByRole("dialog", { name: "Save this attached file?" });
  // A save that never starts would otherwise leave the run waiting for good.
  const within = (promise, what) => Promise.race([promise, new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`${what} didn't happen within 30 seconds`)), 30_000))]);
  await app.evaluate(({ session }) => {
    globalThis.folioAttachmentStray = 0;
    globalThis.folioAttachmentCount = () => { globalThis.folioAttachmentStray++; };
    session.defaultSession.on("will-download", globalThis.folioAttachmentCount);
  });
  await list.getByRole("button", { name: `Save ${script}`, exact: true }).click();
  assert.equal(await question.locator(".save-program-name").textContent(), script);
  await question.screenshot({ path: path.join(shots, "attachments-program.png") });
  // The question owns the keyboard: Cancel is what Enter would press, and the reader's shortcuts don't reach the page behind.
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Cancel");
  const shape = () => page.locator('.page[data-page-number="1"]').evaluate(sheet => sheet.offsetWidth > sheet.offsetHeight);
  assert.equal(await shape(), true);
  await page.keyboard.press("r");
  await page.keyboard.press("ControlOrMeta+s");
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await shape(), true, "R turned the page behind the question about saving a file");
  await question.getByRole("button", { name: "Cancel" }).click();
  await question.waitFor({ state: "detached" });

  for (const [name, expected] of [["figures.bin", figures], ["notes.txt", notes], ["README", notes], [script, notes]]) {
    const file = path.join(folder, `saved-${name}`);
    await app.evaluate(({ session }, file) => {
      globalThis.folioAttachmentSaved = new Promise(resolve => session.defaultSession.once("will-download", (_event, item) => {
        const suggested = item.getFilename();
        item.setSavePath(file);
        item.once("done", (_done, state) => resolve({ state, suggested }));
      }));
    }, file);
    await list.getByRole("button", { name: `Save ${name}`, exact: true }).click();
    if (name === script) await question.getByRole("button", { name: "Save", exact: true }).click();
    assert.deepEqual(await within(app.evaluate(() => globalThis.folioAttachmentSaved), `saving ${name}`), { state: "completed", suggested: name });
    assert.ok(Buffer.from(expected).equals(readFileSync(file)), `${name} was not saved byte for byte`);
  }
  // Only one file is read at a time, so a save that Cancel (or Ctrl+S behind the question) let through would have
  // come out among these four, or held them up.
  assert.equal(await app.evaluate(({ session }) => {
    session.defaultSession.off("will-download", globalThis.folioAttachmentCount);
    return globalThis.folioAttachmentStray;
  }), 4, "something was saved besides the four files asked for");
  await close("Report.pdf");

  // A file Folio can't save is refused, and the document, with the marks made before and after, carries on.
  await open("Marked.pdf", await refusingPdf());
  await page.window.waitForFunction(() => document.title.startsWith("Marked.pdf"));
  const sheet = page.locator('.page[data-page-number="1"]');
  const highlight = async (word, count) => {
    const line = sheet.locator(".textLayer").getByText(word, { exact: true }).first();
    await line.waitFor();
    await page.getByRole("button", { name: "Highlight", exact: true }).click();
    await page.keyboard.down("Shift");
    await line.evaluate(span => getSelection().setBaseAndExtent(span.firstChild, 0, span.firstChild, span.firstChild.length));
    await page.waitForFunction(word => getSelection().toString() === word, word);
    await page.keyboard.up("Shift");
    await page.waitForFunction(count => document.querySelectorAll('.page[data-page-number="1"] .highlightEditor').length === count, count);
    await page.getByRole("button", { name: "Done", exact: true }).click();
  };
  await highlight("Before", 1);
  await filesTab.click();
  await list.getByRole("button", { name: "Save twice.bin", exact: true }).click();
  await page.locator(".toast", { hasText: "This attachment is stored in a way Folio can't save." }).waitFor();
  await highlight("After", 2);
  const kept = path.join(folder, "saved-after-refusal.txt"), marked = path.join(folder, "marked.pdf");
  const download = file => app.evaluate(({ session }, file) => {
    globalThis.folioAttachmentSaved = new Promise(resolve => session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(file);
      item.once("done", (_done, state) => resolve(state));
    }));
  }, file);
  await download(kept);
  await list.getByRole("button", { name: "Save notes.txt", exact: true }).click();
  assert.equal(await within(app.evaluate(() => globalThis.folioAttachmentSaved), "saving notes.txt after a refusal"), "completed");
  assert.ok(Buffer.from(notes).equals(readFileSync(kept)), "notes.txt was not saved byte for byte after another file was refused");
  await download(marked);
  await page.keyboard.press("ControlOrMeta+s");
  assert.equal(await within(app.evaluate(() => globalThis.folioAttachmentSaved), "saving the marked PDF"), "completed");
  const copy = await PDFDocument.load(readFileSync(marked));
  const marks = copy.getPage(0).node.Annots()?.asArray().map(mark => copy.context.lookup(mark, PDFDict).get(PDFName.of("Subtype")).toString());
  assert.deepEqual(marks, ["/Highlight", "/Highlight"], "the marks made before and after the refused save weren't both in the saved PDF");
  await close("Marked.pdf");
  console.log("ok  Files lists a PDF's attached files and saves each one byte for byte, asking first for one that could run; a refused file leaves the document and its marks as they were; a PDF without any has no Files tab");
}
