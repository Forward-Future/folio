// @vitest-environment jsdom
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { findControllerFor, openPdf } from "../../testing/pdfjs";
import { pageText, snippetAt, type TextPiece } from "./snippet";

const piece = (str: string, hasEOL = false): TextPiece => ({ str, hasEOL });

describe("pageText", () => {
  it("joins items with nothing between them, so offsets match what pdf.js find reports", () => {
    expect(pageText([piece("Hel"), piece("lo "), piece("world")]).text).toBe("Hello world");
  });

  it("puts a space where a line ends", () => {
    const { text, breaks } = pageText([piece("our identification.", true), piece("Invoice number")]);
    expect(text).toBe("our identification. Invoice number");
    // The space goes after the 19th character of the text pdf.js find sees.
    expect(breaks).toEqual([19]);
  });

  it("does not add a second space when the line already ends or starts with one", () => {
    expect(pageText([piece("one ", true), piece("two")]).text).toBe("one two");
    expect(pageText([piece("one", true), piece(" two")]).text).toBe("one two");
    expect(pageText([piece("one ", true), piece(" two")]).breaks).toEqual([]);
  });

  it("adds one space for a run of blank line-end items", () => {
    const { text, breaks } = pageText([piece("one", true), piece("", true), piece("", true), piece("two")]);
    expect(text).toBe("one two");
    expect(breaks).toEqual([3]);
  });

  it("adds nothing at the start or end of the page", () => {
    expect(pageText([piece("", true), piece("first"), piece("last", true)]).text).toBe("firstlast");
    expect(pageText([piece("only", true)])).toEqual({ text: "only", breaks: [] });
    expect(pageText([])).toEqual({ text: "", breaks: [] });
  });

  it("copes with marked-content markers, which carry no text", () => {
    expect(pageText([{}, piece("a", true), {}, piece("b")]).text).toBe("a b");
  });
});

describe("snippetAt", () => {
  const plain = pageText([piece("The quick brown fox jumps over the lazy dog")]);

  it("returns the match with the text on either side", () => {
    expect(snippetAt(plain, 10, 5)).toEqual({ before: "The quick ", match: "brown", after: " fox jumps over the lazy dog" });
  });

  it("marks where the text was cut", () => {
    const long = pageText([piece("a".repeat(60) + "MATCH" + "b".repeat(120))]);
    const snippet = snippetAt(long, 60, 5);
    expect(snippet.before).toBe("..." + "a".repeat(55));
    expect(snippet.match).toBe("MATCH");
    expect(snippet.after).toBe("b".repeat(100) + "...");
  });

  it("does not mark a cut when the text is short", () => {
    const snippet = snippetAt(pageText([piece("x".repeat(55) + "M" + "y".repeat(100))]), 55, 1);
    expect(snippet.before).toBe("x".repeat(55));
    expect(snippet.after).toBe("y".repeat(100));
  });

  it("keeps a space added before the match out of it", () => {
    const page = pageText([piece("identification.", true), piece("Invoice")]);
    expect(snippetAt(page, 15, 7)).toEqual({ before: "identification. ", match: "Invoice", after: "" });
  });

  it("keeps a space added after the match out of it", () => {
    const page = pageText([piece("identification.", true), piece("Invoice")]);
    expect(snippetAt(page, 0, 15)).toEqual({ before: "", match: "identification.", after: " Invoice" });
  });

  it("keeps a space inside the match when the match runs over a line end", () => {
    const page = pageText([piece("alpha beta", true), piece("gamma delta")]);
    expect(snippetAt(page, 6, 9)).toEqual({ before: "alpha ", match: "beta gamma", after: " delta" });
  });

  it("finds a match after several line ends", () => {
    const page = pageText([piece("one", true), piece("two", true), piece("three", true), piece("four")]);
    expect(page.text).toBe("one two three four");
    expect(snippetAt(page, 11, 4).match).toBe("four");
    expect(snippetAt(page, 3, 3).match).toBe("two");
  });
});

describe("against pdf.js find", () => {
  const lines = ["alpha beta gamma", "delta epsilon", "zeta eta theta", "iota kappa lambda", "mu nu xi omicron"];

  async function search(query: string) {
    const bytes = await (async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 400]);
      lines.forEach((line, i) => page.drawText(line, { x: 20, y: 350 - i * 30, size: 14, font }));
      return doc.save();
    })();
    const pdf = await openPdf(bytes);
    const { controller, eventBus } = await findControllerFor(pdf);
    await new Promise<void>((resolve) => {
      eventBus.on("updatefindmatchescount", () => resolve());
      eventBus.dispatch("find", { source: null, type: "", query, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
    });
    const content = await (await pdf.getPage(1)).getTextContent({ disableNormalization: true });
    const text = pageText(content.items as TextPiece[]);
    return { text, offset: controller.pageMatches![0][0] as number, length: controller.pageMatchesLength![0][0] as number };
  }

  // The shift this guards against is one character per line end before the match, so a match on a late line shows it.
  it.each(["gamma", "epsilon", "theta", "lambda", "omicron"])("shows %s exactly, wherever it is on the page", async (query) => {
    const { text, offset, length } = await search(query);
    expect(snippetAt(text, offset, length).match).toBe(query);
  });

  it("shows a match that runs over a line end with the space between its words", async () => {
    const { text, offset, length } = await search("gamma delta");
    const snippet = snippetAt(text, offset, length);
    expect(snippet.match).toBe("gamma delta");
    expect(snippet.before).toBe("alpha beta ");
    expect(snippet.after).toBe(" epsilon zeta eta theta iota kappa lambda mu nu xi omicron");
  });
});
