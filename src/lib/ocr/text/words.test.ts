import { describe, expect, it } from "vitest";
import { boxOf } from "./geometry";
import { keepWord, keepWords, toItems, type Line, type Word } from "./words";

describe("keepWord", () => {
  const word = (text: string, confidence: number): Word => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });

  it.each([
    ["a confident word", "Engine", 96, true],
    ["a word right at the confidence floor", "ok", 30, true],
    ["a short word below the floor (a speck)", "t", 20, false],
    ["a two-character guess below the floor", "~/", 25, false],
    ["a long word below the floor (a damaged real word)", "Image+Text", 22, true],
    ["a four-letter word just below the floor", "Text", 29, true],
    ["a three-letter word just below the floor", "Tex", 29, false],
    ["punctuation only, however long", "......", 10, false],
    ["a stray colon from a speck on the paper", ":", 48, false],
    ["a stray bar or equals sign from a speck", "|", 54, false],
    ["a symbol Tesseract is quite sure of (a bullet or dash)", "—", 90, true],
    ["a symbol right at the symbol threshold", "•", 80, true],
    ["a symbol just under it", "•", 79, false],
    ["a speck that scored higher than most", ":", 73, false],
    ["accented letters count as letters", "résumé", 20, true],
    ["digits count too", "12345", 20, true],
    ["an empty string", "", 99, false],
    ["whitespace only", "   ", 99, false],
  ])("%s", (_name, text, confidence, expected) => {
    expect(keepWord(word(text, confidence))).toBe(expected);
  });
});

describe("keepWords", () => {
  const box = (text: string, confidence: number, w: number, h: number): Word => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: w, y1: h } });
  const text = (t: string) => box(t, 95, 100, 40); // a word 40 px tall

  it("drops a tiny symbol Tesseract is confident about, next to full-size text", () => {
    expect(keepWords([text("Scanned"), box("|", 85, 3, 1), text("page")]).map((w) => w.text)).toEqual(["Scanned", "page"]);
    expect(keepWords([text("Folio"), box(":", 83, 2, 3)]).map((w) => w.text)).toEqual(["Folio"]);
  });

  it("keeps a real dash, a real vertical bar, and a bullet", () => {
    expect(keepWords([text("Item"), box("-", 90, 45, 4)]).map((w) => w.text)).toEqual(["Item", "-"]); // wide, though flat
    expect(keepWords([box("|", 90, 3, 40), text("Name")]).map((w) => w.text)).toEqual(["|", "Name"]); // tall, though thin
    expect(keepWords([box("•", 92, 12, 12), text("Point")]).map((w) => w.text)).toEqual(["•", "Point"]);
  });

  it("judges size against the text on the same line, so the same mark can stay on a line of small text", () => {
    const small = (t: string) => box(t, 95, 40, 12);
    expect(keepWords([small("fine"), box("-", 90, 4, 3)]).map((w) => w.text)).toEqual(["fine", "-"]); // 4 px is a third of 12 px
    expect(keepWords([text("big"), box("-", 90, 4, 3)]).map((w) => w.text)).toEqual(["big"]); // 4 px is a tenth of 40 px
  });

  it("applies the size test at exactly a quarter of the text height", () => {
    expect(keepWords([text("a"), box("-", 90, 10, 2)]).map((w) => w.text)).toEqual(["a", "-"]);
    expect(keepWords([text("a"), box("-", 90, 9.9, 2)]).map((w) => w.text)).toEqual(["a"]);
  });

  it("keeps a confident symbol when the line has no text to compare it with (a rule or separator)", () => {
    expect(keepWords([box("-----", 90, 300, 4)]).map((w) => w.text)).toEqual(["-----"]);
  });

  it("still applies the confidence rules first", () => {
    expect(keepWords([text("ok"), box("•", 40, 12, 12)]).map((w) => w.text)).toEqual(["ok"]);
    expect(keepWords([box("", 99, 5, 5), box("   ", 99, 5, 5)])).toEqual([]);
  });

  it("returns nothing for an empty line", () => {
    expect(keepWords([])).toEqual([]);
  });
});

describe("toItems", () => {
  // 2 pixels per point, page 800 points tall, y flipped like a real unrotated viewport.
  const upright = { convertToPdfPoint: (x: number, y: number) => [x / 2, 800 - y / 2] };
  const word = (text: string, x0: number, x1: number, confidence = 95): Word => ({ text, confidence, bbox: { x0, y0: 80, x1, y1: 110 } });
  const line = (words: Word[]): Line => ({ words, bbox: { x0: words[0]?.bbox.x0 ?? 0, y0: 80, x1: 400, y1: 110 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 100 } });

  it("turns each word into a text item in page space", () => {
    const [first] = toItems([line([word("Hello", 20, 100), word("world", 120, 220)])], upright);
    expect(first.str).toBe("Hello ");
    // 30 px tall = 15 pt, baseline 100 px = 750 pt. Compared with a tolerance because flipping a zero gives -0.
    [15, 0, 0, 15, 10, 750].forEach((expected, i) => expect(first.transform[i]).toBeCloseTo(expected, 9));
    expect(first.dir).toBe("ltr");
    expect(first.fontName).toBe("ocr");
  });

  it("lets a word's width run on to the next word, so the gap belongs to it", () => {
    const [first, second] = toItems([line([word("Hello", 20, 100), word("world", 120, 220)])], upright);
    expect(first.width).toBe(50); // 20..120 px
    expect(second.width).toBe(50); // 120..220 px, the last word keeps its own box
  });

  it("remembers each word's own width, apart from the gap its box is stretched over", () => {
    const [first, second] = toItems([line([word("Hello", 20, 100), word("world", 120, 220)])], upright);
    expect(first.inkWidth).toBeCloseTo(40); // 20..100 px = 40 pt, though width runs on to 120 px
    expect(second.inkWidth).toBeCloseTo(second.width);
  });

  it("separates words with a space and ends the line on the last one", () => {
    const items = toItems([line([word("one", 20, 60), word("two", 80, 120), word("three", 140, 200)])], upright);
    expect(items.map((i) => i.str)).toEqual(["one ", "two ", "three"]);
    expect(items.map((i) => i.hasEOL)).toEqual([false, false, true]);
  });

  it("joins into the sentence that was printed when read the way find does", () => {
    const items = toItems([line([word("A", 20, 40), word("sample", 60, 160), word("page.", 180, 260)])], upright);
    expect(items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("")).toBe("A sample page.\n");
  });

  it("leaves out the stray symbols that specks on the paper produce at the ends of a line", () => {
    const items = toItems([line([word(":", 10, 14, 48), word("Please", 20, 80), word("bring", 100, 160), word(";", 180, 184, 41)])], upright);
    expect(items.map((i) => i.str.trim())).toEqual(["Please", "bring"]);
    expect(items.at(-1)?.hasEOL).toBe(true);
  });

  it("sizes a line from Tesseract's row height, even when a word box has swollen to take in a speck", () => {
    // "to" came back 65 px tall (a speck above it) on a line whose text is about 41 px; the row model says 40.
    const swollen: Word = { text: "to", confidence: 95, bbox: { x0: 140, y0: 40, x1: 180, y1: 105 } };
    const [first] = toItems([{ words: [word("This", 20, 100), swollen], bbox: { x0: 0, y0: 40, x1: 400, y1: 105 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 100 }, rowAttributes: { rowHeight: 40 } }], upright);
    expect(first.height).toBeCloseTo(20); // 40 px at 2 px per point
  });

  it("falls back to the kept words when there is no usable row height", () => {
    for (const rowAttributes of [undefined, { rowHeight: 0 }, { rowHeight: NaN }, { rowHeight: -5 }]) {
      const [first] = toItems([{ ...line([word("Hello", 20, 100)]), rowAttributes }], upright);
      expect(first.height).toBeCloseTo(15); // the word is 80..110 = 30 px
    }
  });

  it("sizes a line from the words kept, not from a line box that specks have stretched", () => {
    // Tesseract's line box reaches from y 0 to 200 because of a speck far above and below; the real words are 30 px tall.
    const stretched: Line = { words: [word("Hello", 20, 100), word("world", 120, 220)], bbox: { x0: 0, y0: 0, x1: 400, y1: 200 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 100 } };
    const [first] = toItems([stretched], upright);
    expect(first.height).toBeCloseTo(15); // 30 px at 2 px per point, not 100 pt
  });

  it("sizes a line to fit its tallest kept word, so ascenders and descenders are inside the box", () => {
    const tall: Word = { text: "Ty", confidence: 95, bbox: { x0: 20, y0: 70, x1: 60, y1: 112 } };
    const short: Word = { text: "a", confidence: 95, bbox: { x0: 80, y0: 90, x1: 100, y1: 110 } };
    const [first] = toItems([{ words: [tall, short], bbox: { x0: 0, y0: 70, x1: 400, y1: 112 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 100 } }], upright);
    expect(first.height).toBeCloseTo(21); // 70..112 px = 42 px = 21 pt
  });

  it("leaves out confident but tiny specks too", () => {
    const speck = (text: string, x: number): Word => ({ text, confidence: 85, bbox: { x0: x, y0: 90, x1: x + 3, y1: 91 } });
    const items = toItems([line([speck("|", 10), word("Scanned", 20, 120), word("page", 140, 200), speck(":", 230)])], upright);
    expect(items.map((i) => i.str.trim())).toEqual(["Scanned", "page"]);
  });

  it("drops specks but keeps a long word that Tesseract was unsure of", () => {
    const items = toItems([line([word("This", 20, 80), word("~", 90, 100, 10), word("Image+Text", 120, 300, 22)])], upright);
    expect(items.map((i) => i.str.trim())).toEqual(["This", "Image+Text"]);
  });

  it("marks the last word that survived as the end of the line, even if the printed last word was dropped", () => {
    const items = toItems([line([word("kept", 20, 80), word("~", 90, 100, 5)])], upright);
    expect(items).toHaveLength(1);
    expect(items[0].hasEOL).toBe(true);
    expect(items[0].str).toBe("kept");
  });

  it("returns nothing for a line with no usable words, and for no lines", () => {
    expect(toItems([line([word("", 20, 40)])], upright)).toEqual([]);
    expect(toItems([], upright)).toEqual([]);
  });

  it("skips a word with no width", () => {
    expect(toItems([line([word("flat", 50, 50)])], upright)).toEqual([]);
  });

  it("follows the slope of a tilted baseline", () => {
    const tilted: Line = { words: [word("tilt", 0, 100)], bbox: { x0: 0, y0: 80, x1: 400, y1: 110 }, baseline: { x0: 0, y0: 100, x1: 400, y1: 140 } };
    const [out] = toItems([tilted], { convertToPdfPoint: (x, y) => [x, -y] });
    // The baseline falls 10 px over 100 px, so the text direction tilts the same way (y is flipped by the viewport).
    expect(out.transform[1]).toBeLessThan(0);
    expect(out.transform[0]).toBeGreaterThan(0);
    expect(Math.hypot(out.transform[0], out.transform[1])).toBeCloseTo(out.height, 5);
  });

  it("writes text rotated by the viewport as rotated text, with box and direction agreeing", () => {
    // A page shown turned a quarter: page-space x comes from the pixel y, and y from the pixel x.
    const turned = { convertToPdfPoint: (x: number, y: number) => [y / 2, x / 2] };
    const [out] = toItems([line([word("up", 20, 100)])], turned);
    expect(out.transform[0]).toBeCloseTo(0, 5);
    expect(out.transform[1]).toBeGreaterThan(0);
    const [left, , right, top] = boxOf(out);
    expect(right - left).toBeCloseTo(out.height, 5);
    expect(top).toBeGreaterThan(0);
  });
});
