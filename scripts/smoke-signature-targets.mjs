import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import path from "node:path";

export async function checkSignatureTargets(app, page, photo, shots) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = pdf.addPage([612, 792]);
  for (const [index, text] of [
    "This agreement may only be amended by a writing signed by both parties.",
    "A signature on this document confirms acceptance of all terms.",
    "Electronic signature verification is not available.",
  ].entries()) sheet.drawText(text, { x: 50, y: 700 - index * 20, size: 10, font });
  sheet.drawText("Witness signature: __________", { x: 50, y: 150, size: 12, font });
  await app.evaluate(({ BrowserWindow }, data) => BrowserWindow.getAllWindows()[0].webContents.send(
    "folio:open-file", { name: "Signature captions.pdf", data: Buffer.from(data) }), Array.from(await pdf.save()));
  await page.window.waitForFunction(() => document.title.startsWith("Signature captions.pdf"));
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor();
  await page.getByTitle("Add a signature").click();
  await page.getByLabel("Upload signature photo").setInputFiles({ name: "mark.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
  await page.getByRole("button", { name: /Use this signature/ }).click();
  const placement = page.getByLabel("Signature placement", { exact: true });
  await placement.locator("option").filter({ hasText: "Witness signature" }).waitFor({ state: "attached" });
  await placement.selectOption({ index: 0 });
  const options = await placement.locator("option").allTextContents();
  await page.screenshot({ path: path.join(shots, "signature-targets.png") });
  assert.deepEqual(options, ["Witness signature: __________ (suggested)", "Choose a position on this page"],
    "only a standalone signing caption is suggested, never signature-related prose");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  console.log("ok  signature detection rejects contract prose and keeps standalone captions");
}
