import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openPdf } from "../../../testing/pdfjs";
import type { OcrSession } from "../session/OcrSession";
import type { TextItem } from "../types";
import { copyWithText, savedMessage } from "./copyWithText";

// The real embedder, except where a test makes it fail.
vi.mock("./embedText", async (importOriginal) => {
  const real = await importOriginal<typeof import("./embedText")>();
  return { embedRecognizedText: vi.fn(real.embedRecognizedText) };
});
import { embedRecognizedText } from "./embedText";

const word: TextItem = { str: "recognized", dir: "ltr", fontName: "ocr", hasEOL: false, transform: [12, 0, 0, 12, 72, 700], width: 70, height: 12, inkWidth: 70 };

async function blank() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}

interface FakeDocument { info?: object; fields?: Map<string, object[]> | null; reading?: Error }
/** A session over a document that answers the questions about encryption and signatures. */
function sessionFor({ info = {}, fields = null, reading }: FakeDocument = {}, pages: [number, unknown[]][] = [[1, [word]]], embedded: number[] = []) {
  const pdf = {
    getMetadata: vi.fn(async () => { if (reading) throw reading; return { info }; }),
    getFieldObjects: vi.fn(async () => fields),
  };
  return { pdf, pages: new Map(pages), embedded: new Set(embedded) } as unknown as OcrSession & { pdf: typeof pdf };
}

// (Braces: a function returned from beforeEach would be run afterwards as cleanup, and this one would be the mock itself.)
beforeEach(() => { vi.mocked(embedRecognizedText).mockClear(); });

describe("copyWithText", () => {
  it("hands back the bytes untouched when nothing was recognized", async () => {
    const bytes = await blank();
    expect(await copyWithText(null, bytes)).toEqual({ bytes, embedded: false });
    expect(await copyWithText(sessionFor({}, []), bytes)).toEqual({ bytes, embedded: false });
    // A page that was read and gave nothing new doesn't need anything added.
    expect(await copyWithText(sessionFor({}, [[1, []], [2, []]]), bytes)).toEqual({ bytes, embedded: false });
    expect(embedRecognizedText).not.toHaveBeenCalled();
  });

  it("puts the recognized text into the copy", async () => {
    const bytes = await blank();
    const session = sessionFor({}, [[1, [word]]], [4]);
    const copy = await copyWithText(session, bytes);
    expect(copy.embedded).toBe(true);
    expect(copy.problem).toBeUndefined();
    expect(embedRecognizedText).toHaveBeenCalledWith(bytes, session.pages, session.embedded);
    const page = await (await openPdf(copy.bytes)).getPage(1);
    expect(((await page.getTextContent()).items as { str: string }[]).map((i) => i.str)).toEqual(["recognized"]);
  });

  it("goes ahead for a document with form fields that aren't signatures, or none", async () => {
    const bytes = await blank();
    expect((await copyWithText(sessionFor({ fields: new Map([["name", [{ type: "text" }]]]) }), bytes)).embedded).toBe(true);
    expect((await copyWithText(sessionFor({ fields: new Map() }), bytes)).embedded).toBe(true);
    expect((await copyWithText(sessionFor({ fields: null }), bytes)).embedded).toBe(true);
  });

  it("leaves the text out of a password-protected file, which can't be rewritten", async () => {
    const bytes = await blank();
    const copy = await copyWithText(sessionFor({ info: { EncryptFilterName: "Standard" } }), bytes);
    expect(copy).toEqual({ bytes, embedded: false, problem: "protected" });
    expect(embedRecognizedText).not.toHaveBeenCalled();
  });

  it("leaves the text out of a signed file, because rewriting it would break the signature", async () => {
    const bytes = await blank();
    const fields = new Map([["name", [{ type: "text" }]], ["sig", [{ type: "button" }, { type: "signature" }]]]);
    const copy = await copyWithText(sessionFor({ fields }), bytes);
    expect(copy).toEqual({ bytes, embedded: false, problem: "signed" });
    expect(embedRecognizedText).not.toHaveBeenCalled();
  });

  it("still returns the copy, and says so, when the text can't be added", async () => {
    const bytes = await blank();
    vi.mocked(embedRecognizedText).mockRejectedValueOnce(new Error("could not parse"));
    expect(await copyWithText(sessionFor(), bytes)).toEqual({ bytes, embedded: false, problem: "failed" });
  });

  it("does the same when it can't tell whether the file is protected or signed", async () => {
    const bytes = await blank();
    expect(await copyWithText(sessionFor({ reading: new Error("no info") }), bytes)).toEqual({ bytes, embedded: false, problem: "failed" });
  });
});

describe("savedMessage", () => {
  it("is the plain message when there is nothing to report", () => {
    expect(savedMessage({ markup: false, embedded: false })).toBe("Download started");
  });

  it("says what the copy carries", () => {
    expect(savedMessage({ markup: true, embedded: false })).toBe("Saved a copy with your highlights and notes");
    expect(savedMessage({ markup: false, embedded: true })).toBe("Saved a copy with the recognized text");
    expect(savedMessage({ markup: true, embedded: true })).toBe("Saved a copy with your highlights and notes and the recognized text");
  });

  it("says why the recognized text was left out", () => {
    expect(savedMessage({ markup: false, embedded: false, problem: "protected" })).toBe("Download started. The recognized text can't be added to a password-protected file.");
    expect(savedMessage({ markup: true, embedded: false, problem: "signed" })).toBe("Saved a copy with your highlights and notes. The recognized text was left out so the digital signature stays valid.");
    expect(savedMessage({ markup: false, embedded: false, problem: "failed" })).toBe("Download started. Couldn't add the recognized text.");
  });
});
