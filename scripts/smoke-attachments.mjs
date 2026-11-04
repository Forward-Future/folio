import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { attachmentsPdf, childPdf, textAttachment, singleAttachmentPdf } from "./attachment-fixtures.mjs";

async function fixture(name, hash) {
  const response = await fetch(`https://raw.githubusercontent.com/mozilla/pdf.js/d0991a0d53f3bb3a7307e3b83f279c1d117aafb3/test/pdfs/${name}`);
  assert.ok(response.ok, `Upstream fixture ${name} is available`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  return bytes;
}

async function checkAttachmentPasswords(app, page, folder) {
  const embedded = await fixture("auth-event-ef-open.pdf", "144f617db7503a4d701d6383700add3254cb6a686741dd8f59b1284a82aca8ae");
  const open = (name, bytes) => app.evaluate(({ BrowserWindow }, { name, bytes }) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name, data: Buffer.from(bytes) }), { name, bytes: Array.from(bytes) });
  await open("Encrypted streams.pdf", embedded);
  await page.getByRole("tab", { name: "Files, attachments" }).click();
  await page.getByRole("button", { name: "Save attachment.pdf", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.locator(".attachment-reader").count(), 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.getByRole("button", { name: "Read PDF: attachment.pdf", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.locator('input[type="password"]').fill("wrong");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByText("That password wasn't correct. Try again.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.locator('input[type="password"]').fill("000000");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".attachment-reader canvas").first().waitFor();
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();

  const protectedChild = await fixture("pr6531_2.pdf", "e85d22b832a61be1d302a811e29c5df5ccd2a3795633178449d0b2e0e2451118");
  await open("Protected child parent.pdf", Buffer.from(singleAttachmentPdf("protected.pdf", protectedChild)));
  await page.getByRole("tab", { name: "Files, attachments" }).click();
  await page.getByRole("button", { name: "Read PDF: protected.pdf", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const saved = path.join(folder, "protected-original.pdf");
  await app.evaluate(({ session }, file) => {
    globalThis.protectedDownload = new Promise(resolve => session.defaultSession.once("will-download", (_, item) => {
      item.setSavePath(file); item.once("done", (_, state) => resolve(state));
    }));
  }, saved);
  await page.getByRole("button", { name: "Save original", exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.protectedDownload), "completed");
  assert.deepEqual(readFileSync(saved), protectedChild);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.locator('input[type="password"]').fill("wrong");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByText("That password wasn't correct. Try again.", { exact: true }).waitFor();
  await page.locator('input[type="password"]').fill("asdfasdf");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".attachment-reader canvas").first().waitFor();
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();
  console.log("ok  attachments: stream-auth cancel/retry and separate child-PDF password; locked original saves exactly");
}

export async function checkAttachments(app, page, folder) {
  const shots = path.resolve(import.meta.dirname, "../release/smoke");
  mkdirSync(shots, { recursive: true });
  console.log("attachments: opening parent");
  await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Attachments parent.pdf", data: Buffer.from(data) }), attachmentsPdf());
  await page.locator('.annotationLayer input[name="Parent name"]').waitFor();
  await page.locator('.annotationLayer input[name="Parent name"]').fill("Keep this form value");
  await page.keyboard.press("Tab");
  const formValue = await page.locator('.annotationLayer input[name="Parent name"]').inputValue();
  assert.ok(formValue.includes("Keep this form value"));
  // Pin the parent frame: readerPage deliberately follows the selected tab.
  const parentElement = await page.window.locator("iframe.document-reader.active").elementHandle();
  const parent = await parentElement.contentFrame();
  await parentElement.dispose();
  const files = page.getByRole("tab", { name: "Files, attachments" });
  if (!await files.isVisible()) await page.getByTitle(/Toggle sidebar/).click();
  await files.click();
  console.log("attachments: listing");
  const rows = page.locator(".attachment-item");
  await page.getByRole("button", { name: "Save late-page.txt", exact: true }).waitFor();
  assert.equal(await rows.count(), 5);
  await page.screenshot({ path: path.join(shots, `attachments-list-${process.platform}.png`) });
  // Page two was not selected; discovery is independent of page activation.

  const download = async (button, name, expected) => {
    const file = path.join(folder, name);
    await app.evaluate(({ session }, file) => {
      globalThis.attachmentDownload = new Promise(resolve => session.defaultSession.once("will-download", (_, item) => {
        item.setSavePath(file); item.once("done", (_, state) => resolve(state));
      }));
    }, file);
    await button.click();
    assert.equal(await app.evaluate(() => globalThis.attachmentDownload), "completed");
    assert.deepEqual(readFileSync(file), Buffer.from(expected));
  };
  await download(page.getByRole("button", { name: "Save notes.txt", exact: true }), "notes.txt", textAttachment);
  await parent.waitForFunction(() => !!localStorage.getItem("folio:active-content"));
  const startupBefore = await parent.evaluate(() => localStorage.getItem("folio:active-content"));
  console.log("attachments: reading child");
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  await page.locator(".attachment-reader .textLayer span").first().waitFor();
  assert.match(await page.locator(".attachment-reader .textLayer").innerText(), /Attached PDF content/);
  assert.equal(await page.locator('.annotationLayer input, .annotationLayer textarea, .annotationLayer select').count(), 0);
  assert.equal(await page.locator(".annotationEditorLayer [contenteditable=true], .annotationEditorLayer .freeTextEditor, .annotationEditorLayer .inkEditor").count(), 0);
  await page.locator(".fileAttachmentAnnotation").dblclick();
  await page.getByText("Save this file and open it normally to use its attachments or embedded media.").waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await parent.locator('.annotationLayer input[name="Parent name"]').inputValue(), formValue);
  assert.equal(await page.evaluate(() => localStorage.getItem("folio:active-content")), startupBefore);
  await download(page.getByRole("button", { name: "Save original", exact: true }), "child.pdf", childPdf);

  await page.getByRole("button", { name: "Back to parent", exact: true }).click();
  const countBefore = await page.getByRole("tablist", { name: "Open documents" }).getByRole("tab").count();
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  assert.equal(await page.getByRole("tablist", { name: "Open documents" }).getByRole("tab").count(), countBefore);
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();
  await page.getByRole("button", { name: "Try as PDF: report", exact: true }).click();
  await page.locator(".attachment-reader .textLayer span").first().waitFor();
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();
  await page.getByRole("button", { name: "Read PDF: invalid.pdf", exact: true }).click();
  await page.getByText("Couldn't read this file as a PDF.", { exact: false }).waitFor();
  await download(page.getByRole("button", { name: "Save original", exact: true }), "invalid.pdf", textAttachment);
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();

  // A committed snapshot remains independently readable when its parent is closed.
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  await page.locator(".attachment-reader .textLayer span").first().waitFor();
  page.window.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: /^Close Attachments parent.pdf/ }).click();
  await page.getByRole("button", { name: "Back to parent", exact: true }).waitFor({ state: "detached" });
  assert.match(await page.locator(".attachment-reader .textLayer").innerText(), /Attached PDF content/);
  await page.evaluate(() => location.reload());
  await page.locator(".attachment-reader .textLayer span").first().waitFor();
  await download(page.getByRole("button", { name: "Save original", exact: true }), "replayed.pdf", childPdf);
  await page.screenshot({ path: path.join(shots, `attachment-reader-${process.platform}.png`) });
  const dimensions = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 700));
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.waitForFunction(() => { const el = document.querySelector(".attachment-pdf-container"); return el && el.scrollWidth <= el.clientWidth + 2; });
  await page.screenshot({ path: path.join(shots, `attachment-reader-narrow-dark-${process.platform}.png`) });
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), dimensions);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.getByRole("button", { name: "Close attachment", exact: true }).click();
  console.log("ok  attachments: metadata, exact downloads, unnamed PDFs, parent preservation, independent replay");
  await checkAttachmentPasswords(app, page, folder);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { _electron: electron } = await import("playwright-core");
  const { createRequire } = await import("node:module");
  const { readerPage } = await import("./reader-page.mjs");
  const require = createRequire(import.meta.url);
  const folder = mkdtempSync(path.join(tmpdir(), "folio-attachments-"));
  const env = { ...process.env, FOLIO_TEST_USER_DATA: folder, FOLIO_TEST_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require("electron"), args: [path.resolve(import.meta.dirname, ".."), "--mute-audio"], env });
  try {
    const page = readerPage(await app.firstWindow());
    page.window.setDefaultTimeout(12_000);
    page.on("pageerror", error => console.error("Reader error:", error.message));
    page.window.on("console", message => { if (message.type() === "error") console.error("Console:", message.text()); });
    await page.getByRole("button", { name: /Try a sample/ }).waitFor();
    try { await checkAttachments(app, page, folder); } catch (error) {
      console.error(await page.locator("body").innerText());
      await page.screenshot({path: path.join(folder,"failure.png")});
      console.error("Smoke screenshot:",path.join(folder,"failure.png")); throw error;
    }
  } finally { await app.close(); }
}
