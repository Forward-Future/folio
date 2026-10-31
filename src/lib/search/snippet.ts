// The words around a search match, for the results list.

/** The parts of a pdf.js text item that matter here (marked-content markers have neither). */
export interface TextPiece {
  str?: string;
  hasEOL?: boolean;
}

export interface PageText {
  /** The page's text for reading: the items joined, plus a space where a line ends. */
  text: string;
  /** Where those added spaces go, as offsets in the text *without* them (the offsets pdf.js find reports), ascending. */
  breaks: number[];
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

const BEFORE = 55;
const AFTER = 100;

/**
 * Items are joined with nothing between them, because that is the string pdf.js find reports offsets in (it reads the
 * page with `disableNormalization` and drops the line ends again when it maps a match back). A line end then reads as
 * "identification.Invoice", so a space goes in, unless the text already has one there.
 */
export function pageText(items: TextPiece[]): PageText {
  let text = "";
  let plain = 0;
  let lineEnded = false;
  const breaks: number[] = [];
  for (const { str = "", hasEOL } of items) {
    if (str) {
      if (lineEnded && text && !/\s$/.test(text) && !/^\s/.test(str)) {
        text += " ";
        breaks.push(plain);
      }
      lineEnded = false;
    }
    text += str;
    plain += str.length;
    if (hasEOL) lineEnded = true;
  }
  return { text, breaks };
}

/** How many added spaces sit before `offset`, counting one exactly at it only when asked. */
function added(breaks: number[], offset: number, atOffset: boolean) {
  let count = 0;
  while (count < breaks.length && (atOffset ? breaks[count] <= offset : breaks[count] < offset)) count++;
  return count;
}

/** The match at `offset` (as pdf.js find reports it) with some text on each side. */
export function snippetAt({ text, breaks }: PageText, offset: number, length: number): Snippet {
  // A space added right before the match stays out of it; one right after it stays out too. One inside it is part of it.
  const start = offset + added(breaks, offset, true);
  const end = offset + length + added(breaks, offset + length, false);
  return {
    before: (start > BEFORE ? "..." : "") + text.slice(Math.max(0, start - BEFORE), start),
    match: text.slice(start, end),
    after: text.slice(end, end + AFTER) + (text.length > end + AFTER ? "..." : ""),
  };
}
