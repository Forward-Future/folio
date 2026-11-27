import { arabicLine } from "./arabicLayout";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { checkPdfSize } from "./pdfInput";
import { replacePageImage, insertPageImage } from "./pdfImageEdit";
import { isArabicText, unsupportedDirection, RIGHT_TO_LEFT_MESSAGE } from "./textDirection";

export interface EditTarget {
  index: number;
  end: number;
  ordinal?: number;
  fitted?: { width: number; baseline: number };
  kind: "text" | "image";
  label: string;
  /** Unrotated PDF coordinates, shared with pdf.js's page viewport. */
  box: number[];
  style?: { matrix?: number[]; anchor?: number[]; origin: number[]; axis: number[]; size: number; flags: number; bold: boolean; color: string };
}
export type Change = { kind: "text"; index: number; text: string } | { kind: "image"; index: number; file: File }
  | { kind: "insertImage"; file: File; box: number[]; rotation: number };
export type EditorRequest = { rotations: number[]; snapshot: Uint8Array; password?: string }
  | { source: Uint8Array } | { page: number } | { page: number; change: Change; snapshot: Uint8Array };
export type EditorReply = { page: number; targets: EditTarget[] } | { bytes: Uint8Array } | { error: string; page?: number };

const ready = (async () => {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error("Couldn't load the PDF editor.");
  const engine = await init({ wasmBinary: await response.arrayBuffer() });
  engine.PDFiumExt_Init();
  return engine;
})();
let source: Uint8Array;

function buffer<T>(m: WrappedPdfiumModule, size: number, use: (ptr: number) => T): T {
  const ptr = m.pdfium.wasmExports.malloc(size);
  if (!ptr) throw new Error("There isn't enough memory to edit this PDF.");
  try { return use(ptr); } finally { m.pdfium.wasmExports.free(ptr); }
}

async function withDocument<T>(m: WrappedPdfiumModule, bytes: Uint8Array, password: string, use: (doc: number) => T | Promise<T>) {
  const ptr = m.pdfium.wasmExports.malloc(bytes.length);
  if (!ptr) throw new Error("There isn't enough memory to edit this PDF.");
  try {
    m.pdfium.HEAPU8.set(bytes, ptr);
    const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, password);
    if (!doc) throw new Error("Couldn't open this PDF for editing.");
    try { return await use(doc); } finally { m.FPDF_CloseDocument(doc); }
  } finally { m.pdfium.wasmExports.free(ptr); }
}

async function withPage<T>(m: WrappedPdfiumModule, bytes: Uint8Array, number: number, use: (doc: number, page: number) => T | Promise<T>) {
  return withDocument(m, bytes, "", async doc => {
    if (m.EPDF_IsEncrypted(doc) || m.FPDF_GetSignatureCount(doc) > 0) throw new Error("Editing requires an unsigned, unencrypted PDF.");
    const page = m.FPDF_LoadPage(doc, number - 1);
    if (!page) throw new Error("Couldn't open this page.");
    try { return await use(doc, page); } finally { m.FPDF_ClosePage(page); }
  });
}

function markString(m: WrappedPdfiumModule, mark: number, key: string, scratch: number) {
  if (key === "ActualText" && m.FPDFPageObjMark_GetParamBlobValue(mark, key, 0, 0, scratch)) {
    const length = m.pdfium.HEAPU32[scratch/4];
    if (length > 1 && length <= 65536) {
      const unicode = buffer(m, length, out => {
        if (!m.FPDFPageObjMark_GetParamBlobValue(mark, key, out, length, scratch)) return "";
        const bytes = m.pdfium.HEAPU8.subarray(out, out+length);
        return bytes[0] === 0xfe && bytes[1] === 0xff ? new TextDecoder("utf-16be").decode(bytes) : "";
      });
      if (unicode) return unicode;
    }
  }
  if (!m.FPDFPageObjMark_GetParamStringValue(mark, key, 0, 0, scratch)) return "";
  const length = m.pdfium.HEAPU32[scratch/4];
  if (length < 2 || length > 131076) return "";
  return buffer(m, length, out => m.FPDFPageObjMark_GetParamStringValue(mark, key, out, length, scratch)
    ? m.pdfium.UTF16ToString(out) as string : "");
}

function lineForm(m: WrappedPdfiumModule, obj: number, index: number, box: number[], ptr: number): EditTarget | undefined {
  for (let i = 0; i < m.FPDFPageObj_CountMarks(obj); i++) {
    const mark = m.FPDFPageObj_GetMark(obj, i);
    const metadata = markString(m, mark, "FolioArabicLine", ptr);
    if (!metadata) continue;
    let data;
    try { data = JSON.parse(metadata); } catch { continue; }
    if (!Array.isArray(data) || data.length !== 7 || !data.every(Number.isFinite)) continue;
    const [size, baseline, width, bold, r, g, b] = data;
    const label = markString(m, mark, "ActualText", ptr);
    if (!label || size <= 0 || width <= 0 || !m.FPDFPageObj_GetMatrix(obj, ptr)) continue;
    const matrix = Array.from(m.pdfium.HEAPF32.subarray(ptr/4, ptr/4+6)) as number[];
    const [a,dy,c,d,x,y] = matrix;
    const origin = [x+c*baseline, y+d*baseline];
    return { index, end: index, kind: "text", box, label, fitted: { width, baseline },
      style: { matrix: [a,dy,c,d,...origin], origin, anchor: [origin[0]+a*width,origin[1]+dy*width], axis: [a,dy],
        size: size*Math.hypot(c,d), flags: 0, bold: !!bold, color: `rgb(${r} ${g} ${b})` } };
  }
}

function objectText(m: WrappedPdfiumModule, page: number) {
  const chars = new Map<number, { label: string; order: number }>();
  const textPage = m.FPDFText_LoadPage(page);
  if (!textPage) return chars;
  try {
    const count = m.FPDFText_CountChars(textPage);
    if (count > 200000) throw new Error("This page contains too much text to edit.");
    for (let i = 0; i < count; i++) {
      if (m.FPDFText_IsGenerated(textPage, i)) continue;
      const object = m.FPDFText_GetTextObject(textPage, i);
      const code = m.FPDFText_GetUnicode(textPage, i);
      if (!object || code <= 0 || code > 0x10ffff) continue;
      const entry = chars.get(object);
      if (entry) entry.label += String.fromCodePoint(code);
      else chars.set(object, { label: String.fromCodePoint(code), order: i });
    }
    return chars;
  } finally { m.FPDFText_ClosePage(textPage); }
}

function pageView(m: WrappedPdfiumModule, page: number) {
  const count = m.FPDFPage_CountObjects(page);
  if (count > 20000) throw new Error("This page has too many objects to edit.");
  const chars = objectText(m, page);
  const targets: EditTarget[] = [];
  let imageCount = 0;
  const pieces = new Map<EditTarget, { text: string; order: number; spaceBefore: boolean }[]>();
  buffer(m, 32, ptr => {
    let previous: { style: string; left: number; right: number; x: number; target: EditTarget } | undefined;
    for (let index = 0; index < count; index++) {
      const obj = m.FPDFPage_GetObject(page, index);
      const type = m.FPDFPageObj_GetType(obj);
      const ordinal = type === 3 ? imageCount++ : 0;
      if (type !== 1 && type !== 3 && type !== 5) continue;
      if (!m.FPDFPageObj_GetBounds(obj, ptr, ptr + 4, ptr + 8, ptr + 12)) continue;
      const [left, bottom, right, top] = m.pdfium.HEAPF32.subarray(ptr / 4, ptr / 4 + 4);
      const box = [left, bottom, right, top];
      if (type === 5) {
        const form = lineForm(m, obj, index, box, ptr);
        if (form) targets.push(form);
        continue;
      }
      if (type === 3) {
        if (box[2] > box[0] && box[3] > box[1]) targets.push({ index, end: index, ordinal, kind: "image", label: `Image ${ordinal + 1}`, box });
        continue;
      }
      const mode = m.FPDFTextObj_GetTextRenderMode(obj);
      const entry = chars.get(obj);
      let label = entry?.label;
      if (entry && label && isArabicText(label)) {
        // A ligature can map to multiple letters. Its tagged ActualText is already in reading order.
        for (let i = 0; i < m.FPDFPageObj_CountMarks(obj); i++) {
          const actual = markString(m, m.FPDFPageObj_GetMark(obj, i), "ActualText", ptr);
          if (actual && Array.from(actual.normalize("NFKC")).length === Array.from(label.normalize("NFKC")).length) {
            label = actual.normalize("NFKC"); break;
          }
        }
      }
      if (!entry || !label || mode < 0 || mode > 2) continue; // Omit invisible OCR and clipping text.
      if (!m.FPDFPageObj_GetMatrix(obj, ptr) || !m.FPDFTextObj_GetFontSize(obj, ptr + 24)) continue;
      const [a, b, c, d, x, y, size] = m.pdfium.HEAPF32.subarray(ptr / 4, ptr / 4 + 7);
      const color = (stroke: boolean) => {
        const get = stroke ? m.FPDFPageObj_GetStrokeColor : m.FPDFPageObj_GetFillColor;
        return get(obj, ptr, ptr + 4, ptr + 8, ptr + 12) ? m.pdfium.HEAP32.subarray(ptr / 4, ptr / 4 + 4).join(",") : null;
      };
      const fill = mode === 1 ? "" : color(false), stroke = mode === 0 ? "" : color(true);
      const style = [m.FPDFTextObj_GetFont(obj), size, a, b, c, d, y, fill, stroke, mode, m.FPDFPageObj_GetMarkedContentID(obj)].join("/");
      const backwards = previous && x < previous.x && (isArabicText(label) || isArabicText(previous.target.label));
      const gap = !previous ? 0 : backwards ? previous.left - right : x - previous.right;
      const em = size * a;
      // Many PDFs position each glyph separately. Join consecutive, same-style runs on one horizontal baseline.
      if (previous && previous.target.end === index - 1 && previous.style === style && fill !== null && stroke !== null
        && a > 0 && b === 0 && c === 0 && d > 0 && (x > previous.x || backwards) && gap >= -0.25 * em && gap < 0.65 * em) {
        const target = previous.target;
        const space = gap > 0.16 * em && !/\s$/.test(target.label) && !/^\s/.test(label);
        target.label += (space ? " " : "") + label;
        pieces.get(target)!.push({ text: label, order: entry.order, spaceBefore: space });
        target.end = index;
        target.box = [Math.min(target.box[0], box[0]), Math.min(target.box[1], box[1]),
          Math.max(target.box[2], box[2]), Math.max(target.box[3], box[3])];
        previous.left = left; previous.right = right; previous.x = x;
      } else {
        const font = m.FPDFTextObj_GetFont(obj);
        const ink = (fill || stroke || "0,0,0,255").split(",").slice(0, 3);
        const target: EditTarget = { index, end: index, kind: "text", label, box,
          style: { matrix: [a,b,c,d,x,y], origin: [x, y], axis: [a, b], size: size * Math.hypot(c, d), flags: m.FPDFFont_GetFlags(font),
            bold: m.FPDFFont_GetWeight(font) >= 600, color: `rgb(${ink.join(" ")})` } };
        targets.push(target);
        pieces.set(target, [{ text: label, order: entry.order, spaceBefore: false }]);
        previous = { target, style, left, right, x };
      }
    }
  });

  for (const [target, parts] of pieces) {
    if (!isArabicText(target.label)) continue;
    // PDFium enumerates characters in reading order, but page objects are often painted left to right.
    const logical = parts.map((part, i) => ({ ...part, i })).sort((a,b) => a.order-b.order);
    target.label = logical.map((part,i) => {
      const prev = logical[i-1];
      const gap = prev && Math.abs(prev.i-part.i) === 1 && parts[Math.max(prev.i,part.i)].spaceBefore
        && !/\s$/.test(prev.text) && !/^\s/.test(part.text);
      return (gap ? " " : "") + part.text;
    }).join("").normalize("NFKC");
    const style = target.style!, [a,b,c,d,x,y] = style.matrix!;
    const det = a*d-b*c;
    if (!det) continue;
    const [l,lo,r,hi] = target.box;
    const width = Math.max(...[[l,lo],[l,hi],[r,lo],[r,hi]].map(([px,py]) => ((px-x)*d-(py-y)*c)/det));
    style.anchor = [x+a*width,y+b*width];
  }
  return { targets: targets.filter(t => t.label.trim() && t.box[2] > t.box[0] && t.box[3] > t.box[1]), imageCount };
}

function save(m: WrappedPdfiumModule, doc: number) {
  const writer = m.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error("Couldn't create an edited copy.");
  try {
    if (!m.FPDF_SaveAsCopy(doc, writer, 2)) throw new Error("Couldn't write the edited PDF.");
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    checkPdfSize(size);
    return buffer(m, size, ptr => {
      if (m.PDFiumExt_GetFileWriterData(writer, ptr, size) !== size) throw new Error("Couldn't read the edited PDF.");
      return (m.pdfium.HEAPU8 as Uint8Array).slice(ptr, ptr + size);
    });
  } finally { m.PDFiumExt_CloseFileWriter(writer); }
}

// Keep the shaped glyphs together as a vector form, in the original object's stacking position.
// The standard ActualText entry preserves the logical string, including marks and ligatures.
async function replaceArabic(m: WrappedPdfiumModule, doc: number, page: number, target: EditTarget, text: string) {
  if (text.length > 32767 || /[\u0000-\u001f]/u.test(text)) throw new Error("Enter a single line of text.");
  if (unsupportedDirection(target.label) || unsupportedDirection(text)) throw new Error(RIGHT_TO_LEFT_MESSAGE);
  const style = target.style!, [a,b,c,d,x,y] = style.matrix!;
  const size = style.size / Math.hypot(c,d);
  if (!Number.isFinite(size) || size <= 0 || a*d === b*c) throw new Error("Couldn't measure this text.");
  const color = style.color.match(/\d+/g)!.map(Number);
  const line = text ? await arabicLine(text, size, style.bold, color) : null;
  for (let i = target.end; i >= target.index; i--) {
    const fragment = m.FPDFPage_GetObject(page, i);
    if (!m.FPDFPage_RemoveObject(page, fragment)) throw new Error("Couldn't replace the full text run.");
    m.FPDFPageObj_Destroy(fragment);
  }
  if (!line) return;
  buffer(m, line.bytes.length, data => {
    m.pdfium.HEAPU8.set(line.bytes, data);
    const src = m.FPDF_LoadMemDocument(data, line.bytes.length, "");
    if (!src) throw new Error("Couldn't embed the edited text.");
    try {
      const imported = m.FPDF_NewXObjectFromPage(doc, src, 0);
      if (!imported) throw new Error("Couldn't embed the edited text.");
      try {
        const form = m.FPDF_NewFormObjectFromXObject(imported);
        if (!form) throw new Error("Couldn't create the edited text.");
        let inserted = false;
        try {
          const anchor = style.anchor;
          const left = anchor ? anchor[0]-a*line.width : x;
          const base = anchor ? anchor[1]-b*line.width : y;
          buffer(m, 24, ptr => {
            m.pdfium.HEAPF32.set([a,b,c,d,left-c*line.baseline,base-d*line.baseline], ptr/4);
            if (!m.FPDFPageObj_SetMatrix(form, ptr)) throw new Error("Couldn't place the edited text.");
          });
          const mark = m.FPDFPageObj_AddMark(form, "Span");
          const metadata = JSON.stringify([size, line.baseline, line.width, +style.bold, ...color]);
          const logical = new Uint8Array(2 + text.length*2);
          const view = new DataView(logical.buffer);
          view.setUint16(0, 0xfeff);
          for (let i = 0; i < text.length; i++) view.setUint16(2+i*2, text.charCodeAt(i));
          const tagged = mark && m.FPDFPageObjMark_SetStringParam(doc, form, mark, "FolioArabicLine", metadata)
            && buffer(m, logical.length, ptr => {
              m.pdfium.HEAPU8.set(logical,ptr);
              return m.FPDFPageObjMark_SetBlobParam(doc,form,mark,"ActualText",ptr,logical.length);
            });
          if (!tagged || !m.FPDFPage_InsertObjectAtIndex(page, form, target.index)) throw new Error("Couldn't insert the edited text.");
          inserted = true;
        } finally { if (!inserted) m.FPDFPageObj_Destroy(form); }
      } finally { m.FPDF_CloseXObject(imported); }
    } finally { m.FPDF_CloseDocument(src); }
  });
}

function replaceText(m: WrappedPdfiumModule, page: number, target: EditTarget, text: string) {
  const obj = m.FPDFPage_GetObject(page, target.index);
  if (m.FPDFPageObj_GetType(obj) !== 1 || text.length > 32767 || /[\u0000-\u001f]/u.test(text)) {
    throw new Error("Enter a single line of text.");
  }
  if (unsupportedDirection(target.label) || unsupportedDirection(text)) throw new Error(RIGHT_TO_LEFT_MESSAGE);
  const firstToRemove = text ? target.index + 1 : target.index;
  for (let i = target.end; i >= firstToRemove; i--) {
    const fragment = m.FPDFPage_GetObject(page, i);
    if (!m.FPDFPage_RemoveObject(page, fragment)) throw new Error("Couldn't replace the full text run.");
    m.FPDFPageObj_Destroy(fragment);
  }
  if (!text) return;
  const size = (text.length + 1) * 2;
  buffer(m, size, ptr => {
    m.pdfium.stringToUTF16(text, ptr, size);
    if (!m.FPDFText_SetText(obj, ptr)) throw new Error("Couldn't change this text.");
  });
  // Subset fonts can silently substitute a missing glyph. Read back the changed object before accepting it.
  if (objectText(m, page).get(obj)?.label !== text) throw new Error("This font can't display all of those characters.");
}

self.onmessage = async ({ data }: MessageEvent<EditorRequest>) => {
  if ("source" in data) { source = data.source; return; }
  try {
    const m = await ready;
    if ("rotations" in data) {
      const bytes = await withDocument(m, data.snapshot, data.password ?? "", doc => {
        for (const [index, degrees] of data.rotations.entries()) {
          if (!degrees) continue;
          const handle = m.FPDF_LoadPage(doc, index);
          if (!handle) throw new Error("Couldn't open the page to rotate.");
          try { m.FPDFPage_SetRotation(handle, (m.FPDFPage_GetRotation(handle) + degrees / 90) % 4); }
          finally { m.FPDF_ClosePage(handle); }
        }
        return save(m, doc);
      });
      self.postMessage({ bytes } satisfies EditorReply, { transfer: [bytes.buffer as ArrayBuffer] });
      return;
    }
    const { page } = data;
    if (!("change" in data)) {
      const { targets } = await withPage(m, source, page, (_doc, handle) => pageView(m, handle));
      self.postMessage({ page, targets } satisfies EditorReply);
      return;
    }
    const { change, snapshot } = data;
    const result = withPage(m, snapshot, page, async (doc, handle) => {
      if (change.kind === "insertImage") return insertPageImage(snapshot, page, change.file, change.box, change.rotation);
      const { targets, imageCount } = pageView(m, handle);
      const target = targets.find(t => t.index === change.index && t.kind === change.kind);
      if (!target) throw new Error("Select the item again.");
      if (change.kind === "image") return replacePageImage(snapshot, page, target.ordinal!, imageCount, change.file);
      if (target.fitted || isArabicText(target.label) || isArabicText(change.text)) await replaceArabic(m, doc, handle, target, change.text);
      else replaceText(m, handle, target, change.text);
      if (!m.FPDFPage_GenerateContent(handle)) throw new Error("Couldn't write this page.");
      return save(m, doc);
    });
    const bytes = await result;
    self.postMessage({ bytes } satisfies EditorReply, { transfer: [bytes.buffer as ArrayBuffer] });
  } catch (reason) {
    self.postMessage({ error: reason instanceof Error ? reason.message : "Couldn't edit this PDF.",
      page: "page" in data && !("change" in data) ? data.page : undefined } satisfies EditorReply);
  }
};
