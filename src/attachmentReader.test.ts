import { describe, expect, it } from "vitest";
import { attachmentBytes, listAttachments } from "./attachments";
import { LIMITS, type Limits } from "./attachmentReader";
import { bytesOf, handPdf, pack, streamOf, tableOf, withAttachment } from "./testing/handPdf";
import { openPdf } from "./testing/pdfjs";

type Used = { work: number; tokens: number; sections: number };

/** What saving "a.txt" from `pdf` gives, and what it used of `limits` on the way, whether it was saved or refused. */
async function save(pdf: Uint8Array, limits: Partial<Limits> = {}, id = "a.txt") {
  let used!: Used;
  const outcome = await attachmentBytes(pdf, id, { limits: { ...LIMITS, ...limits }, spent: spent => { used = { ...spent }; } })
    .then(file => file.text(), (error: Error) => error);
  return { outcome, used };
}
const refused = (outcome: string | Error) => outcome instanceof Error ? outcome.message : `saved ${JSON.stringify(outcome)}`;
const TOO_LARGE = "This PDF is too large for Folio to save its attached files.";
const CANT_SAVE = "This attachment is stored in a way Folio can't save.";

/**
 * A PDF in the newer layout: `packed` objects kept together inside stream `pack`, and the table of where everything
 * is kept as a stream too (`table` is its number), its lines stored as differences from the line above if `predictor`.
 */
async function packedPdf(objects: Record<number, string | Uint8Array>, packed: Record<number, string>, { pack: packNum = 20, table = 21, predictor = false, padding = 0 } = {}) {
  const bodies = Object.values(packed), nums = Object.keys(packed).map(Number);
  let header = "", at = 0;
  for (const [i, body] of bodies.entries()) { header += `${nums[i]} ${at} `; at += body.length + 1; }
  const packData = bytesOf(header, bodies.join("\n"), " ".repeat(padding));
  const all: Record<number, string | Uint8Array> = { ...objects,
    [packNum]: streamOf(await pack(packData), `/Type /ObjStm /N ${nums.length} /First ${header.length} /Filter /FlateDecode`) };
  const parts: Uint8Array[] = [bytesOf("%PDF-1.7\n")], offsets = new Map<number, number>();
  let end = parts[0].length;
  for (const [num, body] of Object.entries(all)) {
    offsets.set(Number(num), end);
    parts.push(bytesOf(`${num} 0 obj\n`, body, "\nendobj\n"));
    end += parts.at(-1)!.length;
  }
  const size = table + 1, lines: number[][] = [];
  for (let num = 0; num < size; num++) {
    const offset = num === table ? end : offsets.get(num), index = nums.indexOf(num);
    const [kind, where, extra] = offset !== undefined ? [1, offset, 0] : index >= 0 ? [2, packNum, index] : [0, 0, 0];
    lines.push([kind, where >>> 24, (where >>> 16) & 255, (where >>> 8) & 255, where & 255, extra >>> 8, extra & 255]);
  }
  const stored = predictor ? lines.flatMap((line, i) => [2, ...line.map((byte, j) => (byte - (i ? lines[i - 1][j] : 0)) & 255)]) : lines.flat();
  parts.push(bytesOf(`${table} 0 obj\n`, streamOf(await pack(Uint8Array.from(stored)),
    `/Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode${predictor ? " /DecodeParms << /Predictor 12 /Columns 7 >>" : ""}`),
    `\nendobj\nstartxref\n${end}\n%%EOF\n`));
  return bytesOf(...parts);
}

describe("reading an attached file out of a PDF's bytes", () => {
  it("reads it from a PDF in the old layout and in the new, and from the newest of a file's saved revisions", async () => {
    expect((await save(handPdf(withAttachment()))).outcome).toBe("hello\n");

    const { 4: spec, 6: tree, ...plain } = withAttachment();
    for (const predictor of [false, true]) {
      const pdf = await packedPdf(plain, { 4: spec as string, 6: tree as string }, { predictor });
      expect((await save(pdf)).outcome).toBe("hello\n");
      // pdf.js reads the same file the same way.
      const opened = await openPdf(pdf);
      try {
        expect(new TextDecoder().decode(await opened.getAttachmentContent((await listAttachments(opened))[0].id) as Uint8Array)).toBe("hello\n");
      } finally { await opened.loadingTask.destroy(); }
    }

    // Saved again with the file replaced, then again with it removed.
    const replaced = handPdf({ 5: streamOf("changed\n") }, { onto: handPdf(withAttachment()) });
    expect((await save(replaced)).outcome).toBe("changed\n");
    expect(refused((await save(handPdf({}, { onto: replaced, gone: [5] }))).outcome)).toBe("This attachment has no content.");
    // Junk before the header, which every offset in the file then counts from.
    const shifted = bytesOf("junk\n", handPdf(withAttachment()));
    expect((await save(shifted)).outcome).toBe("hello\n");
  });

  it("finds a file under every kind of name by the id pdf.js lists it with", async () => {
    // A name of each single byte, then the ways a PDF may write or encode one.
    const keys = Array.from({ length: 256 }, (_, byte) => `<${byte.toString(16).padStart(2, "0")}5F>`);
    keys.push("(quarter\\\r\nly)", "(quarter\\\nl)", "(quarter\\\r)", "(line\rbreak)", "(a\\(b\\)c(d)\\\\)", "(oct\\101\\7\\0612\\400)", "(esc\\n\\r\\t\\b\\f\\q)",
      "<FEFF00E9 0074 00E9>", "<FEFF00E900>", "<FFFE E900 7400>", "<EFBBBF C3A9 74 C3A9>", "<EFBBBF FF>", "<FE>", "<4A4>", "<4z1 x42>", "()",
      "(\x1bja\x1b\xe9)", "<FEFF D83D DE00>", "(caf\xe9)", "(\xfe\xff\\000A\\000B)");
    const objects = withAttachment();
    objects[6] = `<< /Names [ ${keys.map((key, i) => `${key} ${100 + 2 * i} 0 R`).join(" ")} ] >>`;
    for (const i of keys.keys()) {
      objects[100 + 2 * i] = `<< /Type /Filespec /F (f${i}) /EF << /F ${101 + 2 * i} 0 R >> >>`;
      objects[101 + 2 * i] = streamOf(`file ${i}`);
    }
    const pdf = handPdf(objects), opened = await openPdf(pdf);
    try {
      const listed = await listAttachments(opened);
      // (Names that read the same share one place in pdf.js's list.)
      expect(listed.length).toBeGreaterThan(260);
      expect(listed.some(file => file.id === "quarterly")).toBe(true);
      for (const { id } of listed) {
        const theirs = new TextDecoder().decode(await opened.getAttachmentContent(id) as Uint8Array);
        expect((await save(pdf, {}, id)).outcome, JSON.stringify(id)).toBe(theirs);
      }
    } finally { await opened.loadingTask.destroy(); }
  });

  it("takes the first entry that reads as the id, with the file of the last entry written just like it", async () => {
    const objects = withAttachment();
    objects[6] = "<< /Names [ (a.txt) 7 0 R <612E747874> 4 0 R (a.txt) 4 0 R <FEFF0061002E007400780074> 7 0 R ] >>";
    objects[7] = "<< /Type /Filespec /F (a.txt) /EF << /F 8 0 R >> >>";
    objects[8] = streamOf("another\n");
    const pdf = handPdf(objects), opened = await openPdf(pdf);
    try {
      expect(new TextDecoder().decode(await opened.getAttachmentContent("a.txt") as Uint8Array)).toBe("hello\n");
    } finally { await opened.loadingTask.destroy(); }
    expect((await save(pdf)).outcome).toBe("hello\n");
  });

  it("stops unpacking the file's own structure at the limit, counting everything it unpacks together", async () => {
    const { 4: spec, 6: tree, ...plain } = withAttachment();
    // One packed list of objects that unpacks to 8 MB from a few kilobytes.
    const bomb = await packedPdf(plain, { 4: spec as string, 6: tree as string }, { padding: 8 * 1024 * 1024 });
    expect(bomb.length).toBeLessThan(20_000);
    const stopped = await save(bomb, { work: 1024 * 1024 });
    expect(refused(stopped.outcome)).toBe(TOO_LARGE);
    expect(stopped.used.work).toBeLessThanOrEqual(1024 * 1024);
    expect((await save(bomb)).outcome).toBe("hello\n");

    // Two, each within the limit and together past it: what is unpacked is counted twice over, as it is held twice.
    const first = await packedPdf(plain, { 6: tree as string }, { padding: 300_000, pack: 20, table: 22 });
    const second = bytesOf(first.subarray(0, tableOf(first)), "21 0 obj\n",
      streamOf(await pack(bytesOf(`4 0 ${spec}`, " ".repeat(300_000))), "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode"), "\nendobj\n");
    const lines = [[0, 0, 0], ...[1, 2, 3].map(num => [1, find(first, `${num} 0 obj`), 0]), [2, 21, 0], [1, find(first, "5 0 obj"), 0], [2, 20, 0]];
    const rest = { 20: find(first, "20 0 obj"), 21: tableOf(first), 22: second.length };
    const index = `/Index [0 7 20 3] /Size 23`;
    const rows = [...lines, ...Object.values(rest).map(offset => [1, offset, 0])]
      .flatMap(([kind, where, extra]) => [kind, where >>> 24, (where >>> 16) & 255, (where >>> 8) & 255, where & 255, extra >>> 8, extra & 255]);
    const both = bytesOf(second, "22 0 obj\n", streamOf(Uint8Array.from(rows), `/Type /XRef ${index} /W [1 4 2] /Root 1 0 R`), `\nendobj\nstartxref\n${second.length}\n%%EOF\n`);
    const room = (await save(both)).used.work;
    expect(room).toBeGreaterThan(4 * 300_000);
    expect((await save(both, { work: room })).outcome).toBe("hello\n");
    const over = await save(both, { work: room - 1000 });
    expect(refused(over.outcome)).toBe(TOO_LARGE);
    // (Either one alone fits in what the two were refused for.)
    expect(over.used.work).toBeGreaterThan(2 * 300_000);
    expect(over.used.work).toBeLessThan(room);
  });

  it("stops at its limits on how much it reads: tokens, strings, nesting and revisions", async () => {
    const objects = withAttachment();
    objects[6] = `<< /Names [ ${Array.from({ length: 5000 }, (_, i) => `(n${i}) 4 0 R`).join(" ")} (a.txt) 4 0 R ] >>`;
    const many = handPdf(objects), needed = (await save(many)).used.tokens;
    expect(needed).toBeGreaterThan(20_000);
    expect((await save(many, { tokens: needed })).outcome).toBe("hello\n");
    const tokens = await save(many, { tokens: 2000 });
    expect(refused(tokens.outcome)).toBe(TOO_LARGE);
    expect(tokens.used.tokens).toBe(2001);

    // A megabyte of string in an object on the way to the file.
    const long = handPdf({ ...withAttachment(), 6: `<< /Limits [ (${"x".repeat(1024 * 1024)}) ] /Names [ (a.txt) 4 0 R ] >>` });
    const string = await save(long, { work: 100_000 });
    expect(refused(string.outcome)).toBe(TOO_LARGE);
    expect(string.used.work).toBe(100_001);
    expect((await save(long)).outcome).toBe("hello\n");

    const deep = handPdf({ ...withAttachment(), 6: `<< /Deep ${"[".repeat(100)}${"]".repeat(100)} /Names [ (a.txt) 4 0 R ] >>` });
    expect(refused((await save(deep)).outcome)).toBe(TOO_LARGE);
    expect((await save(deep, { depth: 100 })).outcome).toBe("hello\n");

    // Saved six times over.
    let revised = handPdf(withAttachment());
    for (let i = 0; i < 5; i++) revised = handPdf({ 3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>" }, { onto: revised });
    expect((await save(revised, { sections: 6 })).outcome).toBe("hello\n");
    const sections = await save(revised, { sections: 5 });
    expect(refused(sections.outcome)).toBe(TOO_LARGE);
    expect(sections.used.sections).toBe(6);
  });

  it("neither builds nor waits for what a table only claims to hold", async () => {
    const pdf = handPdf(withAttachment()), table = tableOf(pdf);
    const claiming = (was: string, now: string) => {
      const text = String.fromCharCode(...pdf);
      expect(text).toContain(was);
      return bytesOf(text.slice(0, table), text.slice(table).replace(was, now));
    };
    const started = performance.now();
    // Four thousand million lines in a table of seven.
    const lines = await save(claiming("0 7\n", "0 4000000000\n"));
    expect(refused(lines.outcome)).toBe(CANT_SAVE);
    expect(lines.used.tokens).toBeLessThan(100);
    // A revision before this one that is this one, and one that is nowhere.
    expect((await save(claiming("/Root 1 0 R", `/Root 1 0 R /Prev ${table}`))).outcome).toBe("hello\n");
    expect(refused((await save(claiming("/Root 1 0 R", "/Root 1 0 R /Prev 99999999"))).outcome)).toBe(CANT_SAVE);

    const { 4: spec, 6: tree, ...plain } = withAttachment();
    const packed = await packedPdf(plain, { 4: spec as string, 6: tree as string });
    const edited = (was: string, now: string) => {
      const text = String.fromCharCode(...packed);
      expect(text).toContain(was);
      return bytesOf(text.replace(was, now));
    };
    // The same claims in the new layout: a table of a thousand million lines, and as many objects packed in a stream.
    const index = await save(edited("/Size 22", "/Index [0 1000000000] /Size 22"));
    expect(refused(index.outcome)).toBe(CANT_SAVE);
    const count = await save(edited("/N 2 ", "/N 1000000000 "));
    expect(refused(count.outcome)).toBe(CANT_SAVE);
    expect(count.used.tokens).toBeLessThan(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("refuses a PDF that doesn't hold together, rather than repair it", async () => {
    const objects = withAttachment(), pdf = handPdf(objects);
    const text = String.fromCharCode(...pdf);
    const edited = (was: string, now: string) => { expect(text).toContain(was); return bytesOf(text.replace(was, now)); };
    // An object that isn't where the table says (pdf.js would search the file for it).
    expect(refused((await save(edited("4 0 obj", "9 0 obj"))).outcome)).toBe(CANT_SAVE);
    expect(refused((await save(edited("startxref", "startxerf"))).outcome)).toBe(CANT_SAVE);
    // A stated length that doesn't lead to the end of the data.
    expect(refused((await save(edited("/Length 6", "/Length 4"))).outcome)).toBe(CANT_SAVE);
    // A tree of names that comes back round to itself.
    const loop = handPdf({ ...objects, 6: "<< /Kids [ 7 0 R ] >>", 7: "<< /Kids [ 6 0 R ] >>" });
    expect(refused((await save(loop)).outcome)).toBe(CANT_SAVE);
    expect(refused((await save(handPdf(objects, { trailer: "/Root 1 0 R /Encrypt << /Filter /Standard >>" }))).outcome))
      .toBe("Folio can't save files attached to a protected PDF.");
    // The length kept in an object of its own, and the data ending in a line break of its own.
    const apart = handPdf({ ...objects, 5: bytesOf("<< /Length 7 0 R >>\nstream\nhello\r\nendstream"), 7: "6" });
    expect((await save(apart)).outcome).toBe("hello\r");
  });
});

function find(bytes: Uint8Array, word: string) {
  const at = String.fromCharCode(...bytes.subarray(0, 4096)).search(new RegExp(`(^|\\n)${word}\\n`));
  if (at < 0) throw new Error(`No ${word}`);
  return at ? at + 1 : 0;
}
