import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { readerPage } from "./reader-page.mjs";
import { linkHistoryPdf } from "./smoke-reader-tools.mjs";

const root = path.resolve(import.meta.dirname, "..");
const server = await preview({ root, preview: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--enable-automation", "--mute-audio"] });
  const cdp = await browser.newBrowserCDPSession();
  assert.ok((await cdp.send("Browser.getBrowserCommandLine")).arguments.includes("--mute-audio"));
  const tab = await browser.newPage();
  const page = readerPage(tab);
  await tab.route("**/sample.pdf", route => route.fulfill({ contentType: "application/pdf", body: Buffer.from(linkHistoryPdf()) }));
  await tab.goto(server.resolvedUrls.local[0]);
  await page.getByRole("button", { name: /Try a sample/ }).click();
  assert.equal(await page.evaluate(() => !!window.folioDesktop), false);
  const link = page.locator('.page[data-page-number="1"] .annotationLayer a');
  await link.nth(3).click();
  await page.getByRole("button", { name: "Back to previous spot", exact: true }).click();
  await link.first().click();
  const pageNumber = page.getByLabel("Page number");
  await page.waitForFunction(() => document.querySelector('[aria-label="Page number"]').value === "2");
  assert.equal(await page.locator(".link-return").count(), 0);

  // Put Folio between real browser-history entries in both directions. Observe the event
  // after dispatch as well: headless Chromium doesn't implement every browser accelerator.
  await tab.evaluate(async () => {
    for (const where of ["before", "reader", "after"]) history.pushState(null, "", "?location=" + where);
    const moved = new Promise(resolve => addEventListener("popstate", resolve, { once: true }));
    history.back();
    await moved;
  });
  const url = tab.url();
  await page.evaluate(() => {
    window.observedArrows = [];
    window.addEventListener("keydown", event => {
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        setTimeout(() => window.observedArrows.push(event.defaultPrevented), 0);
      }
    }, true);
  });
  const mac = process.platform === "darwin";
  const press = async (key, shouldPrevent) => {
    const length = await page.evaluate(() => window.observedArrows.length);
    await tab.keyboard.press("Alt+" + key);
    await page.waitForFunction(n => window.observedArrows.length > n, length);
    assert.equal(await page.evaluate(() => window.observedArrows.at(-1)), shouldPrevent);
    assert.equal(tab.url(), url);
  };

  await page.getByRole("button", { name: /^Search \(/ }).click();
  const search = page.getByRole("textbox", { name: "Find in document" });
  await search.fill("low tide");
  await press("ArrowLeft", !mac);
  if (mac) assert.equal(await search.evaluate(el => el.selectionStart), 4);
  await press("ArrowRight", !mac);
  if (mac) assert.equal(await search.evaluate(el => el.selectionStart), 8);
  assert.equal(await pageNumber.inputValue(), "2");
  await search.press("Escape");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Keyboard shortcuts/ }).click();
  const modal = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await modal.getByRole("button", { name: "Close", exact: true }).focus();
  await press("ArrowLeft", !mac);
  await press("ArrowRight", !mac);
  assert.ok(await modal.isVisible());
  assert.equal(await pageNumber.inputValue(), "2");
  await tab.keyboard.press("Escape");
  await page.locator(".viewer-container").focus();
  await press("ArrowLeft", true);
  assert.equal(await pageNumber.inputValue(), "1");
  await press("ArrowRight", true);
  assert.equal(await pageNumber.inputValue(), "2");
  console.log("ok  Browser Edition keeps fields and dialogs in place and traverses only PDF history while reading");
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
