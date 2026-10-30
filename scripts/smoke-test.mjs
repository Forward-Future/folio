// End-to-end smoke test, run in CI on Windows, macOS, and Linux (and locally with `npm run smoke`):
// launches the built app in Electron, opens the sample document, and checks that pages render, text is
// selectable and highlightable, a scanned page can be recognized and saved with its text, and the window chrome
// matches the platform.
// Run `npm run build` first.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executablePath = require("electron"); // path to the Electron binary
const shots = path.join(root, "release", "smoke");
mkdirSync(shots, { recursive: true });

const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-smoke-")) };
delete env.ELECTRON_RUN_AS_NODE;
// Containers often run as root, where Chromium's sandbox can't start.
const args = [root, ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

const app = await electron.launch({ executablePath, args, env, timeout: 60_000 });
const failures = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => failures.push(String(e)));
  await page.getByRole("button", { name: /Try a sample/ }).waitFor({ timeout: 30_000 });

  const platformClass = await page.evaluate(() => [...document.documentElement.classList].find((c) => c.startsWith("platform-")));
  assert.equal(platformClass, `platform-${process.platform}`);
  console.log("ok  platform:", platformClass);

  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".textLayer").first().innerText(), /A short tour of Folio/);
  console.log("ok  sample rendered with a text layer");

  // Select a sentence and highlight it in one click.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll(".textLayer span:not(.markedContent)")].find((s) => s.textContent.includes("A short tour"));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 1, null, { timeout: 15_000 });
  console.log("ok  highlight created");

  // The More menu opens and closes.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /About Folio/ }).waitFor();
  await page.keyboard.press("Escape");

  // Settings links to the bundled changelog, and closing it returns to Settings.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await page.getByRole("button", { name: "View changelog" }).click();
  await page.getByRole("dialog", { name: "What's new" }).locator("h3").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.keyboard.press("Escape");
  console.log("ok  changelog opens from Settings");

  // A scanned page (an image, no text) is offered text recognition; once read, its words can be searched and selected.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press(process.platform === "darwin" ? "Meta+o" : "Control+o"),
  ]);
  await chooser.setFiles(path.join(root, "scripts", "fixtures", "scanned-sample.pdf"));
  await page.getByText("This looks like a scan").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".textLayer span:not(.markedContent)").count(), 0);
  await page.getByRole("button", { name: "Recognize text" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".textLayer span:not(.markedContent)").length > 60, null, { timeout: 180_000 });
  assert.match(await page.locator(".textLayer").first().innerText(), /Scanned\s+pages\s+become\s+searchable/);
  console.log("ok  scanned page recognized");

  // Saving a copy puts the recognized text into the file: reopened, it has the text at once and is not offered again.
  // The download is captured here rather than handed to the system's save dialog.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { window.__savedCopy = blob; return create(blob); };
    const click = HTMLElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (!this.hasAttribute("download")) click.call(this); };
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await page.getByText("Saved a copy with the recognized text").waitFor({ timeout: 60_000 });
  const copy = await page.evaluate(() => new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(window.__savedCopy);
  }));
  const copyPath = path.join(mkdtempSync(path.join(tmpdir(), "folio-copy-")), "scanned-copy.pdf");
  writeFileSync(copyPath, Buffer.from(copy, "base64"));
  const [copyChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press(process.platform === "darwin" ? "Meta+o" : "Control+o"),
  ]);
  await copyChooser.setFiles(copyPath);
  await page.waitForFunction(() => document.title.startsWith("scanned-copy.pdf"), null, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll(".textLayer span:not(.markedContent)").length > 60, null, { timeout: 30_000 });
  assert.match(await page.locator(".textLayer").first().innerText(), /Scanned\s+pages\s+become\s+searchable/);
  await page.waitForTimeout(2000); // a scan is looked for after the page is shown
  assert.equal(await page.getByText("This looks like a scan").count(), 0);
  console.log("ok  saved copy carries the recognized text");

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `smoke-${process.platform}.png`) });
  assert.deepEqual(failures, []);
  console.log(`PASS (${process.platform})`);
} finally {
  await app.close();
}
