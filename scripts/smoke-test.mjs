// End-to-end smoke test, run in CI on Windows, macOS, and Linux (and locally with `npm run smoke`):
// launches the built app in Electron, opens the sample document, and checks that pages render, text is
// selectable and highlightable, text boxes survive reopening, and the window chrome matches the platform.
// Run `npm run build` first.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executablePath = require("electron"); // path to the Electron binary
const shots = path.join(root, "release", "smoke");
mkdirSync(shots, { recursive: true });

// The window stays hidden so a local run doesn't pop up over other work; FOLIO_SMOKE_SHOW=1 shows it.
const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-smoke-")),
  FOLIO_TEST_HIDDEN: process.env.FOLIO_SMOKE_SHOW === "1" ? "0" : "1" };
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

  // Opening another document (here from the file manager) asks first when there's unsaved work, a placed signature,
  // and keeps it if the reader says no.
  const photo = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 600, height: 200 });
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 600, 200);
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(40, 150);
    g.bezierCurveTo(150, 10, 250, 190, 350, 60);
    g.lineTo(560, 120);
    g.stroke();
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByTitle("Add a signature").click();
  await page.locator('input[aria-label="Upload signature photo"]').setInputFiles({ name: "signature.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
  await page.getByRole("button", { name: /Use this signature/ }).click();
  await page.locator('select[aria-label="Signature placement"]').selectOption("manual");
  await page.locator('[aria-label^="Place signature on page"]').click();
  await page.getByRole("button", { name: /Approve and add signature/ }).click();
  await page.locator(".dirty-dot").waitFor();
  const sample = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("sample.pdf")).arrayBuffer())));
  const openFromFileManager = () => app.evaluate(({ BrowserWindow }, data) =>
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name: "Another.pdf", data: Buffer.from(data) }), sample);
  let prompt = page.waitForEvent("dialog");
  await openFromFileManager();
  await (await prompt).dismiss();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".stampEditor").count(), 1);
  prompt = page.waitForEvent("dialog");
  await openFromFileManager();
  await (await prompt).accept();
  await page.waitForFunction(() => document.title.startsWith("Another.pdf"), null, { timeout: 15_000 });
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  console.log("ok  opening another document asks before discarding unsaved work");

  // Select a sentence and highlight it in one click.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll(".textLayer span:not(.markedContent)")].find((s) => s.textContent.includes("A short tour"));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();

  // Copy puts the selection on the system clipboard (whose contents are put back afterwards). Clipboard writes
  // need a focused window, which a CI desktop doesn't always give the app. Only CI runs it: on someone's own
  // computer it would briefly replace what they've copied (and anything but plain text wouldn't come back).
  if (!process.env.CI) {
    console.log("--  clipboard check skipped: it only runs in CI, to leave your clipboard alone");
  } else if (await page.evaluate(() => document.hasFocus())) {
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator(".selection-popover").getByRole("button", { name: "Copy" }).click();
    await page.locator('.selection-popover button[title="Copied"]').waitFor({ timeout: 5_000 });
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore);
    assert.ok(/A short tour of Folio/.test(copied), "Copy didn't reach the clipboard");
    console.log("ok  selection copied to the clipboard");
  } else {
    console.log("--  clipboard check skipped: the window isn't focused");
  }

  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 1, null, { timeout: 15_000 });
  console.log("ok  highlight created");

  // A saved copy includes every saved mark, also on pages that haven't been drawn since the document was reopened.
  const lastPage = await page.locator(".page").count();
  await page.evaluate((n) => document.querySelector(`.page[data-page-number="${n}"]`).scrollIntoView(), lastPage);
  await page.locator(`.page[data-page-number="${lastPage}"] .textLayer span:not(.markedContent)`).first().evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 2, null, { timeout: 15_000 });
  await page.evaluate(() => document.querySelector('.page[data-page-number="1"]').scrollIntoView());
  await page.waitForTimeout(800);
  await page.getByTitle("Back to library").click();
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  const copy = path.join(env.FOLIO_TEST_USER_DATA, "copy.pdf");
  await app.evaluate(({ session }, file) => {
    globalThis.folioCopySaved = new Promise((resolve) => session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(file);
      item.once("done", (_done, state) => resolve(state));
    }));
  }, copy);
  await page.keyboard.press("ControlOrMeta+s");
  assert.equal(await app.evaluate(() => globalThis.folioCopySaved), "completed");
  assert.equal(readFileSync(copy, "latin1").match(/\/Subtype\s*\/Highlight\b/g)?.length, 2);
  console.log("ok  saved copy includes marks on pages not drawn yet");

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

  // A text box is saved automatically and comes back, text and all, when the document is opened again.
  await page.locator('button[title^="Text ("]').click();
  // Clicked in the middle of the page's visible part: a fixed spot near the top lands under the toolbar's color
  // picker in a small window, as on CI runners.
  await page.locator('.page[data-page-number="1"] .annotationEditorLayer').click();
  // Filled in one go: pdf.js moves the caret while it focuses a new box, which can scramble key-by-key typing.
  await page.locator('.freeTextEditor .internal[contenteditable="true"]').fill("Saved text box");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByTitle("Back to library").click();
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".freeTextEditor", { hasText: "Saved text box" }).waitFor({ timeout: 15_000 });
  console.log("ok  text box restored after reopening");

  // Thumbnails keep each page's shape and relative size: letter portrait, letter landscape, and an 11x17 sheet.
  const mixed = pdfWithPageSizes([[612, 792], [792, 612], [1224, 792]]);
  await app.evaluate(({ BrowserWindow }, data) =>
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name: "Mixed sizes.pdf", data: Buffer.from(data) }), [...mixed]);
  await page.waitForFunction(() => document.title.startsWith("Mixed sizes.pdf"), null, { timeout: 15_000 });
  if (!(await page.locator(".sidebar").count())) await page.keyboard.press("ControlOrMeta+Backslash");
  await page.getByRole("tab", { name: "Pages" }).click();
  // Waits until the page sizes have loaded and the third thumbnail is wider than the first.
  await page.waitForFunction(() => {
    const f = [...document.querySelectorAll(".thumb-frame")];
    return f.length === 3 && f[2].getBoundingClientRect().width > f[0].getBoundingClientRect().width;
  }, null, { timeout: 15_000 });
  const frames = await page.locator(".thumb-frame").evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }));
  const near = (a, b) => Math.abs(a - b) <= 1;
  assert.ok(frames[0].height > frames[0].width, `letter portrait thumbnail isn't portrait: ${JSON.stringify(frames[0])}`);
  assert.ok(frames[1].width > frames[1].height, `letter landscape thumbnail isn't landscape: ${JSON.stringify(frames[1])}`);
  assert.ok(near(frames[0].width, frames[1].height) && near(frames[0].height, frames[1].width),
    `letter pages aren't the same size turned: ${JSON.stringify(frames)}`);
  // 11x17 landscape is 11in tall like portrait letter, and 17in wide against letter's 8.5in.
  assert.ok(near(frames[2].height, frames[0].height) && Math.abs(frames[2].width / frames[0].width - 2) < 0.05,
    `11x17 thumbnail isn't to scale with letter: ${JSON.stringify(frames)}`);
  console.log("ok  thumbnails keep each page's shape and size:", frames.map((f) => `${Math.round(f.width)}x${Math.round(f.height)}`).join(", "));

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `smoke-${process.platform}.png`) });
  assert.deepEqual(failures, []);
  console.log(`PASS (${process.platform})`);
} finally {
  await app.close();
}

// A blank PDF whose pages have the given [width, height] sizes in points.
function pdfWithPageSizes(sizes) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${sizes.map((_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${sizes.length} >>`,
    ...sizes.map(([w, h]) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] >>`),
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
