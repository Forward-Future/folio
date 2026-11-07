export type PrintMode = "size" | "poster" | "multiple" | "booklet";
export type PrintSettings = {
  mode: PrintMode; sizing: "fit" | "actual" | "shrink" | "custom";
  scale: number; paper: "Letter" | "A4" | "Legal"; orientation: "auto" | "portrait" | "landscape";
  perSheet: number; grayscale: boolean; toner: boolean; dpi: 150 | 300 | 600; overlapPoints: number;
};
export type PageSize = { width: number; height: number };
export type Placement = { page: number; x: number; y: number; width: number; height: number; scale: number;
  clip: { x: number; y: number; width: number; height: number } };
export type PrintSheet = PageSize & { placements: Placement[] };
export const PAPER = { Letter: { width: 612, height: 792 }, A4: { width: 595.28, height: 841.89 }, Legal: { width: 612, height: 1008 } };
export const DEFAULT_PRINT: PrintSettings = { mode: "size", sizing: "fit", scale: 100, paper: "Letter", orientation: "auto",
  perSheet: 2, grayscale: false, toner: false, dpi: 150, overlapPoints: 18 };

export type OverlapUnit = "in" | "mm";
export const overlapToPoints = (value: number, unit: OverlapUnit) => value * 72 / (unit === "mm" ? 25.4 : 1);
export const overlapFromPoints = (points: number, unit: OverlapUnit) => points / 72 * (unit === "mm" ? 25.4 : 1);
export const MAX_PRINT_PIXELS = 48_000_000;
export const MAX_PRINT_DECODED_BYTES = 576 * 1024 * 1024;
export function printPixels(size: PageSize, dpi: number) {
  return { width: Math.ceil(size.width * dpi / 72), height: Math.ceil(size.height * dpi / 72) };
}
export function checkPrintBudget(sheets: PageSize[], dpi: number) {
  if (![150, 300, 600].includes(dpi)) throw new Error("Choose 150, 300 or 600 dpi.");
  let bytes = 0;
  for (const sheet of sheets) {
    const { width, height } = printPixels(sheet, dpi);
    if (!Number.isFinite(width * height) || width * height > MAX_PRINT_PIXELS) throw new Error("A sheet exceeds the 48-megapixel limit. Choose a lower DPI or smaller paper.");
    bytes += width * height * 4;
  }
  if (bytes > MAX_PRINT_DECODED_BYTES) throw new Error(`This job needs ${Math.ceil(bytes / 1024 / 1024)} MiB of decoded images, above the 576 MiB limit. Select fewer pages, reduce poster scale/overlap, or choose a lower DPI.`);
  return bytes;
}

export function parsePages(text: string, count: number): number[] {
  const selected = new Set<number>();
  if (!text.trim()) throw new Error("Enter pages, for example 1-3, 5.");
  for (const part of text.split(",")) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error("Use page numbers or ranges, for example 1-3, 5.");
    const start = Number(match[1]), end = Number(match[2] ?? start);
    if (start < 1 || end > count || start > end) throw new Error(`Pages must be between 1 and ${count}, in ascending ranges.`);
    for (let n = start; n <= end; n++) selected.add(n);
  }
  return [...selected].sort((a, b) => a - b);
}

// Coordinates are PDF points. The same plan drives both preview and printed sheets.
export function planSheets(pages: number[], sizes: PageSize[], settings: PrintSettings): PrintSheet[] {
  if (!pages.length) throw new Error("Select at least one page.");
  if (!Number.isFinite(settings.scale) || settings.scale < 10 || settings.scale > 400) throw new Error("Scale must be between 10% and 400%.");
  const base = PAPER[settings.paper];
  const margin = 18;
  const sheets: PrintSheet[] = [];
  const sheetSize = (page: number) => {
    const size = sizes[page - 1];
    const landscape = settings.orientation === "landscape" || (settings.orientation === "auto" &&
      (settings.mode === "booklet" || settings.mode === "multiple" || size.width > size.height));
    return landscape ? { width: base.height, height: base.width } : base;
  };
  const sheet = (page: number) => {
    if (sheets.length >= 100) throw new Error("Print up to 100 sheets at a time. Select a smaller page range.");
    const value: PrintSheet = { ...sheetSize(page), placements: [] };
    sheets.push(value); return value;
  };
  const place = (target: PrintSheet, page: number, x: number, y: number, w: number, h: number, sizing = "fit") => {
    const size = sizes[page - 1];
    const fit = Math.min(w / size.width, h / size.height);
    const scale = sizing === "actual" ? 1 : sizing === "custom" ? settings.scale / 100 : sizing === "shrink" ? Math.min(1, fit) : fit;
    const pw = size.width * scale, ph = size.height * scale;
    target.placements.push({ page, x: x + (w - pw) / 2, y: y + (h - ph) / 2, width: pw, height: ph, scale,
      clip: { x, y, width: w, height: h } });
  };
  if (settings.mode === "booklet") {
    const padded: (number | null)[] = [...pages];
    while (padded.length % 4) padded.push(null);
    for (let i = 0; i < padded.length / 4; i++) {
      for (const pair of [[padded[padded.length - 1 - i * 2], padded[i * 2]], [padded[i * 2 + 1], padded[padded.length - 2 - i * 2]]]) {
        const target = sheet(pages[0]), availableW = target.width - 2 * margin, availableH = target.height - 2 * margin;
        pair.forEach((page, side) => { if (page) place(target, page, margin + side * availableW / 2, margin, availableW / 2, availableH); });
      }
    }
  } else if (settings.mode === "multiple") {
    const grids: Record<number, [number, number]> = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 9: [3, 3], 16: [4, 4] };
    const [cols, rows] = grids[settings.perSheet] ?? grids[2];
    pages.forEach((page, i) => {
      const slot = i % (cols * rows), target = slot === 0 ? sheet(page) : sheets[sheets.length - 1];
      const availableW = target.width - 2 * margin, availableH = target.height - 2 * margin;
      place(target, page, margin + slot % cols * availableW / cols, margin + Math.floor(slot / cols) * availableH / rows,
        availableW / cols, availableH / rows);
    });
  } else if (settings.mode === "poster") {
    const overlap = settings.overlapPoints;
    if (!Number.isFinite(overlap) || overlap < 0 || overlap >= Math.min(base.width, base.height) - 2 * margin) throw new Error("Overlap must be nonnegative and smaller than the printable width and height.");
    for (const page of pages) {
      const paper = sheetSize(page), availableW = paper.width - 2 * margin, availableH = paper.height - 2 * margin;
      const stepX = availableW - overlap, stepY = availableH - overlap;
      const size = sizes[page - 1], scale = settings.scale / 100;
      const w = size.width * scale, h = size.height * scale;
      const cols = Math.max(1, 1 + Math.ceil((w - availableW) / stepX - 1e-10));
      const rows = Math.max(1, 1 + Math.ceil((h - availableH) / stepY - 1e-10));
      if (sheets.length + cols * rows > 100) throw new Error("This layout exceeds 100 sheets. Select fewer pages or reduce the scale.");
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) sheet(page).placements.push({ page,
        x: margin - col * stepX, y: margin - row * stepY, width: w, height: h, scale,
        clip: { x: margin, y: margin, width: availableW, height: availableH } });
    }
  } else {
    for (const page of pages) {
      const target = sheet(page);
      place(target, page, margin, margin, target.width - 2 * margin, target.height - 2 * margin, settings.sizing);
    }
  }
  return sheets;
}
