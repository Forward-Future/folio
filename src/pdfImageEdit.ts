import { concatTransformationMatrix, popGraphicsState, pushGraphicsState, decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFObjectParser, PDFRawStream } from "pdf-lib/es";
import ByteStream from "pdf-lib/es/core/parser/ByteStream";
import { checkPdfSize, checkImageDimensions, checkImageFileSize } from "./pdfInput";

const name = PDFName.of;
const white = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const delimiter = (c: number) => white(c) || "()<>[]{}/%".includes(String.fromCharCode(c));
const MAX_CONTENT = 16 * 1024 * 1024;

// Read operands as PDF objects so a literal string, a comment or a marked-content dictionary
// containing "/Logo Do" cannot be mistaken for an image placement.
function imageOperands(bytes: Uint8Array, pdf: PDFDocument, resources: PDFDict) {
  const stream = ByteStream.of(bytes);
  const parser = PDFObjectParser.forByteStream(stream, pdf.context);
  const placements: { start: number; end: number }[] = [];
  let operand: { key: PDFName; start: number; end: number } | null = null;
  while (!stream.done()) {
    const c = stream.peek(), start = stream.offset();
    if (white(c)) { stream.next(); continue; }
    if (c === 37) {
      while (!stream.done() && stream.peek() !== 10 && stream.peek() !== 13) stream.next();
      continue;
    }
    if (c === 47 || c === 40 || c === 60 || c === 91) {
      const object = parser.parseObject();
      operand = object instanceof PDFName ? { key: object, start, end: stream.offset() } : null;
      continue;
    }
    if (delimiter(c)) throw new Error("Couldn't identify the image placement in this PDF.");
    while (!stream.done() && !delimiter(stream.peek())) stream.next();
    const token = stream.offset() - start < 4 ? String.fromCharCode(...bytes.subarray(start, stream.offset())) : "";
    if (token === "BI") throw new Error("Folio can't replace images on pages containing inline image data.");
    if (token === "Do" && operand) {
      const image = resources.lookup(operand.key);
      if (image instanceof PDFRawStream && image.dict.get(name("Subtype")) === name("Image")) placements.push(operand);
    }
    operand = null;
  }
  return placements;
}

// Browser image previews apply EXIF orientation. Keep the original JPEG bytes and reproduce
// that transform in the PDF so camera photos match the preview, including mirrored orientations.
function jpegOrientation(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 2; i+4 <= bytes.length && bytes[i] === 0xff;) {
    const marker = bytes[i+1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = v.getUint16(i+2), end = i+2+length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe1 && length >= 16 && v.getUint32(i+4) === 0x45786966 && v.getUint16(i+8) === 0) {
      const tiff = i+10, little = v.getUint16(tiff) === 0x4949;
      if (v.getUint16(tiff+2,little) !== 42) return 1;
      const dir = tiff+v.getUint32(tiff+4,little);
      if (dir+2 > end) return 1;
      const count = v.getUint16(dir,little);
      for (let n = 0, p = dir+2; n < count && p+12 <= end; n++, p+=12) {
        if (v.getUint16(p,little) === 0x112 && v.getUint16(p+2,little) === 3 && v.getUint32(p+4,little) === 1) {
          const value = v.getUint16(p+8,little);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
    }
    i = end;
  }
  return 1;
}

async function embedRaster(pdf: PDFDocument, file: File) {
  checkImageFileSize(file.size);
  const data = new Uint8Array(await file.arrayBuffer());
  let image, orientation = 1;
  if (data[0] === 0xff && data[1] === 0xd8) { image = await pdf.embedJpg(data); orientation = jpegOrientation(data); }
  else if (data.length >= 24 && new DataView(data.buffer).getUint32(0) === 0x89504e47) {
    const header = new DataView(data.buffer);
    checkImageDimensions(header.getUint32(16), header.getUint32(20));
    image = await pdf.embedPng(data);
  } else throw new Error("Choose a PNG or JPEG image.");
  checkImageDimensions(image.width, image.height);

  return { image, orientation };
}

type Matrix = [number, number, number, number, number, number];
const photoTransforms: Matrix[] = [
  [1,0,0,1,0,0], [-1,0,0,1,1,0], [-1,0,0,-1,1,1], [1,0,0,-1,0,1],
  [0,-1,-1,0,1,1], [0,-1,1,0,0,1], [0,1,1,0,0,0], [0,1,-1,0,1,0],
];

export async function insertPageImage(source: Uint8Array, number: number, file: File, box: number[], rotation: number) {
  const [l,b,r,t] = box, w = r-l, h = t-b;
  if (!box.every(Number.isFinite) || w <= 0 || h <= 0 || ![0,90,180,270].includes(rotation)) throw new Error("Choose a position on the page.");
  const pdf = await PDFDocument.load(source, { updateMetadata: false });
  const page = pdf.getPage(number-1);
  const { image, orientation } = await embedRaster(pdf, file);
  // Copies can share these dictionaries or an entire content-stream array between pages.
  const resources = page.node.Resources()?.clone() ?? pdf.context.obj({});
  const xObjects = resources.lookupMaybe(name("XObject"), PDFDict)?.clone() ?? pdf.context.obj({});
  resources.set(name("XObject"), xObjects);
  page.node.set(name("Resources"), resources);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) page.node.set(name("Contents"), contents.clone());
  const pageTransforms: Matrix[] = [[w,0,0,h,l,b], [0,h,-w,0,r,b], [-w,0,0,-h,r,t], [0,-h,w,0,l,t]];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...pageTransforms[rotation/90]),
    concatTransformationMatrix(...photoTransforms[orientation-1]));
  page.drawImage(image, { x: 0, y: 0, width: 1, height: 1 });
  page.pushOperators(popGraphicsState());
  const bytes = await pdf.save({ updateFieldAppearances: false });
  checkPdfSize(bytes.length);
  return bytes;
}

export async function replacePageImage(source: Uint8Array, pageNumber: number, ordinal: number, count: number, file: File) {
  const pdf = await PDFDocument.load(source, { updateMetadata: false });
  const page = pdf.getPage(pageNumber - 1).node;
  const resources = page.Resources()?.clone();
  const xObjects = resources?.lookupMaybe(name("XObject"), PDFDict)?.clone();
  if (!resources || !xObjects) throw new Error("Couldn't find an embedded image on this page.");
  const contents = page.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
  let size = 0;
  const parts = streams.map(s => {
    if (!(s instanceof PDFRawStream)) throw new Error("Couldn't read this page's image placements.");
    const part = decodePDFRawStream(s).getBytes(MAX_CONTENT - size + 1);
    size += part.length + 1;
    if (size > MAX_CONTENT) throw new Error("This page's drawing instructions are too large to edit.");
    return part;
  });
  const commands = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { commands.set(part, offset); offset += part.length; commands[offset++] = 10; }
  const placements = imageOperands(commands, pdf, xObjects);
  const place = placements[ordinal];
  if (placements.length !== count || !place) throw new Error("Couldn't identify this image placement reliably.");

  const { image } = await embedRaster(pdf, file);

  // Change only the chosen Do operand. This retains its clipping, tags, transforms and stacking order,
  // including when other pages share the original image, resources, or even the entire content stream.
  const key = xObjects.uniqueKey("FolioImage");
  xObjects.set(key, image.ref);
  resources.set(name("XObject"), xObjects);
  page.set(name("Resources"), resources);
  const keyBytes = new TextEncoder().encode(key.toString());
  offset = 0;
  const index = parts.findIndex(part => {
    if (place.start >= offset && place.end <= offset + part.length) return true;
    offset += part.length + 1;
    return false;
  });
  if (index < 0) throw new Error("This image placement crosses content streams.");
  const part = parts[index], start = place.start - offset, end = place.end - offset;
  const changed = new Uint8Array(part.length - (end - start) + keyBytes.length);
  changed.set(part.subarray(0, start));
  changed.set(keyBytes, start);
  changed.set(part.subarray(end), start + keyBytes.length);
  const ref = pdf.context.register(pdf.context.flateStream(changed));
  if (contents instanceof PDFArray) {
    const updated = contents.clone();
    updated.set(index, ref);
    page.set(name("Contents"), updated);
  } else page.set(name("Contents"), ref);
  const bytes = await pdf.save({ updateFieldAppearances: false });
  checkPdfSize(bytes.length);
  return bytes;
}
