import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

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
  await list.getByRole("button", { name: `Save ${script}`, exact: true }).click();
  assert.equal(await question.locator(".save-program-name").textContent(), script);
  await question.screenshot({ path: path.join(shots, "attachments-program.png") });
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
    assert.deepEqual(await app.evaluate(() => globalThis.folioAttachmentSaved), { state: "completed", suggested: name });
    assert.ok(Buffer.from(expected).equals(readFileSync(file)), `${name} was not saved byte for byte`);
  }
  await close("Report.pdf");
  console.log("ok  Files lists a PDF's attached files and saves each one byte for byte, asking first for one that could run; a PDF without any has no Files tab");
}
