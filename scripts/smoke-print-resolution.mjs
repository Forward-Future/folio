import { _electron as electron } from "playwright-core";
import { createServer } from "vite";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { readerPage } from "./reader-page.mjs";
const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 } });
await server.listen();
const env = { ...process.env, FOLIO_DEV_URL: server.resolvedUrls.local[0], FOLIO_TEST_HIDDEN: "1", FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-resolution-")) };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)("electron"), args: [root, "--mute-audio"], env, timeout: 60000 });
  assert.ok(await app.evaluate(({ app }) => app.commandLine.hasSwitch("mute-audio")));
  const page = readerPage(await app.firstWindow());
  await page.getByRole("button", { name: /Try a sample/ }).waitFor({ timeout: 30000 });
  const results = await page.evaluate(async () => {
    const { loadPdf } = await import("/src/pdf.ts");
    const { renderPrintSheet, encodePrintSheet } = await import("/src/printRender.ts");
    const { DEFAULT_PRINT, planSheets } = await import("/src/printLayout.ts");
    const bytes = new Uint8Array(await (await fetch("/sample.pdf")).arrayBuffer());
    const controller = new AbortController();
    const pdf = await loadPdf(bytes, controller.signal);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const settings = { ...DEFAULT_PRINT, mode: "poster", scale: 150, overlapPoints: .24 * 72 };
    const sheets = planSheets([1], [{ width: 612, height: 792 }], settings);
    const calls = [];
    const observed = { getPage: async n => {
      const original = await pdf.getPage(n);
      return { getViewport: options => original.getViewport(options), render: options => {
        calls.push({ scale: options.viewport.scale, viewportWidth: options.viewport.width, width: options.canvas.width, height: options.canvas.height, transform: options.transform });
        return original.render(options);
      } };
    } };
    const results = [];
    try {
      const preview = await renderPrintSheet(observed, sheets[0], settings, 38, controller.signal);
      check(Math.abs(calls.at(-1).scale - 1.5 * 38 / 72) < 1e-10, "Preview scale differs from layout");
      preview.width = preview.height = 0;
      for (const dpi of [150, 300, 600]) {
        const first = await renderPrintSheet(observed, sheets[0], settings, dpi, controller.signal);
        check(first.width === 8.5 * dpi && first.height === 11 * dpi, "Incorrect output pixel dimensions");
        const call = calls.at(-1);
        check(Math.abs(call.scale - 1.5 * dpi / 72) < 1e-10, "Effective source DPI was reduced");
        check(call.width <= first.width && call.height <= first.height, "Source canvas is not cropped to sheet");
        if (dpi === 600) check(call.viewportWidth === 7650, "The old source viewport cap is still applied");
        const second = await renderPrintSheet(observed, sheets[1], settings, dpi, controller.signal);
        const factor = dpi / 72, margin = Math.ceil(18 * factor), shift = Math.round((576 - settings.overlapPoints) * factor);
        const overlapWidth = Math.floor(settings.overlapPoints * factor) - 2;
        const a = first.getContext("2d").getImageData(margin + shift + 1, margin + 2, overlapWidth, Math.floor(756 * factor) - 4).data;
        const b = second.getContext("2d").getImageData(margin + 1, margin + 2, overlapWidth, Math.floor(756 * factor) - 4).data;
        let differences = 0, content = 0;
        for (let i = 0; i < a.length; i += 4) { if (a[i] < 245) content++; if (Math.abs(a[i] - b[i]) > 3 || Math.abs(a[i+1] - b[i+1]) > 3 || Math.abs(a[i+2] - b[i+2]) > 3) differences++; }
        check(content > 0, "Overlap comparison contained only blank pixels");
        check(differences / (a.length / 4) < .005, `Overlap mismatch at ${dpi} dpi: ${differences}`);
        const encoded = await encodePrintSheet(first, controller.signal);
        check(encoded.startsWith("data:image/png;base64,"), "Print encoding failed");
        const cancelled = new AbortController(); cancelled.abort();
        await encodePrintSheet(first, cancelled.signal).then(() => { throw new Error("Cancelled encoding succeeded"); }, e => check(e.name === "AbortError", "Wrong encoding cancellation error"));
        results.push({ dpi, width: first.width, height: first.height, effectiveScale: call.scale, croppedSource: [call.width, call.height], overlapMismatchPixels: differences });
        first.width = first.height = second.width = second.height = 0;
      }
      const aborted = new AbortController();
      let cancelledTask = false, source;
      const fake = { getPage: async () => ({ getViewport: options => ({ scale: options.scale }), render: options => {
        source = options.canvas; let reject;
        const promise = new Promise((_, no) => { reject = no; });
        setTimeout(() => aborted.abort(), 0);
        return { promise, cancel() { cancelledTask = true; reject(new DOMException("Cancelled", "AbortError")); } };
      } }) };
      await renderPrintSheet(fake, sheets[0], settings, 150, aborted.signal).then(() => { throw new Error("Cancelled rendering succeeded"); }, () => {});
      check(cancelledTask && source.width === 0, "Cancelled render did not stop and release its source canvas");
      return results;
    } finally { await pdf.loadingTask.destroy(); }
  });
  assert.equal(results.length, 3); console.log(JSON.stringify(results));
  console.log("ok actual PDF rendering at 150/300/600 dpi, uncapped effective scale, cropped allocations, overlap pixel alignment, preview geometry, PNG encoding and cancellation");
} finally { await app?.close(); await server.close(); }
