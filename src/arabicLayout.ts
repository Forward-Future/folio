import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import { beginText, endText, PDFDocument, PDFHexString, setFontAndSize, setFillingRgbColor, setTextMatrix, showText } from "pdf-lib/es";
import regular from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import boldFont from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf?url";

const bidi = bidiFactory();
const fonts = new Map<string, Promise<Uint8Array>>();

function fontBytes(url: string) {
  let promise = fonts.get(url);
  if (!promise) {
    promise = fetch(url).then(async response => {
      if (!response.ok) throw new Error("Couldn't load the font for Arabic editing.");
      return new Uint8Array(await response.arrayBuffer());
    }).catch(error => { fonts.delete(url); throw error; });
    fonts.set(url, promise);
  }
  return promise;
}

// Resolve the paragraph's directional runs before shaping each run in its own reading order.
// This keeps a number or Latin word together inside an Arabic sentence.
function visualRuns(text: string) {
  const levels = bidi.getEmbeddingLevels(text);
  const starts = new Int32Array(text.length);
  const runs: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (end < text.length && levels.levels[end] === levels.levels[start]) end++;
    starts.fill(runs.length, start, end);
    runs.push(text.slice(start, end));
    start = end;
  }
  const order = new Set(bidi.getReorderedIndices(text, levels).map(index => starts[index]));
  return Array.from(order, index => runs[index]);
}

export async function arabicLine(text: string, size: number, bold: boolean, color: number[]) {
  const data = await fontBytes(bold ? boldFont : regular);
  const face = fontkit.create(data);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const embedded = await pdf.embedFont(data, { subset: true });
  const scale = size / face.unitsPerEm;
  const baseline = -face.descent * scale;
  const height = (face.ascent - face.descent) * scale;
  const page = pdf.addPage([1, height]);
  const resource = page.node.newFontDictionary("Arabic", embedded.ref);
  page.pushOperators(beginText(), setFontAndSize(resource, size), setFillingRgbColor(color[0]/255, color[1]/255, color[2]/255));
  let x = 0;
  for (const run of visualRuns(text)) {
    const layout = face.layout(run);
    const encoded = embedded.encodeText(run).asString();
    for (let i = 0; i < layout.glyphs.length; i++) {
      if (layout.glyphs[i].id === 0) throw new Error("This font can't display all of those characters.");
      const p = layout.positions[i];
      page.pushOperators(setTextMatrix(1, 0, 0, 1, x + p.xOffset*scale, baseline + p.yOffset*scale),
        showText(PDFHexString.of(encoded.slice(i*4, i*4+4))));
      x += p.xAdvance * scale;
    }
  }
  page.pushOperators(endText());
  const width = Math.max(x, 0.1);
  page.setSize(width, height);
  return { bytes: await pdf.save({ useObjectStreams: false }), width, baseline };
}
