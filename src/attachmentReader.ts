// Reads single objects out of a PDF's bytes, for saving an attached file, without building the rest of the document.
//
// A PDF library opens a file by reading everything in it, and a file of a few hundred bytes can make that take
// gigabytes. Finding one attached file needs a handful of objects, so this reads only those, the way pdf.js reads them
// (its list is where the attachment's id comes from, so the two have to agree on what a name or an object is). Every
// byte it unpacks and every token it reads is counted against a limit, and a file that is damaged, or built in a way
// this doesn't know, is refused rather than repaired.

/** Why a PDF's attached file can't be read. */
export class Refusal extends Error {
  constructor(readonly why: "limit" | "protected" | "unreadable") { super(why); }
}
const unreadable = () => new Refusal("unreadable");

export class Name { constructor(readonly name: string) {} }
export class Ref { constructor(readonly num: number, readonly gen: number) {} }
export class Cmd { constructor(readonly cmd: string) {} }
export class Dict extends Map<string, Value> {}
/** A stream as it lies in `bytes`: its data starts at `start`, and how far it goes is for `contents` to say. */
export class Stream { constructor(readonly dict: Dict, readonly bytes: Uint8Array, readonly start: number, readonly end: number) {} }
/** Strings are held the way pdf.js holds them, one character for each byte. */
export type Value = number | string | boolean | null | undefined | Name | Ref | Cmd | Dict | Stream | Value[];

export interface Limits {
  /** Bytes it may hold beyond the PDF itself: what it unpacks (counted twice, as it is held twice for a moment) and the strings it reads. */
  work: number;
  /** Numbers, names, strings and so on it may read. */
  tokens: number;
  /** Tables of objects it may follow back through the file's saved revisions. */
  sections: number;
  /** Lines of those tables it may check. */
  rows: number;
  /** How deep lists and dictionaries may nest. */
  depth: number;
}
export const LIMITS: Limits = { work: 64 * 1024 * 1024, tokens: 1_000_000, sections: 1024, rows: 20_000_000, depth: 64 };

interface Meter { token(): void; work(bytes: number): void; depth: number }

const END = new Cmd("");
/** In place of a string too long to be a name for anything: it is read past, and not kept. */
export const LONG = new Cmd("");
const LONGEST = 32 * 1024;
const SPACE = 1, MARK = 2;
const KIND = new Uint8Array(256);
for (const code of [0, 9, 10, 12, 13, 32]) KIND[code] = SPACE;
for (const mark of "%()/<>[]{}") KIND[mark.charCodeAt(0)] = MARK;
const hexDigit = (code: number) => code >= 48 && code <= 57 ? code - 48 : (code | 32) >= 97 && (code | 32) <= 102 ? (code | 32) - 87 : -1;
const isInt = (value: unknown): value is number => Number.isInteger(value);
const isCmd = (value: unknown, cmd: string) => value instanceof Cmd && value.cmd === cmd;

function text(codes: number[]) {
  let out = "";
  for (let i = 0; i < codes.length; i += 8192) out += String.fromCharCode(...codes.slice(i, i + 8192));
  return out;
}

/** pdf.js's Lexer, over a stretch of bytes: the same tokens for the same input, including for input that breaks the rules. */
class Lexer {
  /** Where the token last read began. */
  from = 0;
  constructor(readonly bytes: Uint8Array, public pos: number, readonly end: number, private meter: Meter) {
    if (!(pos >= 0)) throw unreadable();
  }

  next(): Value {
    const { bytes, end, meter } = this;
    meter.token();
    let p = this.pos;
    for (let comment = false; ; p++) {
      if (p >= end) { this.pos = p; return END; }
      const code = bytes[p];
      if (comment) comment = code !== 10 && code !== 13;
      else if (code === 0x25) comment = true;
      else if (KIND[code] !== SPACE) break;
    }
    this.from = p;
    const at = (i: number) => i < end ? bytes[i] : -1;
    let code = bytes[p];
    const codes: number[] = [];
    let long = false;
    const keep = (kept: number) => {
      if (codes.length === LONGEST) { long = true; return; }
      meter.work(2);
      codes.push(kept);
    };

    if ((code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e) {
      let divideBy = 0, sign = 1;
      if (code === 0x2d) { sign = -1; code = at(++p); if (code === 0x2d) code = at(++p); } else if (code === 0x2b) code = at(++p);
      while (code === 10 || code === 13) code = at(++p);
      if (code === 0x2e) { divideBy = 10; code = at(++p); }
      this.pos = p;
      if (code < 0x30 || code > 0x39) {
        if (code === -1 || code === 0x28 || code === 0x3c || code === 0x20 || code === 9 || code === 10 || code === 13) return 0;
        throw unreadable();
      }
      let value = code - 0x30;
      while ((code = at(++p)) >= 0) {
        if (code >= 0x30 && code <= 0x39) { if (divideBy) divideBy *= 10; value = value * 10 + (code - 0x30); }
        else if (code === 0x2e) { if (divideBy) break; divideBy = 1; }
        else if (code !== 0x2d) break;
      }
      this.pos = p;
      return sign * (divideBy ? value / divideBy : value);
    }

    if (code === 0x28) {
      for (let open = 1; ;) {
        code = at(++p);
        if (code === -1) break;
        if (code === 0x28) { open++; keep(code); }
        else if (code === 0x29) { if (!--open) { p++; break; } keep(code); }
        else if (code !== 0x5c) keep(code);
        else {
          code = at(++p);
          if (code === -1) break;
          if (code >= 0x30 && code <= 0x37) {
            let value = code & 15;
            if (at(p + 1) >= 0x30 && at(p + 1) <= 0x37) {
              value = (value << 3) + (at(++p) & 15);
              if (at(p + 1) >= 0x30 && at(p + 1) <= 0x37) value = (value << 3) + (at(++p) & 15);
            }
            keep(value);
          } else if (code === 13) { if (at(p + 1) === 10) p++; }
          else if (code !== 10) keep(code === 0x6e ? 10 : code === 0x72 ? 13 : code === 0x74 ? 9 : code === 0x62 ? 8 : code === 0x66 ? 12 : code);
        }
      }
      this.pos = p;
      return long ? LONG : text(codes);
    }

    if (code === 0x2f) {
      while ((code = at(++p)) >= 0 && !KIND[code]) {
        if (code !== 0x23) { keep(code); continue; }
        code = at(++p);
        if (code === -1 || KIND[code]) { keep(0x23); break; }
        const high = hexDigit(code);
        if (high === -1) { keep(0x23); keep(code); continue; }
        const second = at(++p), low = hexDigit(second);
        if (low !== -1) { keep(high << 4 | low); continue; }
        keep(0x23); keep(code);
        if (second === -1 || KIND[second]) break;
        keep(second);
      }
      this.pos = p;
      // (A name is a key, and what follows a key that was let go would be read as something else.)
      if (long) throw new Refusal("limit");
      return new Name(text(codes));
    }

    if (code === 0x3c && at(p + 1) !== 0x3c) {
      let first = -1;
      for (p++; ; p++) {
        code = at(p);
        if (code === -1) break;
        if (code === 0x3e) { p++; break; }
        const digit = KIND[code] === SPACE ? -1 : hexDigit(code);
        if (digit === -1) continue;
        if (first === -1) first = digit;
        else { keep(first << 4 | digit); first = -1; }
      }
      if (first !== -1) keep(first << 4);
      this.pos = p;
      return long ? LONG : text(codes);
    }

    if (code === 0x29) throw unreadable();
    if (code === 0x5b || code === 0x5d || code === 0x7b || code === 0x7d) { this.pos = p + 1; return new Cmd(String.fromCharCode(code)); }
    if (code === 0x3c) { this.pos = p + 2; return new Cmd("<<"); }
    if (code === 0x3e) { const two = at(p + 1) === 0x3e; this.pos = p + (two ? 2 : 1); return new Cmd(two ? ">>" : ">"); }

    if ((code < 0x20 || code > 0x7f) && at(p + 1) >= 0x20 && at(p + 1) <= 0x7f) { this.pos = p + 1; return new Cmd(String.fromCharCode(code)); }
    codes.push(code);
    while ((code = at(++p)) >= 0 && !KIND[code]) {
      if (codes.length === 128) throw unreadable();
      codes.push(code);
    }
    this.pos = p;
    const word = text(codes);
    return word === "true" ? true : word === "false" ? false : word === "null" ? null : new Cmd(word);
  }
}

/** pdf.js's Parser: whole values out of a Lexer's tokens. */
class Parser {
  private one: Value;
  private two: Value;
  constructor(private lexer: Lexer, private meter: Meter) { this.one = lexer.next(); this.two = lexer.next(); }

  private shift() { this.one = this.two; this.two = this.lexer.next(); }

  value(depth = 0): Value {
    if (depth > this.meter.depth) throw new Refusal("limit");
    const first = this.one;
    this.shift();
    if (isCmd(first, "[")) {
      const list: Value[] = [];
      while (!isCmd(this.one, "]")) {
        if (this.one === END) throw unreadable();
        list.push(this.value(depth + 1));
      }
      this.shift();
      return list;
    }
    if (isCmd(first, "<<")) {
      const dict = new Dict();
      while (!isCmd(this.one, ">>")) {
        if (this.one === END) throw unreadable();
        if (!(this.one instanceof Name)) { this.shift(); continue; }
        const key = this.one.name;
        this.shift();
        if ((this.one as Value) === END) throw unreadable();
        dict.set(key, this.value(depth + 1));
      }
      if (isCmd(this.two, "stream")) {
        // The data begins on the line after the word.
        const { bytes, end } = this.lexer;
        let p = this.lexer.pos;
        while (p < end && bytes[p] !== 10 && bytes[p] !== 13) p++;
        if (bytes[p] === 13 && bytes[p + 1] === 10) p++;
        return new Stream(dict, bytes, Math.min(p + 1, end), end);
      }
      this.shift();
      return dict;
    }
    if (isInt(first) && isInt(this.one) && isCmd(this.two, "R")) {
      const ref = new Ref(first, this.one);
      this.shift();
      this.shift();
      return ref;
    }
    return first;
  }
}

type Entry = { offset: number; gen: number } | { pack: number; index: number } | null;
type Section = { rows: { first: number; count: number; at: number; width: number }[] }
  | { widths: number[]; ranges: number[]; data: Uint8Array };

function find(bytes: Uint8Array, word: string, from: number, to: number, backwards = false) {
  const codes = Array.from(word, char => char.charCodeAt(0));
  const matches = (at: number) => codes.every((code, i) => bytes[at + i] === code);
  if (backwards) { for (let at = to - codes.length; at >= from; at--) if (matches(at)) return at; }
  else for (let at = from; at + codes.length <= to; at++) if (matches(at)) return at;
  return -1;
}

export class PdfReader {
  /** What has been spent of each limit so far. */
  readonly used = { work: 0, tokens: 0, sections: 0, rows: 0 };
  /** The newest trailer: where the document starts. */
  trailer!: Dict;
  private meter: Meter;
  private start = 0;
  private sections: Section[] = [];
  private packs = new Map<number, { data: Uint8Array; first: number; at: number[] }>();
  private unpacking = new Set<number>();

  /** `inflate` unpacks Flate data, and must itself stop (with a Refusal) rather than deliver more than the limit it is given. */
  constructor(private bytes: Uint8Array, private inflate: (packed: Uint8Array, limit: number) => Promise<Uint8Array>, private limits = LIMITS) {
    const { used } = this;
    this.meter = {
      depth: limits.depth,
      token() { if (++used.tokens > limits.tokens) throw new Refusal("limit"); },
      work(size) { if ((used.work += size) > limits.work) throw new Refusal("limit"); },
    };
  }

  private parser(at: number, bytes = this.bytes, end = bytes.length) { return new Parser(new Lexer(bytes, at, end, this.meter), this.meter); }

  /** Finds the tables that say where the PDF's objects are: nothing can be read before this. */
  async open() {
    const { bytes } = this;
    // Offsets count from the header, which some files have junk in front of.
    this.start = Math.max(0, find(bytes, "%PDF-", 0, Math.min(bytes.length, 1024)));
    let p = find(bytes, "startxref", 0, bytes.length, true);
    if (p < 0) throw unreadable();
    for (p += 9; bytes[p] === 32 || bytes[p] === 9 || bytes[p] === 10 || bytes[p] === 13;) p++;
    let digits = "";
    while (bytes[p] >= 0x20 && bytes[p] <= 0x39 && digits.length < 32) digits += String.fromCharCode(bytes[p++]);
    // Newest first, and a revision's own entries count before those of the one it replaced.
    const offsets = [parseInt(digits, 10)], seen = new Set<number>();
    for (const offset of offsets) {
      if (seen.has(offset)) continue;
      seen.add(offset);
      if (!isInt(offset) || offset < 0) throw unreadable();
      if (++this.used.sections > this.limits.sections) throw new Refusal("limit");
      const lexer = new Lexer(bytes, this.start + offset, bytes.length, this.meter);
      let dict: Value;
      if (isCmd(lexer.next(), "xref")) {
        dict = this.readTable(lexer);
        if (!(dict instanceof Dict)) throw unreadable();
        const more = dict.get("XRefStm");
        if (isInt(more)) offsets.push(more);
      } else {
        const parser = this.parser(this.start + offset);
        const stream = isInt(parser.value()) && isInt(parser.value()) && isCmd(parser.value(), "obj") ? parser.value() : undefined;
        if (!(stream instanceof Stream)) throw unreadable();
        dict = stream.dict;
        const widths = dict.get("W"), ranges = dict.get("Index") || [0, dict.get("Size")];
        if (!Array.isArray(widths) || !Array.isArray(ranges) || ranges.length % 2 || !ranges.every(isInt)) throw unreadable();
        const fields = widths.slice(0, 3) as number[], size = fields[0] + fields[1] + fields[2];
        if (fields.length < 3 || !fields.every(width => isInt(width) && width >= 0 && width <= 8) || !size) throw unreadable();
        const data = await this.unpacked(stream, true);
        let rows = 0;
        for (let i = 0; i < ranges.length; i += 2) rows += Math.max(0, ranges[i + 1] as number);
        if (rows * size > data.length) throw unreadable();
        this.sections.push({ widths: fields, ranges: ranges as number[], data });
      }
      this.trailer ??= dict;
      const older = dict.get("Prev");
      if (isInt(older)) offsets.push(older);
      else if (older instanceof Ref) offsets.push(older.num);
    }
    if ((await this.get(this.trailer, "Encrypt")) instanceof Dict) throw new Refusal("protected");
  }

  /**
   * A table can claim millions of lines, so none are kept: one is read from its place when an object is asked for.
   * pdf.js reads a table as a run of numbers and letters, wherever its lines break, and the two readings are the same
   * only for a table written the regular way: every line ten digits, five digits and a letter, a space between them,
   * and the same few spaces or line breaks after. So every line is checked to be that. Returns the trailer after the table.
   */
  private readTable(lexer: Lexer) {
    const { bytes } = this, rows: { first: number; count: number; at: number; width: number }[] = [];
    const blank = (code: number) => code === 32 || code === 10 || code === 13;
    for (;;) {
      let first = lexer.next();
      if (isCmd(first, "trailer")) break;
      const count = lexer.next();
      if (!isInt(first) || !isInt(count)) throw unreadable();
      if (count <= 0) continue;
      lexer.next();
      const at = lexer.from;
      let width = 18;
      while (blank(bytes[at + width])) width++;
      if (width === 18 || at + width * count > bytes.length) throw unreadable();
      if ((this.used.rows += count) > this.limits.rows) throw new Refusal("limit");
      for (let row = at, end = at + width * count; row < end; row += width) {
        for (let i = 0; i < width; i++) {
          const code = bytes[row + i];
          if (!(i === 10 || i === 16 ? code === 32 : i === 17 ? code === 0x66 || code === 0x6e : i > 17 ? blank(code) : code >= 0x30 && code <= 0x39)) throw unreadable();
        }
      }
      // (pdf.js's allowance for a table that numbers its first, free, line 1 rather than 0.)
      if (first === 1 && bytes[at + 17] === 0x66) first = 0;
      rows.push({ first, count, at, width });
      lexer.pos = at + width * count;
    }
    this.sections.push({ rows });
    const dict = new Parser(lexer, this.meter).value();
    return dict instanceof Stream ? dict.dict : dict;
  }

  private entry(num: number): Entry {
    for (const section of this.sections) {
      if ("rows" in section) {
        for (const { first, count, at, width } of section.rows) {
          if (num < first || num >= first + count) continue;
          const row = at + width * (num - first);
          const number = (from: number, to: number) => { let value = 0; while (from < to) value = value * 10 + this.bytes[row + from++] - 0x30; return value; };
          const offset = number(0, 10);
          return this.bytes[row + 17] === 0x66 || !offset ? null : { offset, gen: number(11, 16) };
        }
        continue;
      }
      const { widths: [typeWidth, offsetWidth, genWidth], ranges, data } = section;
      for (let i = 0, row = 0; i < ranges.length; row += Math.max(0, ranges[i + 1]), i += 2) {
        if (num < ranges[i] || num >= ranges[i] + ranges[i + 1]) continue;
        let p = (row + num - ranges[i]) * (typeWidth + offsetWidth + genWidth);
        const field = (width: number) => { let value = 0; while (width--) value = value * 256 + data[p++]; return value; };
        const type = typeWidth ? field(typeWidth) : 1, offset = field(offsetWidth), gen = field(genWidth);
        if (type > 2) throw unreadable();
        return !type || !offset ? null : type === 1 ? { offset, gen } : { pack: offset, index: gen };
      }
    }
    return null;
  }

  /** The object `ref` names: null when the PDF has none. */
  async fetch(ref: Ref): Promise<Value> {
    const entry = this.entry(ref.num);
    if (!entry) return null;
    if ("pack" in entry) return this.packedObject(entry.pack, entry.index);
    if (entry.gen !== ref.gen) throw unreadable();
    const parser = this.parser(this.start + entry.offset);
    // What is there has to be the object asked for, or the table and the file disagree.
    if (parser.value() !== ref.num || parser.value() !== ref.gen || !isCmd(parser.value(), "obj")) throw unreadable();
    return parser.value();
  }

  /** `value`, or the object it refers to. */
  resolve(value: Value) { return value instanceof Ref ? this.fetch(value) : value; }
  get(dict: Dict, key: string) { return this.resolve(dict.get(key)); }

  /** An object kept, with others, packed inside a stream. */
  private async packedObject(num: number, index: number) {
    let pack = this.packs.get(num);
    if (!pack) {
      const entry = this.entry(num);
      // (A pack inside a pack isn't allowed, and one that needs itself to be read would never end.)
      if (!entry || "pack" in entry || this.unpacking.has(num)) throw unreadable();
      this.unpacking.add(num);
      const stream = await this.fetch(new Ref(num, 0));
      if (!(stream instanceof Stream)) throw unreadable();
      const first = stream.dict.get("First"), count = stream.dict.get("N");
      if (!isInt(first) || !isInt(count)) throw unreadable();
      const data = await this.unpacked(stream, false);
      const lexer = new Lexer(data, 0, data.length, this.meter), at: number[] = [];
      for (let i = 0; i < count; i++) {
        const offset = isInt(lexer.next()) ? lexer.next() : undefined;
        if (!isInt(offset)) throw unreadable();
        at.push(offset);
      }
      this.unpacking.delete(num);
      this.packs.set(num, pack = { data, first, at });
    }
    if (index >= pack.at.length) throw unreadable();
    const from = pack.first + pack.at[index], to = index + 1 < pack.at.length ? pack.first + pack.at[index + 1] : pack.data.length;
    if (to < from) throw unreadable();
    return this.parser(from, pack.data, Math.min(to, pack.data.length)).value();
  }

  /**
   * How a stream's data is packed. Only what PDF writers do is known here: the data as it is, or packed once with
   * Flate, perhaps with each line stored as its difference from the one before (`predictor` above 1).
   * `direct` is for the tables themselves, which can't look anything up yet.
   */
  async packing(stream: Stream, direct = false) {
    const { dict } = stream;
    if (["F", "FFilter", "DP"].some(key => dict.get(key) !== undefined)) throw unreadable();
    const resolve = async (value: Value) => {
      if (value instanceof Ref && direct) throw unreadable();
      return this.resolve(value);
    };
    // Some writers put a single filter in a list, or write an empty setting out.
    const only = async (value: Value) => {
      const all = await resolve(value);
      return (await resolve(Array.isArray(all) && all.length === 1 ? all[0] : all)) ?? undefined;
    };
    const filter = await only(dict.get("Filter")), parms = await only(dict.get("DecodeParms"));
    if (filter === undefined) return { packed: false, predictor: 1, columns: 1 };
    if (!(filter instanceof Name && (filter.name === "FlateDecode" || filter.name === "Fl")) || !(parms === undefined || parms instanceof Dict)) throw unreadable();
    const setting = async (key: string) => (await resolve(parms?.get(key))) ?? undefined;
    const predictor = await setting("Predictor") ?? 1, columns = await setting("Columns") ?? 1;
    if (!isInt(predictor) || !isInt(columns) || columns < 1) throw unreadable();
    if (predictor > 1 && (predictor < 10 || predictor > 15 || (await setting("Colors") ?? 1) !== 1 || (await setting("BitsPerComponent") ?? 8) !== 8)) throw unreadable();
    return { packed: true, predictor, columns };
  }

  /** A stream's data as it lies in the file: no copy is made. Its stated length has to end where the stream does. */
  async contents(stream: Stream, direct = false) {
    const stated = stream.dict.get("Length"), length = direct ? stated : await this.resolve(stated);
    const end = stream.start + (length as number);
    if (!isInt(length) || length < 0 || end > stream.end) throw unreadable();
    if (!isCmd(new Lexer(stream.bytes, end, stream.end, this.meter).next(), "endstream")) throw unreadable();
    return stream.bytes.subarray(stream.start, end);
  }

  /** The unpacked data of a stream that the file's own structure is kept in. */
  private async unpacked(stream: Stream, direct: boolean) {
    const { packed, predictor, columns } = await this.packing(stream, direct), contents = await this.contents(stream, direct);
    if (!packed) return contents;
    let data: Uint8Array;
    try {
      data = await this.inflate(contents, Math.floor((this.limits.work - this.used.work) / 2));
    } catch (error) {
      throw error instanceof Refusal ? error : unreadable();
    }
    this.meter.work(data.length * 2);
    if (predictor === 1) return data;
    // Each line starts with a byte saying how it was stored: as it is, or as the difference from the byte to the
    // left, the one above, their average, or whichever of those and the one above-left is closest.
    const lines = Math.floor(data.length / (columns + 1));
    this.meter.work(lines * columns);
    const out = new Uint8Array(lines * columns);
    for (let line = 0, from = 0, to = 0; line < lines; line++) {
      const kind = data[from++];
      if (kind > 4) throw unreadable();
      for (let i = 0; i < columns; i++, from++, to++) {
        const left = i ? out[to - 1] : 0, up = line ? out[to - columns] : 0, corner = i && line ? out[to - columns - 1] : 0;
        let guess = 0;
        if (kind === 1) guess = left;
        else if (kind === 2) guess = up;
        else if (kind === 3) guess = (left + up) >> 1;
        else if (kind === 4) {
          const toLeft = Math.abs(up - corner), toUp = Math.abs(left - corner), toCorner = Math.abs(left + up - 2 * corner);
          guess = toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
        }
        out[to] = data[from] + guess;
      }
    }
    return out;
  }
}

const DOC_ENCODING = new Map<number, number>([
  ...[0x2d8, 0x2c7, 0x2c6, 0x2d9, 0x2dd, 0x2db, 0x2da, 0x2dc].map((code, i): [number, number] => [0x18 + i, code]),
  ...[0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x192, 0x2044, 0x2039, 0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018, 0x2019,
    0x201a, 0x2122, 0xfb01, 0xfb02, 0x141, 0x152, 0x160, 0x178, 0x17d, 0x131, 0x142, 0x153, 0x161, 0x17e].map((code, i): [number, number] => [0x80 + i, code]),
  [0xa0, 0x20ac],
]);

/** The text a PDF string stands for, as pdf.js reads it for an attachment's id (its stringToPDFString, escape sequences kept). */
export function pdfText(string: string) {
  if (string[0] >= "\xef") {
    let encoding: string | undefined;
    if (string.startsWith("\xfe\xff")) encoding = "utf-16be";
    else if (string.startsWith("\xff\xfe")) encoding = "utf-16le";
    else if (string.startsWith("\xef\xbb\xbf")) encoding = "utf-8";
    if (encoding && encoding !== "utf-8" && string.length % 2) string = string.slice(0, -1);
    if (encoding) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(Uint8Array.from(string, char => char.charCodeAt(0)));
      } catch { /* Not that encoding after all: read it as plain text. */ }
    }
  }
  let read = "";
  for (let i = 0; i < string.length; i++) {
    const code = DOC_ENCODING.get(string.charCodeAt(i));
    read += code ? String.fromCharCode(code) : string[i];
  }
  return read;
}
