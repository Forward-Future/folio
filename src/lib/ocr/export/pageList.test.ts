import { describe, expect, it } from "vitest";
import { formatPages, parsePages } from "./pageList";

describe("formatPages", () => {
  it("writes runs of pages as ranges", () => {
    expect(formatPages([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
  });

  it("writes a single page, and nothing for no pages", () => {
    expect(formatPages([4])).toBe("4");
    expect(formatPages([])).toBe("");
  });

  it("ignores order and repeats", () => {
    expect(formatPages(new Set([9, 3, 4, 3, 1]))).toBe("1,3-4,9");
    expect(formatPages([2, 1, 2, 1])).toBe("1-2");
  });

  it("keeps two pages that are not neighbours apart", () => {
    expect(formatPages([1, 3])).toBe("1,3");
  });
});

describe("parsePages", () => {
  it("reads what formatPages wrote", () => {
    for (const pages of [[1, 2, 3, 5, 7, 8], [4], [], [1, 3], [10, 11, 12, 40]]) {
      expect([...parsePages(formatPages(pages), 100)]).toEqual(pages);
    }
  });

  it("tolerates spaces", () => {
    expect([...parsePages(" 1 - 2 , 5 ", 10)]).toEqual([1, 2, 5]);
  });

  it("skips anything that isn't a page or a range", () => {
    expect([...parsePages("2,abc,,3-x,-4,5-,6.5,7", 10)]).toEqual([2, 7]);
  });

  it("stays within the document", () => {
    expect([...parsePages("0,1-3,8,9-99999999999", 4)]).toEqual([1, 2, 3]);
    expect([...parsePages("0-2", 4)]).toEqual([1, 2]);
  });

  it("is not held up by a huge range", () => {
    // Walking this range would take minutes; it is cut to the pages the document has.
    expect([...parsePages("1-4000000000", 3)]).toEqual([1, 2, 3]);
  });

  it("only reads so much of a list", () => {
    // 120,000 characters of nothing useful, then a page: past the limit, so it is not read.
    expect(parsePages("x,".repeat(60_000) + "2", 3).size).toBe(0);
    expect([...parsePages("2," + "x,".repeat(20_000), 3)]).toEqual([2]);
  });

  it("reads a range that runs backwards as empty", () => {
    expect(parsePages("5-2", 10).size).toBe(0);
  });
});
