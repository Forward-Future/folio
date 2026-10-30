// End-to-end smoke test, run in CI on Windows, macOS, and Linux (and locally with `npm run smoke`):
// launches the built app in Electron, opens the sample document, and checks that pages render, text is
// selectable and highlightable, and the window chrome matches the platform. Run `npm run build` first.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync } from "node:fs";
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

  // A saved text box must survive leaving the document and opening the same file again.
  await openFixture(page);
  await addTextBox(page, "SMOKE TEXT BOX");
  await page.getByTitle("Back to library").click();
  await page.locator(".recent-card").first().waitFor({ timeout: 20_000 });
  await page.locator(".recent-card").filter({ hasText: "smoke-regression" }).click();
  await page.waitForFunction(() => document.querySelector(".doc-title")?.textContent?.includes("smoke-regression"), null, { timeout: 30_000 });
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".freeTextEditor .internal")].some((el) => (el.innerText || "").replace(/\s+/g, " ").includes("SMOKE TEXT BOX")),
    null,
    { timeout: 20_000 },
  );
  assert.notEqual(await page.locator(".freeTextEditor").first().boundingBox(), null);
  console.log("ok  text box restored when the PDF was reopened");

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `smoke-${process.platform}.png`) });
  assert.deepEqual(failures, []);
  console.log(`PASS (${process.platform})`);
} finally {
  await app.close();
}

// ── Fixtures for the check above ──────────────────────────────────────
// A small, unencrypted PDF with selectable text, so the text-box check needs no fixture file.
function regressionPdf() {
  const pages = [
    ["Smoke regression sheet", "ALPHA ORBIT 42 is the launch code."],
    ["Second page", "BETA HARBOR 73 is the recovery code."],
    ["Third page", "GAMMA MEADOW 95 is the archive code."],
  ];
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Count 3 /Kids [4 0 R 6 0 R 8 0 R] >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  pages.forEach((lines, i) => {
    const stream = "BT /F1 18 Tf 72 720 Td " + lines.map((line) => `(${line}) Tj`).join(" 0 -36 Td ") + " ET";
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  });
  let pdf = Buffer.from("%PDF-1.7\n", "latin1");
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n`, "latin1"), object, Buffer.from("\nendobj\n", "latin1")]);
  });
  const startxref = pdf.length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) tail += `${String(offset).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.concat([pdf, Buffer.from(tail, "latin1")]);
}

/** Opens the fixture through the same channel the operating system uses, then waits for it. */
async function openFixture(page) {
  const bytes = Array.from(regressionPdf());
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name: "smoke-regression.pdf", data: Buffer.from(data) });
  }, bytes);
  await page.waitForFunction(() => document.querySelector(".doc-title")?.textContent?.includes("smoke-regression"), null, { timeout: 30_000 });
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
}

/** Places a text box on the visible part of page one, commits it, and waits for the automatic save. */
async function addTextBox(page, text) {
  await page.getByRole("button", { name: "Text", exact: true }).click();
  const box = await page.locator(".page").first().boundingBox();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  // Stay well inside the page (below its text) and above the page-number bar.
  const y = box.y + Math.min(box.height * 0.6, viewportHeight - box.y - 160);
  await page.mouse.click(box.x + box.width * 0.3, y);
  await page.locator(".freeTextEditor").waitFor({ timeout: 15_000 });
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  assert.match(await page.locator(".freeTextEditor .internal").first().innerText(), new RegExp(text));
  console.log("ok  text box created");
}
