import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ocr", () => ({ ocrSession: (pdf: { session?: unknown }) => pdf.session }));

import { documentText } from "./AiPanel";

type FakeItem = { str?: string; hasEOL?: boolean };
type Session = { version: number; pages: Map<number, unknown[]>; embedded: Set<number> };

function makePdf(pages: FakeItem[][], session?: Session) {
  const getPage = vi.fn(async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] }) }));
  return { numPages: pages.length, getPage, session } as unknown as Parameters<typeof documentText>[0] & { getPage: typeof getPage };
}
const sessionWith = (pages: [number, unknown[]][] = [], version = 0, embedded: number[] = []): Session => ({ version, pages: new Map(pages), embedded: new Set(embedded) });

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
    // A copy saved with recognized text carries it inside the PDF, but it is still read by OCR.
    expect((await documentText(makePdf([[{ str: "a" }]], sessionWith([], 0, [1])))).recognized).toBe(true);
  });
});
