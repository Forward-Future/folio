import { describe, expect, it } from "vitest";
import type { TextItem } from "../types";
import { placeWords, writable } from "./placeWords";

// A font in which every letter is half an em wide and a space a quarter.
const widthOfEm = (text: string) => [...text].reduce((sum, c) => sum + (c === " " ? 0.25 : 0.5), 0);
const supported = new Set([..." abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?.,"].map((c) => c.codePointAt(0)!).concat(0xe9, 0xa0));

const item = (str: string, over: Partial<TextItem> = {}): TextItem => ({
  str, dir: "ltr", fontName: "ocr", hasEOL: false, transform: [10, 0, 0, 10, 100, 200], width: 50, height: 10, ...over,
});

describe("writable", () => {
  it("keeps what the font can write", () => {
    expect(writable("Hello, world 42 café", supported)).toBe("Hello, world 42 café");
  });

  it("writes a character the font lacks as the plain letters it is made of", () => {
    expect(writable("ﬁnal", supported)).toBe("final");
    expect(writable("ǎ", supported)).toBe("a");
    expect(writable("²", supported)).toBe("2");
  });

  it("writes a character with no plain form as a question mark", () => {
    expect(writable("a ≥ b → c", supported)).toBe("a ? b ? c");
    expect(writable("✓", supported)).toBe("?");
  });

  it("writes a plain form that the font can't write as a question mark too", () => {
    expect(writable("Ω", supported)).toBe("?");
    expect(writable("№", new Set([0x4e]))).toBe("?"); // its plain form is "No", and this font has no lowercase o
  });

  it("drops an accent that stands alone", () => {
    expect(writable("ét", supported)).toBe("et");
  });

  it("writes other kinds of space as a space", () => {
    expect(writable("a\tb\nc d", supported)).toBe("a b c d");
  });

  it("handles characters outside the basic plane as one character", () => {
    expect(writable("a😀b", supported)).toBe("a?b");
  });
});

describe("placeWords", () => {
  it("places a word at its own transform, squeezed so its advance is the width of its ink", () => {
    // 4 letters at size 10 are 20 wide; the ink is 50 wide, so the text is stretched to 250%.
    const [run] = placeWords([item("word", { inkWidth: 50 })], widthOfEm, supported);
    expect(run).toEqual({ matrix: [10, 0, 0, 10, 100, 200], text: "word", squeeze: 250 });
  });

  it("falls back to the item's width when it has no separate ink width", () => {
    expect(placeWords([item("word", { width: 40 })], widthOfEm, supported)[0].squeeze).toBe(200);
  });

  it("follows a word that is followed by a space with a space that spans the gap", () => {
    // The word's ink is 30 wide of the 50 the item takes; the 20 left over is bridged by a space (2.5 at size 10).
    const [run] = placeWords([item("word ", { width: 50, inkWidth: 30 })], widthOfEm, supported);
    expect(run.text).toBe("word");
    expect(run.squeeze).toBe(150);
    expect(run.gap).toBe(800);
  });

  it("closes the space up when there is no gap, rather than leaving the word out", () => {
    const [run] = placeWords([item("word ", { width: 30, inkWidth: 30 })], widthOfEm, supported);
    expect(run.gap).toBe(1);
  });

  it("does not add a space after the last word of a line", () => {
    expect(placeWords([item("word", { width: 50, inkWidth: 30 })], widthOfEm, supported)[0].gap).toBeUndefined();
  });

  it("keeps the slant and direction of a line that is rotated or skewed", () => {
    const transform = [0, 10, -10, 0, 300, 400]; // reading upwards
    const [run] = placeWords([item("up", { transform, inkWidth: 25 })], widthOfEm, supported);
    expect(run.matrix).toEqual(transform);
    expect(run.squeeze).toBe(250); // size is the length of the first axis, not just its x part
  });

  it("writes the text the font can write", () => {
    expect(placeWords([item("a≥b", { inkWidth: 30 })], widthOfEm, supported)[0].text).toBe("a?b");
  });

  it("leaves out items that can't be drawn", () => {
    const bad = [
      item(""), item("   "), item("́"), // nothing to write
      item("zero", { transform: [0, 0, 0, 0, 1, 1] }), // no size
      item("flat", { inkWidth: 0 }), item("neg", { width: -5 }), // no width
      item("nan", { inkWidth: NaN }), item("inf", { width: Infinity }), item("nan2", { transform: [10, 0, 0, 10, NaN, 0] }),
    ];
    expect(placeWords(bad, widthOfEm, supported)).toEqual([]);
  });

  it("leaves out an item whose text has no width in the font", () => {
    expect(placeWords([item("word")], () => 0, supported)).toEqual([]);
  });

  it("keeps the good items around the bad", () => {
    const runs = placeWords([item("one", { inkWidth: 30 }), item(""), item("two", { inkWidth: 30 })], widthOfEm, supported);
    expect(runs.map((r) => r.text)).toEqual(["one", "two"]);
  });
});
