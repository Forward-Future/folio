import { AnnotationEditorType } from "pdfjs-dist";
import type { PDFDocumentProxy } from "./pdf";
import type { PDFViewer } from "./viewer";
import { printedSignatureTargets } from "./printedSignatureLines";

export interface SignatureImage { url: string; width: number; height: number }
export interface SavedSignature extends SignatureImage { key: string; name: string }
export interface SignatureTarget { id: string; label: string; rect: number[]; kind: "field" | "line" | "label" }
const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<SignatureTarget[]>>>();

export function uncoveredTargets(targets: SignatureTarget[], stamps: number[][]) {
  return targets.filter(({ rect }) => !stamps.some(stamp =>
    stamp[0] < rect[2] && stamp[2] > rect[0] && stamp[1] < rect[3] && stamp[3] > rect[1]));
}

export async function detectSignatureTargets(pdf: PDFDocumentProxy, pageNumber: number) {
  let pages = cache.get(pdf);
  if (!pages) cache.set(pdf, pages = new Map());
  let result = pages.get(pageNumber);
  if (!result) {
    result = (async (): Promise<SignatureTarget[]> => {
      const page = await pdf.getPage(pageNumber);
      const annotations = await page.getAnnotations();
      const signedFields = await pdf.getSignatures();
      if (signedFields?.length) return [];
      const stamps = annotations.filter(annotation => annotation.subtype === "Stamp" && annotation.rect?.length === 4)
        .map(annotation => annotation.rect);
      const fields: SignatureTarget[] = annotations.filter(annotation => annotation.subtype === "Widget"
        && annotation.fieldType === "Sig" && !annotation.fieldValue && !(annotation.fieldFlags & 1)
        && !(annotation.annotationFlags & 35) && annotation.rect.length === 4 && annotation.rect.every(Number.isFinite))
        .map((annotation): SignatureTarget => ({ id: annotation.id, label: annotation.alternativeText || annotation.fieldName || "Signature field",
          rect: [Math.max(page.view[0], annotation.rect[0]), Math.max(page.view[1], annotation.rect[1]),
            Math.min(page.view[2], annotation.rect[2]), Math.min(page.view[3], annotation.rect[3])], kind: "field" }))
        .filter(target => target.rect[2] - target.rect[0] > 4 && target.rect[3] - target.rect[1] > 4);
      // A printed caption for a native control must never create a second hit area, including over a locked field.
      const widgets = annotations.filter(annotation => annotation.subtype === "Widget" && annotation.rect?.length === 4);
      const printed = await printedSignatureTargets(page).catch(() => []);
      const clear = uncoveredTargets(printed, [...stamps, ...widgets.map(widget => widget.rect)]);
      return [...uncoveredTargets(fields, stamps), ...clear.filter(target => !fields.length || target.kind === "line")];
    })();
    pages.set(pageNumber, result);
    result.catch(() => pages!.delete(pageNumber));
  }
  return result;
}

export function fitSignature(signature: SignatureImage, bounds: number[]) {
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];
  const factor = Math.min(width / signature.width, height / signature.height);
  const fittedWidth = signature.width * factor;
  const fittedHeight = signature.height * factor;
  const positionX = bounds[0] + (width - fittedWidth) / 2;
  const positionY = bounds[1] + (height - fittedHeight) / 2;
  return [positionX, positionY, positionX + fittedWidth, positionY + fittedHeight];
}

export function positionSignature(signature: SignatureImage, size: number, center: number[], viewBox: number[]) {
  const [left, bottom, right, top] = viewBox;
  const width = Math.min(size, right - left, (top - bottom) * signature.width / signature.height);
  const height = width * signature.height / signature.width;
  const x = Math.max(left, Math.min(right - width, center[0] - width / 2));
  const y = Math.max(bottom, Math.min(top - height, center[1] - height / 2));
  return [x, y, x + width, y + height];
}

export async function placeSignature(viewer: PDFViewer, pdf: PDFDocumentProxy, pageNumber: number, signature: SignatureImage, rect: number[], navigate = true) {
  if (viewer.pdfDocument !== pdf) throw new Error("The document changed. Open Sign again.");
  if (navigate) viewer.currentPageNumber = pageNumber;
  viewer.annotationEditorMode = { mode: AnnotationEditorType.STAMP };
  try {
    let layer;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (viewer.pdfDocument !== pdf) throw new Error("The document changed.");
      layer = viewer.getPageView(pageNumber - 1)?.annotationEditorLayer?.annotationEditorLayer;
      if (layer) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!layer) throw new Error("The page isn't ready for signatures. Please try again.");
    const { pageX, pageY } = layer.viewport.rawDims;
    const localRect = rect.map((coordinate, index) => coordinate - (index % 2 === 0 ? pageX : pageY));
    const editor = await layer.deserialize({ annotationType: AnnotationEditorType.STAMP, pageIndex: pageNumber - 1,
      rect: localRect, rotation: 0, bitmapUrl: signature.url, isSvg: false,
      accessibilityData: { decorative: false, altText: "Handwritten signature" } });
    if (!editor || viewer.pdfDocument !== pdf) throw new Error("Couldn't add the signature to this document.");
    layer.add(editor);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (editor.div?.querySelector("canvas")) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    editor.remove();
    throw new Error("Couldn't load the signature image. Please try again.");
  } finally {
    if (viewer.pdfDocument === pdf) viewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
  }
}

export function cleanSignature(source: HTMLCanvasElement, crop: number[], threshold: number): SignatureImage {
  const canvas = document.createElement("canvas");
  const factor = Math.min(1, 1200 / crop[2], 600 / crop[3]);
  canvas.width = Math.max(1, Math.round(crop[2] * factor));
  canvas.height = Math.max(1, Math.round(crop[3] * factor));
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, ...crop as [number, number, number, number], 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const brightness = Math.min(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
    const opacity = image.data[offset + 3] / 255 * Math.min(255, Math.max(0, (threshold - brightness) * 4));
    image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 25;
    image.data[offset + 3] = opacity;
    if (opacity > 40) {
      const pixelX = offset / 4 % canvas.width, pixelY = Math.floor(offset / 4 / canvas.width);
      left = Math.min(left, pixelX); right = Math.max(right, pixelX); top = Math.min(top, pixelY); bottom = Math.max(bottom, pixelY);
    }
  }
  if (right - left < 8 || bottom - top < 3) throw new Error("No signature found. Crop closer or increase ink sensitivity.");
  context.putImageData(image, 0, 0);
  const trimmed = document.createElement("canvas");
  trimmed.width = right - left + 9; trimmed.height = bottom - top + 9;
  trimmed.getContext("2d")!.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, 4, 4, right - left + 1, bottom - top + 1);
  return { url: trimmed.toDataURL("image/png"), width: trimmed.width, height: trimmed.height };
}

const signatureKey = "folio:signature";

function readSavedSignature(key: string): SavedSignature | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    const name = key === signatureKey ? "Signature 1" : value?.name;
    return value && typeof value.url === "string" && value.url.startsWith("data:image/png;base64,")
      && value.url.length < 4000000 && Number.isFinite(value.width) && Number.isFinite(value.height)
      && value.width > 0 && value.height > 0 && typeof name === "string" && name.trim()
      ? { key, name, url: value.url, width: value.width, height: value.height } : null;
  } catch { return null; }
}

export function readSignatures(): SavedSignature[] {
  const signatures: SavedSignature[] = [];
  try {
    // Keep the original single signature in place. Each new image has its own key so tabs can save independently.
    for (const key of Object.keys(localStorage)) {
      if (key !== signatureKey && !key.startsWith(signatureKey + ":")) continue;
      const signature = readSavedSignature(key);
      if (signature) signatures.push(signature);
    }
  } catch { /* Signing still works when storage is unavailable. */ }
  return signatures.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function nextSignatureName(signatures: SavedSignature[]) {
  let number = 1;
  while (signatures.some(signature => signature.name === "Signature " + number)) number++;
  return "Signature " + number;
}

export function rememberSignature(image: SignatureImage, name: string) {
  const signatures = readSignatures();
  if (signatures.some(signature => signature.url === image.url)) return;
  localStorage.setItem(signatureKey + ":" + crypto.randomUUID(), JSON.stringify({
    ...image, name: name.trim() || nextSignatureName(signatures),
  }));
}
