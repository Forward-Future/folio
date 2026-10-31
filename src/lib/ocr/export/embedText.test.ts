import { PDFArray, PDFDocument, PDFName, StandardFonts, decodePDFRawStream, type PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { protectedByOwner, protectedWithPassword } from "../../../testing/fixtures";
import { openPdf } from "../../../testing/pdfjs";
import type { TextItem } from "../types";
import { embedRecognizedText } from "./embedText";

/** A recognized word: where its baseline starts, the width of its ink (and the box it takes up), and its size. */
const word = (str: string, x: number, y: number, width: number, size = 12, over: Partial<TextItem> = {}): TextItem => ({
  str, dir: "ltr", fontName: "ocr", hasEOL: false, transform: [size, 0, 0, size, x, y], width, height: size, inkWidth: width, ...over,
});

async function blank(pages = 2, prepare?: (doc: PDFDocument) => void | Promise<void>) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  await prepare?.(doc);
  return doc.save();
}

/** The page's drawing instructions as written in the file, all of its content streams together. */
async function contentOf(bytes: Uint8Array, n = 0) {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(n).node.Contents();
  const streams = (contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents]) as PDFRawStream[];
  return streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
}

async function textOn(bytes: Uint8Array, n = 1) {
  const page = await (await openPdf(bytes)).getPage(n);
  const { items } = await page.getTextContent({ disableNormalization: true });
  // pdf.js marks some line ends with an item of no text.
  return (items as { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }[]).filter((i) => i.str !== "");
}
const flat = (items: { str: string }[]) => items.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
const embed = (bytes: Uint8Array, pages: [number, TextItem[]][], embedded: number[] = []) =>
  embedRecognizedText(bytes, new Map(pages), new Set(embedded));

describe("embedRecognizedText", () => {
  it("lays each word over the page where it was recognized, as wide as its ink", async () => {
    const out = await embed(await blank(), [[1, [
      word("Hello ", 72, 700, 90, 14, { width: 100 }), word("world", 172, 700, 80, 14),
      word("second line", 72, 650, 150, 14),
    ]]]);
    const items = await textOn(out);
    // Each word is its own piece of text, so each can be found and selected where it is on the scan, and the words of a
    // line read as separated by a space.
    expect(items.map((i) => i.str)).toEqual(["Hello", " ", "world", "second line"]);
    const [hello, , world, second] = items;
    expect(hello.transform.slice(4)).toEqual([72, 700]);
    expect(hello.width).toBeCloseTo(90, 0);
    expect(hello.height).toBeCloseTo(14, 1);
    expect(world.transform.slice(4)).toEqual([172, 700]);
    expect(world.width).toBeCloseTo(80, 0);
    expect(second.transform.slice(4)).toEqual([72, 650]);
    expect(second.width).toBeCloseTo(150, 0);
  });

  it("draws the words invisibly, so the scan looks exactly as it did", async () => {
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const out = await embed(await blank(1), [[1, [word("hidden", 72, 700, 50), word("also", 72, 650, 40)]]]);
    const { fnArray, argsArray } = await (await (await openPdf(out)).getPage(1)).getOperatorList();
    const modes = fnArray.flatMap((fn, i) => (fn === OPS.setTextRenderingMode ? [argsArray[i][0]] : []));
    expect(modes).toEqual([3]); // 3 is "neither fill nor stroke"
    expect(fnArray).toContain(OPS.showText);
    // Whatever the text changes is undone afterwards: every save has its restore (pdf.js would quietly make up the
    // missing ones, so this reads the instructions as they are in the file).
    const tokens = (await contentOf(out)).split(/\s+/);
    expect(tokens.filter((t) => t === "q").length).toBeGreaterThan(0);
    expect(tokens.filter((t) => t === "q")).toHaveLength(tokens.filter((t) => t === "Q").length);
    // Nothing is painted: the text is the only thing on the page.
    for (const painted of [OPS.fill, OPS.stroke, OPS.paintImageXObject, OPS.constructPath]) expect(fnArray).not.toContain(painted);
  });

  it("writes a space after a word that has one, for the readers that look for it between words", async () => {
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const out = await embed(await blank(1), [[1, [word("one ", 72, 700, 40, 12, { width: 50 }), word("two", 122, 700, 40)]]]);
    const { fnArray, argsArray } = await (await (await openPdf(out)).getPage(1)).getOperatorList();
    const shown = fnArray.flatMap((fn, i) => {
      if (fn !== OPS.showText) return [];
      return [(argsArray[i][0] as ({ unicode?: string } | number)[]).map((glyph) => (typeof glyph === "number" ? "" : glyph.unicode)).join("")];
    });
    expect(shown).toEqual(["one", " ", "two"]);
  });

  it("keeps the direction of a line that runs up the page", async () => {
    const out = await embed(await blank(1), [[1, [word("upwards", 300, 200, 90, 12, { transform: [0, 12, -12, 0, 300, 200] })]]]);
    const [item] = await textOn(out);
    expect(item.str).toBe("upwards");
    expect(item.transform[0]).toBeCloseTo(0, 3);
    expect(item.transform[1]).toBeGreaterThan(0);
    expect(item.transform[2]).toBeLessThan(0);
    expect(item.transform.slice(4)).toEqual([300, 200]);
  });

  it("leaves the page's own text where it was, with the recognized words beside it", async () => {
    const bytes = await blank(1, async (doc) => {
      doc.getPage(0).drawText("Typed stamp", { x: 50, y: 100, size: 10, font: await doc.embedFont(StandardFonts.Courier) });
    });
    const out = await embed(bytes, [[1, [word("scanned", 72, 700, 70)]]]);
    expect((await textOn(out)).map((i) => i.str).sort()).toEqual(["Typed stamp", "scanned"]);
  });

  it("leaves pages without recognized words alone", async () => {
    const bytes = await blank(3, async (doc) => {
      doc.getPage(1).drawText("Page two is typed", { x: 50, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    });
    const out = await embed(bytes, [[1, [word("one", 72, 700, 40)]], [2, []], [3, [word("three", 72, 700, 50)]]]);
    expect(flat(await textOn(out, 1))).toBe("one");
    expect(flat(await textOn(out, 2))).toBe("Page two is typed");
    expect(flat(await textOn(out, 3))).toBe("three");
  });

  it("keeps the text in place when the page's own drawing leaves a transform applied", async () => {
    const bytes = await blank(1, (doc) => {
      // Some scanners write "scale and move" without ever restoring it.
      const stream = doc.context.stream("2 0 0 2 300 300 cm\n0 0 50 50 re f\n");
      doc.getPage(0).node.set(PDFName.of("Contents"), doc.context.register(stream));
    });
    const [item] = await textOn(await embed(bytes, [[1, [word("steady", 72, 700, 60)]]]));
    expect(item.transform.slice(4)).toEqual([72, 700]);
    expect(item.width).toBeCloseTo(60, 0);
  });

  it("works on a page that takes its resources from the page tree", async () => {
    const bytes = await blank(1, (doc) => {
      const page = doc.getPage(0);
      const resources = page.node.get(PDFName.of("Resources"));
      page.node.delete(PDFName.of("Resources"));
      doc.catalog.Pages().set(PDFName.of("Resources"), resources!);
    });
    expect(flat(await textOn(await embed(bytes, [[1, [word("inherited", 72, 700, 80)]]])))).toBe("inherited");
  });

  it("writes what the font can't as the nearest plain text, rather than failing the save", async () => {
    const out = await embed(await blank(1), [[1, [word("naïve ≥ ﬁx →", 72, 700, 150)]]]);
    expect(flat(await textOn(out))).toBe("naïve ? fix ?");
  });

  it("skips words it can't place, and adds no font to a page with none", async () => {
    const out = await embed(await blank(2), [[1, [word("", 72, 700, 40), word("flat", 72, 650, 0)]], [2, [word("ok", 72, 700, 20)]]]);
    expect(await textOn(out, 1)).toEqual([]);
    const reloaded = await PDFDocument.load(out);
    const fonts = (n: number) => String(reloaded.getPage(n).node.Resources()?.lookup(PDFName.of("Font")));
    expect(fonts(0)).not.toContain("FolioOcr");
    expect(fonts(1)).toContain("FolioOcr");
  });

  it("ignores pages the document doesn't have", async () => {
    const out = await embed(await blank(2), [[0, [word("zero", 72, 700, 40)]], [3, [word("three", 72, 700, 40)]], [2, [word("two", 72, 700, 40)]]]);
    expect(flat(await textOn(out, 2))).toBe("two");
  });

  it("does not use up the file's size: the font is one of the standard ones that readers already have", async () => {
    const bytes = await blank(1);
    const out = await embed(bytes, [[1, [word("one", 72, 700, 40), word("two", 120, 700, 40)]]]);
    expect(out.length - bytes.length).toBeLessThan(3000);
  });

  it("does not change the bytes it was given", async () => {
    const bytes = await blank(1);
    const before = bytes.slice();
    await embed(bytes, [[1, [word("one", 72, 700, 40)]]]);
    expect(bytes).toEqual(before);
  });

  it("records which pages have recognized text, including any a copy already had", async () => {
    const out = await embed(await blank(6), [[1, [word("a", 72, 700, 10)]], [2, []], [3, [word("c", 72, 700, 10)]]], [5]);
    const { info } = await (await openPdf(out)).getMetadata();
    // pdf.js hands the document info's own entries over as a Map.
    expect((info as { Custom: Map<string, string> }).Custom.get("FolioOcrPages")).toBe("1-3,5");
  });

  it("keeps the document's own details, and adds the record to a file that had none", async () => {
    const withInfo = await blank(1, (doc) => { doc.setTitle("Contract"); doc.setProducer("Scanner 9000"); });
    const { info } = await (await openPdf(await embed(withInfo, [[1, [word("a", 72, 700, 10)]]]))).getMetadata();
    expect(info).toMatchObject({ Title: "Contract", Producer: "Scanner 9000" });

    const withoutInfo = await blank(1, (doc) => { doc.context.trailerInfo.Info = undefined; });
    const meta = await (await openPdf(await embed(withoutInfo, [[1, [word("a", 72, 700, 10)]]]))).getMetadata();
    expect((meta.info as { Custom: Map<string, string> }).Custom.get("FolioOcrPages")).toBe("1");
  });

  it("keeps notes and highlights saved with pdf.js", async () => {
    const pdf = await openPdf(await blank(1));
    pdf.annotationStorage.setValue("pdfjs_internal_editor_0", {
      annotationType: 15, color: [255, 0, 0], thickness: 4, opacity: 1, pageIndex: 0, rect: [90, 90, 210, 130], rotation: 0, structTreeParentId: null,
      paths: { lines: [[100, 100, 150, 120, 200, 100]], points: [[100, 100, 150, 120, 200, 100]] },
    });
    const saved = await pdf.saveDocument();
    const out = await embed(saved, [[1, [word("kept", 72, 700, 40)]]]);
    const page = await (await openPdf(out)).getPage(1);
    expect((await page.getAnnotations()).map((a: { subtype: string }) => a.subtype)).toEqual(["Ink"]);
    expect(flat(await textOn(out))).toBe("kept");
  });

  it("refuses an encrypted file rather than writing something readers can't open", async () => {
    const bytes = await blank(1, (doc) => { doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard" })); });
    await expect(embed(bytes, [[1, [word("a", 72, 700, 10)]]])).rejects.toThrow(/encrypted/);
  });

  it.each([{ kind: "needs a password", bytes: protectedWithPassword }, { kind: "only has an owner password", bytes: protectedByOwner }])(
    "refuses a real encrypted file that $kind", async ({ bytes }) => {
      await expect(embed(bytes, [[1, [word("a", 72, 700, 10)]]])).rejects.toThrow(/encrypted/);
    });

  it("fails, rather than saving a broken file, when the bytes aren't a PDF", async () => {
    await expect(embed(new Uint8Array([1, 2, 3]), [[1, [word("a", 72, 700, 10)]]])).rejects.toThrow();
  });
});
