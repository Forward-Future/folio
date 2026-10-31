// Shared shapes for text recognition.

/** A pdf.js text item, as produced by PDFPageProxy.streamTextContent. */
export interface TextItem {
  str: string;
  dir: "ltr";
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  /** Recognized words only: the width of the word's own ink, before `width` was stretched over the gap that follows it. */
  inkWidth?: number;
}

/** Left, bottom, right, top in page space. */
export type Box = [number, number, number, number];

export interface OcrState {
  phase: "idle" | "offer" | "running" | "done" | "error";
  /** Pages looked at so far, out of `total`. */
  done: number;
  total: number;
  error?: string;
}
