import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ocr", () => ({ ocrSession: (pdf: { session?: unknown }) => pdf.session }));

import { documentText, instructions } from "./AiPanel";

type FakeItem = { str?: string; hasEOL?: boolean };
type Session = { version: number; pages: Map<number, unknown[]> };

function makePdf(pages: FakeItem[][], session?: Session) {
  const getPage = vi.fn(async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] }) }));
  return { numPages: pages.length, getPage, session } as unknown as Parameters<typeof documentText>[0] & { getPage: typeof getPage };
}
const sessionWith = (pages: [number, unknown[]][] = [], version = 0): Session => ({ version, pages: new Map(pages) });

describe("documentText", () => {
  it("lays the document out as page blocks, with words joined and line ends kept", async () => {
    const pdf = makePdf([
      [{ str: "Hello", hasEOL: false }, { str: "world", hasEOL: true }, { str: "second line", hasEOL: true }],
      [{ str: "page two", hasEOL: false }],
    ]);
    expect((await documentText(pdf)).text).toBe("[Page 1]\nHello world\nsecond line\n\n[Page 2]\npage two\n\n");
  });

  it("skips items that aren't text (marked-content markers)", async () => {
    const pdf = makePdf([[{ str: "kept", hasEOL: true }, { type: "beginMarkedContent" } as FakeItem]]);
    expect((await documentText(pdf)).text).toBe("[Page 1]\nkept\n\n");
  });

  it("stops at the size limit and says the document was cut short", async () => {
    const big = "x".repeat(300_000);
    const result = await documentText(makePdf([[{ str: big }], [{ str: big }]]));
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[Page 1]");
    expect(result.text).not.toContain("[Page 2]");
  });

  it("is not truncated when it fits", async () => {
    expect((await documentText(makePdf([[{ str: "short" }]]))).truncated).toBe(false);
  });

  it("reads each document once, however often it is asked for", async () => {
    const pdf = makePdf([[{ str: "a" }], [{ str: "b" }]], sessionWith());
    const first = documentText(pdf);
    const second = documentText(pdf);
    expect(second).toBe(first);
    await first;
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
  });

  it("reads it again once recognition has added text, so answers see the new pages", async () => {
    const session = sessionWith();
    const pdf = makePdf([[]], session);
    const before = await documentText(pdf);
    expect(before.text.replace(/\[Page \d+\]/g, "").trim()).toBe("");

    session.pages.set(1, [{}]);
    session.version++;
    const after = await documentText(pdf);
    expect(after).not.toBe(before);
    expect(after.recognized).toBe(true);
    expect(pdf.getPage).toHaveBeenCalledTimes(2); // read again, not served from the old result
  });

  it("tells whether any of the text came from recognition", async () => {
    expect((await documentText(makePdf([[{ str: "a" }]]))).recognized).toBe(false);
    expect((await documentText(makePdf([[{ str: "a" }]], sessionWith()))).recognized).toBe(false);
    expect((await documentText(makePdf([[{ str: "a" }]], sessionWith([[1, []]])))).recognized).toBe(false);
    expect((await documentText(makePdf([[{ str: "a" }]], sessionWith([[1, [{}]]])))).recognized).toBe(true);
  });
});

describe("instructions", () => {
  const doc = { text: "[Page 1]\nHello\n\n", truncated: false, recognized: false };

  it("names the document and includes its text between tags", () => {
    const text = instructions("Report.pdf", doc);
    expect(text).toContain('"Report.pdf"');
    expect(text).toContain("<document>\n[Page 1]\nHello\n\n</document>");
  });

  it("warns the model that recognized text may contain mistakes", () => {
    expect(instructions("Scan.pdf", { ...doc, recognized: true })).toContain("read from scanned pages by OCR");
  });

  it("says nothing about recognition for ordinary documents", () => {
    expect(instructions("Report.pdf", doc)).not.toContain("OCR");
  });

  it("explains when a document has no text at all", () => {
    const text = instructions("Scan.pdf", { text: "[Page 1]\n\n", truncated: false, recognized: false });
    expect(text).toContain("no extractable text");
    expect(text).not.toContain("<document>");
  });

  it("explains when only the start of a long document was included", () => {
    expect(instructions("Long.pdf", { ...doc, truncated: true })).toContain("only the beginning is included");
  });

  it("keeps its guidance on citing pages", () => {
    expect(instructions("Report.pdf", doc)).toContain("Cite page numbers");
  });
});
