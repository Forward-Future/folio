import { AnnotationMode, OPS, Util, type PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { SignatureTarget } from "./signatures";

interface Rule { left: number; right: number; y: number }
const caption = /^(?:(?:your|applicant(?:['’]s)?|signer(?:['’]s)?|approver(?:['’]s)?|approval|authorized|witness(?:['’]s)?)\s+)?(signature|initials)$/i;
const painted = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

async function drawnRules(page: PDFPageProxy): Promise<Rule[]> {
  const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const rules: Rule[] = [], stack: number[][] = [];
  let matrix = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i], args = argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(matrix);
      if (op === OPS.paintFormXObjectBegin && args[0]) matrix = Util.transform(matrix, args[0]);
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      matrix = stack.pop() ?? matrix;
    } else if (op === OPS.transform) {
      matrix = Util.transform(matrix, args);
    } else if (op === OPS.constructPath && args[2] && painted.has(args[0])) {
      // Exporters use both stroked paths and thin filled rectangles for printed rules.
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      Util.axialAlignedBoundingBox(args[2], matrix, bounds);
      if (bounds[2] - bounds[0] >= 16 && bounds[3] - bounds[1] <= 2) {
        rules.push({ left: bounds[0], right: bounds[2], y: (bounds[1] + bounds[3]) / 2 });
      }
    }
  }
  return rules;
}

function nearbyRule(item: TextItem, rules: Rule[]) {
  const [, , , , x, y] = item.transform;
  let best: Rule | undefined, distance = Infinity;
  for (const rule of rules) {
    const gap = rule.left - (x + item.width), dy = rule.y - y;
    const beside = gap >= -2 && gap <= 3 * item.height && Math.abs(dy) <= item.height * 0.6;
    const aligned = Math.abs(rule.left - x) <= item.height * 1.5;
    const above = dy >= item.height * 0.6 && dy <= item.height + 18;
    const below = dy <= -12 && dy >= -48;
    if (!beside && !(aligned && (above || below))) continue;
    const score = beside ? Math.abs(gap) + Math.abs(dy) : Math.abs(rule.left - x) + Math.abs(dy);
    if (score < distance) { best = rule; distance = score; }
  }
  return best;
}

export async function printedSignatureTargets(page: PDFPageProxy): Promise<SignatureTarget[]> {
  const { items, styles } = await page.getTextContent();
  const text = items.filter((item): item is TextItem => "str" in item);
  const labels = text.flatMap((item, index) => {
    const label = item.str.replace(/^[_\s]+|[:_\s]+$/g, "").trim();
    const exact = caption.exec(label);
    if (!exact && !/\b(signature|sign here|signed by)\b/i.test(label) && !/^approved by$/i.test(label)) return [];
    if (/digital|electronic|verified|invalid/i.test(label)) return [];
    return [{ item, index, label, exact }];
  });
  if (!labels.length) return [];
  const rules: Rule[] = [];
  if (labels.some(({ exact }) => exact)) {
    for (const item of text) {
      if (/^_{3,}$/.test(item.str.trim())) rules.push({ left: item.transform[4], right: item.transform[4] + item.width, y: item.transform[5] - item.height * 0.12 });
    }
    for (const rule of await drawnRules(page).catch(() => [])) rules.push(rule);
  }
  const [left, bottom, right, top] = page.view;
  const targets: SignatureTarget[] = [];
  const used = new Set<Rule>();
  let suggestions = 0;
  const measure = document.createElement("canvas").getContext("2d");
  for (const { item, index, label, exact } of labels) {
    const [, , , , x, y] = item.transform;
    const initials = exact?.[1].toLowerCase() === "initials";
    const id = "label-" + index;
    const horizontalCaption = exact && item.transform[0] > 0 && Math.abs(item.transform[1]) < 0.01;
    if (horizontalCaption) {
      let rule = nearbyRule(item, rules);
      const underline = /_{3,}/.exec(item.str);
      if (underline && measure) {
        // PDF.js can combine the caption and underline. Scale font metrics to the actual PDF text run.
        measure.font = "100px " + (styles[item.fontName]?.fontFamily || "sans-serif");
        const scale = item.width / measure.measureText(item.str).width;
        const start = x + measure.measureText(item.str.slice(0, underline.index)).width * scale;
        rule = { left: start, right: start + measure.measureText(underline[0]).width * scale, y: y - item.height * 0.12 };
      }
      if (rule) {
        if (used.has(rule)) continue;
        used.add(rule);
        const height = Math.min(initials ? 32 : 42, rule.y <= y - 12 ? y - rule.y - 3 : Infinity);
        const rect = [Math.max(left, rule.left), Math.max(bottom, rule.y - 2), Math.min(right, rule.right), Math.min(top, rule.y + height)];
        if (rect[2] - rect[0] > 4 && rect[3] - rect[1] > 4) targets.push({ id, label, rect, kind: "line" });
        continue;
      }
    }
    const width = initials ? 64 : 180;
    const beside = exact && item.str.trimEnd().endsWith(":") && x + item.width + 8 + width <= right;
    const px = Math.max(left, Math.min(beside ? x + item.width + 8 : x, right - width));
    const py = Math.max(bottom, Math.min(beside ? y - 2 : y + Math.max(item.height, 10) + 3, top - 42));
    const rect = [px, py, Math.min(right, px + width), Math.min(top, py + 42)];
    // A rule can be baked into the page image while its caption is selectable. Offer the usual signing
    // space only when the caption stands alone and the hit area would leave other text accessible.
    const blank = horizontalCaption && !text.some(other =>
      other.str.trim() && other.transform[4] < rect[2] && other.transform[4] + other.width > rect[0] &&
      other.transform[5] < rect[3] && other.transform[5] + other.height > rect[1]);
    if (blank) targets.push({ id, label, rect, kind: "line" });
    else if (suggestions < 12) {
      targets.push({ id, label: label.slice(0, 80) + " (suggested)", rect, kind: "label" });
      suggestions++;
    }
  }
  return targets;
}
