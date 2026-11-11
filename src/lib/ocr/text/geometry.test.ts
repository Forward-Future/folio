import { describe, expect, it } from "vitest";
import type { Box, TextItem } from "../types";
import { area, boxOf, dropDuplicates, overlap } from "./geometry";

const item = (over: Partial<TextItem> = {}): TextItem => ({
  str: "word", dir: "ltr", fontName: "f", hasEOL: false, transform: [10, 0, 0, 10, 0, 0], width: 20, height: 10, ...over,
});

describe("boxOf", () => {
  it("covers the width and height of unrotated text from its origin", () => {
    expect(boxOf(item({ transform: [10, 0, 0, 10, 5, 7], width: 20, height: 10 }))).toEqual([5, 7, 25, 17]);
  });

  it("follows text rotated a quarter turn", () => {
    // Text runs up the page: along = (0, width), up = (-height, 0).
    expect(boxOf(item({ transform: [0, 10, -10, 0, 50, 7], width: 20, height: 10 }))).toEqual([40, 7, 50, 27]);
  });

  it("does not produce NaN for a degenerate transform", () => {
    const box = boxOf(item({ transform: [0, 0, 0, 0, 3, 4], width: 20, height: 10 }));
    expect(box.every(Number.isFinite)).toBe(true);
  });
});

describe("area and overlap", () => {
  it("measures a box and treats inverted boxes as empty", () => {
    expect(area([0, 0, 4, 5])).toBe(20);
    expect(area([4, 0, 0, 5])).toBe(0);
  });

  it("measures how much two boxes share", () => {
    expect(overlap([0, 0, 10, 10], [5, 5, 15, 15])).toBe(25);
    expect(overlap([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    expect(overlap([0, 0, 10, 10], [2, 2, 4, 4])).toBe(4);
  });
});

describe("dropDuplicates", () => {
  const existing: Box[] = [[0, 0, 20, 10]];

  it("drops recognized words that sit on the PDF's own text", () => {
    const onTop = item({ transform: [10, 0, 0, 10, 0, 0], width: 20, height: 10 });
    expect(dropDuplicates([onTop], existing)).toEqual([]);
  });

  it("keeps words elsewhere on the page", () => {
    const elsewhere = item({ transform: [10, 0, 0, 10, 100, 100] });
    expect(dropDuplicates([elsewhere], existing)).toEqual([elsewhere]);
  });

  it("drops a word that is exactly half covered, and keeps one that is less", () => {
    const half = item({ transform: [10, 0, 0, 10, 10, 0], width: 20, height: 10 }); // x 10..30, half inside 0..20
    const less = item({ transform: [10, 0, 0, 10, 12, 0], width: 20, height: 10 }); // x 12..32, 40% inside
    expect(dropDuplicates([half], existing)).toEqual([]);
    expect(dropDuplicates([less], existing)).toEqual([less]);
  });

  it("is not fooled by the gap after a word (a table column) when judging overlap", () => {
    // The word's box runs 100 wide to reach the next word, but its own ink is only 20 wide and sits on the PDF's text.
    const stretched = item({ transform: [10, 0, 0, 10, 0, 0], width: 100, height: 10, inkWidth: 20 });
    expect(dropDuplicates([stretched], existing)).toEqual([]);
    expect(dropDuplicates([{ ...stretched, inkWidth: undefined }], existing)).toEqual([{ ...stretched, inkWidth: undefined }]);
  });

  it("keeps everything when the PDF has no text of its own", () => {
    const items = [item(), item({ str: "other" })];
    expect(dropDuplicates(items, [])).toEqual(items);
  });
});
