// Recognized text in a saved copy: the words go in as an invisible text layer on top of each scanned page, the way
// OCR tools produce searchable PDFs, so any PDF reader can search and select them. pdf-lib is loaded only when a copy
// with recognized text is saved.
import type { TextItem } from "../types";
import { formatPages, PAGES_KEY } from "./pageList";
import { placeWords } from "./placeWords";

/** The name the text's font goes by in each page's resources. */
const FONT_TAG = "FolioOcr";

/**
 * Returns `bytes` with the words of `pages` (page number to recognized text items) laid invisibly over those pages.
 * `embedded` lists pages that already carry text from an earlier copy, so the list the copy records stays complete.
 *
 * The file is rewritten, not appended to, so anything that depends on its exact bytes (a digital signature) would
 * stop being valid, and an encrypted file can't be read at all: the caller checks for both first (see copyWithText).
 */
export async function embedRecognizedText(bytes: Uint8Array, pages: ReadonlyMap<number, unknown[]>, embedded: ReadonlySet<number>): Promise<Uint8Array> {
  const lib = await import("pdf-lib");
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(lib.StandardFonts.Helvetica);
  const supported = new Set(font.getCharacterSet());
  const widthOfEm = (text: string) => font.widthOfTextAtSize(text, 1);
  const space = font.encodeText(" ");

  for (const [n, items] of pages) {
    if (n < 1 || n > doc.getPageCount()) continue;
    const runs = placeWords(items as TextItem[], widthOfEm, supported);
    if (!runs.length) continue;
    const page = doc.getPage(n - 1);
    const operators = [
      lib.pushGraphicsState(), lib.beginText(),
      lib.setTextRenderingMode(lib.TextRenderingMode.Invisible),
      lib.setFontAndSize(page.node.newFontDictionary(FONT_TAG, font.ref), 1),
    ];
    for (const run of runs) {
      const [a, b, c, d, e, f] = run.matrix;
      operators.push(lib.setTextMatrix(a, b, c, d, e, f), lib.setCharacterSqueeze(run.squeeze), lib.showText(font.encodeText(run.text)));
      if (run.gap !== undefined) operators.push(lib.setCharacterSqueeze(run.gap), lib.showText(space));
    }
    // pdf-lib wraps what the page already draws in a save/restore pair first, so a scanner that left a transform
    // applied can't move the text.
    page.pushOperators(...operators, lib.endText(), lib.popGraphicsState());
  }

  // Which pages have recognized text, so Folio doesn't offer to read them again when the copy is opened.
  const { context } = doc;
  let info = context.lookupMaybe(context.trailerInfo.Info, lib.PDFDict);
  if (!info) {
    info = context.obj({});
    context.trailerInfo.Info = context.register(info);
  }
  info.set(lib.PDFName.of(PAGES_KEY), lib.PDFString.of(formatPages([...pages.keys(), ...embedded])));
  return doc.save();
}
