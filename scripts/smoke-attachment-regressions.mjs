// Focused hidden-window regressions for issues found during the independent attachment audit.
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readerPage } from "./reader-page.mjs";
import { attachmentsPdf, makePdf, singleAttachmentPdf } from "./attachment-fixtures.mjs";

const require = createRequire(import.meta.url);
const shots = path.resolve(import.meta.dirname, "../release/smoke");
mkdirSync(shots, { recursive: true });
async function run(check, pdf = attachmentsPdf()) {
  const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-attachment-audit-")), FOLIO_TEST_HIDDEN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: require("electron"), args: [path.resolve(import.meta.dirname, ".."), "--mute-audio"], env });
  try {
    const page = readerPage(await app.firstWindow());
    page.window.setDefaultTimeout(8_000);
    await page.getByRole("button", { name: /Try a sample/ }).waitFor();
    await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send(
      "folio:open-file", { name: "Audit parent.pdf", data: Buffer.from(data) }), pdf);
    await page.locator(".page canvas").first().waitFor();
    await check(app, page);
  } finally { await app.close(); }
}

async function checkCloseErrors(_app, page) {
  await page.locator(".viewer-container").focus();
  const rejectFlush = () => page.evaluate(async () => {
    const { tabs, key } = window.frameElement.readerContext;
    const reader = tabs.all.find(tab => tab.key === key).reader;
    const flush = reader.flush;
    reader.flush = async () => { throw new Error("Injected flush failure"); };
    try { await tabs.close(key); } finally { reader.flush = flush; }
  });
  await rejectFlush();
  await page.getByRole("status").filter({ hasText: "Couldn't finish saving your notes." }).waitFor();
  assert.equal(await page.locator(".document-tabs").count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains("viewer-container")), true);
  await page.getByRole("button", { name: "Dismiss tab status" }).click();

  await page.locator(".viewer-container").focus();
  // Exercise focus-mode UI without moving the hidden test window into native fullscreen.
  await page.evaluate(() => { document.documentElement.requestFullscreen = async () => {}; });
  await page.keyboard.press("f");
  await page.locator(".app[data-focus]").waitFor();
  await rejectFlush();
  await page.getByRole("status").filter({ hasText: "Couldn't finish saving your notes." }).waitFor();
  await page.getByRole("button", { name: "Dismiss tab status" }).click();
  await page.getByTitle("Exit focus mode").click();

  await page.getByRole("tab", { name: "Files, attachments" }).click();
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  await page.locator(".attachment-reader .textLayer span").first().waitFor();
  await page.evaluate(() => {
    const { tabs, key } = window.frameElement.readerContext;
    const reader = tabs.all.find(tab => tab.key === key).reader;
    const dispose = reader.dispose;
    reader.dispose = async () => { await dispose(); throw new Error("Injected teardown failure"); };
    void tabs.close(key);
  });
  await page.getByRole("status").filter({ hasText: "some reader resources couldn't be released" }).waitFor();
  assert.equal(await page.locator(".document-tabs").count(), 0);
  assert.equal(await page.locator(".attachment-reader").count(), 0);
  await page.screenshot({ path: path.join(shots, `attachment-close-error-${process.platform}.png`) });
  await page.getByRole("button", { name: "Dismiss tab status" }).click();
  console.log("ok  preflight and disposal failures stay visible with one tab and in focus mode");
}

async function checkPreferences(app, page) {
  const handle = await page.window.locator("iframe.document-reader.active").elementHandle();
  const parent = await handle.contentFrame();
  await handle.dispose();
  const change = (theme, night) => parent.evaluate(({ theme, night }) => {
    localStorage.setItem("folio:theme", theme);
    localStorage.setItem("folio:night", night ? "1" : "0");
  }, { theme, night });
  await change("dark", true);
  await page.getByRole("tab", { name: "Files, attachments" }).click();
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  await page.locator(".folio-image-overlay").waitFor({ state: "attached" });
  const matches = async (theme, night) => {
    await page.waitForFunction(({ theme, night }) => document.documentElement.dataset.theme === theme &&
      !!document.querySelector(".attachment-reader[data-night]") === night, { theme, night });
    const filter = await page.locator(".canvasWrapper canvas").first().evaluate(el => getComputedStyle(el).filter);
    assert.equal(filter.includes("invert"), night);
    const overlay = await page.locator(".folio-image-overlay").evaluate(el => ({filter: getComputedStyle(el).filter, visible: getComputedStyle(el).display !== "none"}));
    assert.equal(overlay.filter, "none");
    if (night) assert.equal(overlay.visible, true);
    const expectedColor = theme === "dark" ? "171717" : "f5f4f1";
    const deadline = Date.now() + 3000;
    let native;
    do {
      native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
      if (native.toLowerCase().endsWith(expectedColor)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.ok(native.toLowerCase().endsWith(expectedColor), `Native background ${native} should match ${theme}`);
  };
  await matches("dark", true);
  await page.screenshot({ path: path.join(shots, `attachment-night-${process.platform}.png`) });
  await change("light", false);
  await matches("light", false);
  await page.getByRole("button", { name: "Back to parent", exact: true }).click();
  await change("dark", true);
  await page.getByRole("button", { name: "Read PDF: child.pdf", exact: true }).click();
  await matches("dark", true);
  await parent.evaluate(() => { localStorage.removeItem("folio:theme"); localStorage.removeItem("folio:night"); });
  await matches("dark", false);
  await change("light", true);
  await matches("light", true);
  await parent.evaluate(() => localStorage.clear());
  await matches("dark", false);
  console.log("ok  retained attachment readers follow global theme, PDF dark mode, image colors, and native theme");
}

const selected = process.argv[2];
if (!selected || selected === "errors") await run(checkCloseErrors);
if (!selected || selected === "preferences") {
  const draw = "q 80 0 0 80 30 150 cm /Im Do Q";
  const imagePdf = makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream",
  ]);
  await run(checkPreferences, singleAttachmentPdf("child.pdf", Buffer.from(imagePdf)));
}
