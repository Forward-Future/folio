import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DEFAULT_PRINT, parsePages, planSheets, overlapToPoints, overlapFromPoints, printPixels, checkPrintBudget } from "../src/printLayout.ts";
const { validatePrintJob, printHtml } = createRequire(import.meta.url)("../electron/printing.cjs");
assert.deepEqual(parsePages("1-3, 5, 2", 8), [1, 2, 3, 5]);
for (const value of ["", "0", "1-99", "3-1", "1,", "1.5", "<script>"]) assert.throws(() => parsePages(value, 8));
const sizes = Array.from({ length: 8 }, () => ({ width: 612, height: 792 }));
const plan = (pages, settings) => planSheets(pages, sizes, { ...DEFAULT_PRINT, ...settings });
const mixed = [sizes[0], { width: 792, height: 612 }];
for (const mode of ["size", "poster"]) {
  const byPage = planSheets([1, 2], mixed, { ...DEFAULT_PRINT, mode });
  for (const sheet of byPage) assert.deepEqual([sheet.width, sheet.height],
    sheet.placements[0].page === 1 ? [612, 792] : [792, 612]);
}
assert.equal(plan([1], { sizing: "actual" })[0].placements[0].scale, 1);
assert.equal(plan([1], { sizing: "custom", scale: 75 })[0].placements[0].scale, .75);
assert.ok(plan([1], { sizing: "shrink" })[0].placements[0].scale < 1);
assert.equal(plan([1], { orientation: "landscape" })[0].width, 792);
assert.equal(plan([1], { mode: "poster", scale: 200 }).length, 9);
const multiple = plan([1, 2, 3, 4, 5], { mode: "multiple", perSheet: 4 });
assert.equal(multiple.length, 2); assert.deepEqual(multiple[0].placements.map(p => p.page), [1, 2, 3, 4]);
const booklet = plan([1, 2, 3, 4, 5, 6, 7, 8], { mode: "booklet" });
assert.deepEqual(booklet.map(s => s.placements.map(p => p.page)), [[8, 1], [2, 7], [6, 3], [4, 5]]);
assert.deepEqual(plan([1, 2, 3], { mode: "booklet" }).map(s => s.placements.map(p => p.page)), [[1], [2, 3]]);
assert.equal(plan([1, 2, 3], { mode: "booklet" })[0].placements[0].clip.x, 396);
assert.throws(() => plan([1], { scale: NaN }));
assert.throws(() => planSheets(Array.from({ length: 101 }, () => 1), sizes, DEFAULT_PRINT));
const header = Buffer.alloc(33); Buffer.from("89504e470d0a1a0a", "hex").copy(header); header.writeUInt32BE(13, 8); header.write("IHDR", 12); header.writeUInt32BE(1275, 16); header.writeUInt32BE(1650, 20);
const job = { paper: "Letter", dpi: 150, landscape: false, booklet: false, copies: 1, printer: "", images: ["data:image/png;base64," + header.toString("base64")] };
validatePrintJob(job);
for (const bad of [{ copies: 0 }, { images: ["https://evil.example/x.png"] }, { images: ["data:image/png;base64,AAAA\" onload=\"alert(1)"] }, { images: [] }, { paper: "<script>" }, { landscape: "true" }]) assert.throws(() => validatePrintJob({ ...job, ...bad }));
assert.match(printHtml(job), /default-src 'none'/);
assert.match(printHtml(job), /size: Letter portrait/);
assert.equal(overlapToPoints(1, "in"), 72);
assert.equal(overlapToPoints(25.4, "mm"), 72);
assert.equal(overlapFromPoints(18, "mm"), 6.35);
assert.deepEqual(plan([1], { mode: "poster", overlapPoints: overlapToPoints(.25, "in") }), plan([1], { mode: "poster", overlapPoints: overlapToPoints(6.35, "mm") }));
for (const orientation of ["portrait", "landscape"]) for (const overlapPoints of [0, 18, 72]) {
  const tiles = plan([1], { mode: "poster", scale: 200, orientation, overlapPoints });
  const a = tiles[0].placements[0], next = tiles[1].placements[0];
  assert.equal(a.clip.width - (a.x - next.x), overlapPoints);
  const last = tiles.at(-1).placements[0];
  assert.ok(last.clip.x - last.x + last.clip.width >= last.width);
  assert.ok(last.clip.y - last.y + last.clip.height >= last.height);
  const nextRow = tiles.find(t => t.placements[0].y < a.y).placements[0];
  assert.equal(a.clip.height - (a.y - nextRow.y), overlapPoints);
}
assert.equal(planSheets([1], [{ width: 576, height: 756 }], { ...DEFAULT_PRINT, mode: "poster", orientation: "portrait" }).length, 1);
for (const overlapPoints of [-1, NaN, 576]) assert.throws(() => plan([1], { mode: "poster", overlapPoints }));
for (const dpi of [150, 300, 600]) assert.deepEqual(printPixels(sizes[0], dpi), { width: 8.5 * dpi, height: 11 * dpi });
checkPrintBudget(sizes.slice(0, 4), 600);
assert.throws(() => checkPrintBudget(sizes.slice(0, 5), 600), /576 MiB/);
assert.throws(() => checkPrintBudget(sizes, 1200));
assert.throws(() => validatePrintJob({ ...job, dpi: 300 }), /dimensions/);
assert.throws(() => validatePrintJob({ ...job, dpi: 600, images: Array(5).fill(job.images[0]) }), /memory limit/);
console.log("ok print ranges, sizing, orientation, poster tiles, multiple, booklet padding and print IPC validation");
console.log("ok DPI dimensions/budget, PNG dimension validation, inch/mm conversion, overlap coverage and exact-fit tile counts");
