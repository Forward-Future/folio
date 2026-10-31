import { describe, expect, it, vi } from "vitest";
import type { Box, TextItem } from "../types";
import { imageCover, isScanLike, textCover, type ImageOps } from "./scan";

const item = (over: Partial<TextItem> = {}): TextItem => ({
  str: "word", dir: "ltr", fontName: "f", hasEOL: false, transform: [10, 0, 0, 10, 0, 0], width: 20, height: 10, ...over,
});

describe("imageCover", () => {
  const ops: ImageOps = { save: 10, restore: 11, transform: 12, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83 };
  const page: Box = [0, 0, 612, 792];
  const run = (program: [number, unknown][], view: Box = page) =>
    imageCover(program.map(([fn]) => fn), program.map(([, args]) => args), ops, view);

  it("is 1 for a picture that fills the page", () => {
    expect(run([[ops.save, null], [ops.transform, [612, 0, 0, 792, 0, 0]], [ops.paintImageXObject, ["img"]], [ops.restore, null]])).toBeCloseTo(1);
  });

  it("is the share of the page a smaller picture covers", () => {
    expect(run([[ops.transform, [306, 0, 0, 792, 0, 0]], [ops.paintImageXObject, ["img"]]])).toBeCloseTo(0.5);
  });

  it("does not count the part of a picture that hangs off the page", () => {
    expect(run([[ops.transform, [1224, 0, 0, 792, -306, 0]], [ops.paintImageXObject, ["img"]]])).toBeCloseTo(1);
  });

  it("ignores the drawing operators that aren't about pictures or transforms", () => {
    const other = 99; // a fill, a stroke, a text operator...
    expect(run([[other, null], [ops.transform, [612, 0, 0, 792, 0, 0]], [other, [1, 2]], [ops.paintImageXObject, ["img"]], [other, null]])).toBeCloseTo(1);
  });

  it("returns to the earlier transform when a save is restored", () => {
    const inside = run([
      [ops.save, null], [ops.transform, [612, 0, 0, 792, 0, 0]], [ops.restore, null],
      [ops.paintImageXObject, ["img"]], // drawn with the identity transform: a 1 x 1 point square
    ]);
    expect(inside).toBeCloseTo(1 / (612 * 792));
  });

  it("applies a later transform inside an earlier one, the way pdf.js composes them", () => {
    // Translate by (100, 0), then scale by 50: the unit square lands at x 100..150, y 0..50 (not at x 5000).
    const share = run([[ops.transform, [1, 0, 0, 1, 100, 0]], [ops.transform, [50, 0, 0, 50, 0, 0]], [ops.paintImageXObject, ["img"]]]);
    expect(share).toBeCloseTo((50 * 50) / (612 * 792));
  });

  it("handles a picture turned a quarter", () => {
    expect(run([[ops.transform, [0, 792, -612, 0, 612, 0]], [ops.paintImageXObject, ["img"]]])).toBeCloseTo(1);
  });

  it("takes the largest picture, not the sum, and counts inline images and image masks", () => {
    expect(run([
      [ops.save, null], [ops.transform, [306, 0, 0, 396, 0, 0]], [ops.paintInlineImageXObject, [{}]], [ops.restore, null],
      [ops.save, null], [ops.transform, [306, 0, 0, 792, 0, 0]], [ops.paintImageMaskXObject, [{}]], [ops.restore, null],
    ])).toBeCloseTo(0.5);
  });

  it("measures against a page whose box doesn't start at the origin", () => {
    expect(run([[ops.transform, [612, 0, 0, 792, 10, 20]], [ops.paintImageXObject, ["img"]]], [10, 20, 622, 812])).toBeCloseTo(1);
  });

  it("is 0 when nothing is drawn, and ignores a restore with nothing saved", () => {
    expect(run([])).toBe(0);
    expect(run([[ops.restore, null]])).toBe(0);
  });
});

describe("textCover", () => {
  it("adds up the boxes of the text on a page", () => {
    const view: Box = [0, 0, 100, 100];
    expect(textCover([item({ width: 10, height: 10 }), item({ width: 10, height: 10 })], view)).toBeCloseTo(0.02);
    expect(textCover([], view)).toBe(0);
  });
});

describe("isScanLike", () => {
  it("is true for a page with no text, without measuring pictures", async () => {
    const image = vi.fn(() => 0);
    expect(await isScanLike(0, 0, image)).toBe(true);
    expect(image).not.toHaveBeenCalled();
  });

  it("is false for a page with plenty of text, without measuring pictures", async () => {
    const image = vi.fn(() => 1);
    expect(await isScanLike(300, 0.25, image)).toBe(false);
    expect(image).not.toHaveBeenCalled();
  });

  it("is true for a full-page picture with only a little stamped text", async () => {
    expect(await isScanLike(130, 0.045, () => 1)).toBe(true);
  });

  it("is false for sparse text with no big picture (a CAD sheet, a cover page)", async () => {
    expect(await isScanLike(20, 0.006, () => 0.02)).toBe(false);
  });

  it("uses the stated limits: text at 10% is too much, a picture at 60% is enough", async () => {
    expect(await isScanLike(50, 0.1, () => 1)).toBe(false);
    expect(await isScanLike(50, 0.0999, () => 1)).toBe(true);
    expect(await isScanLike(50, 0.05, () => 0.6)).toBe(true);
    expect(await isScanLike(50, 0.05, () => 0.5999)).toBe(false);
  });

  it("accepts an async picture measurement", async () => {
    expect(await isScanLike(5, 0.01, async () => 0.9)).toBe(true);
  });
});
