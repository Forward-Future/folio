import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from "pdf-lib";
import DecodeStream from "pdf-lib/es/core/streams/DecodeStream";
import { attachmentBytes, listAttachments, plainText, readWithin, runsWhenOpened, saveName } from "./attachments";
import { protectedByOwner } from "./testing/fixtures";
import { openPdf } from "./testing/pdfjs";

// Every byte value, so a text decoding or a dropped filter anywhere on the way out would show.
const binary = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) % 256);
const text = new TextEncoder().encode("Quarterly figures — see the spreadsheet.\n");

async function pdfWith(files: { name: string; bytes: Uint8Array; description?: string }[]) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  for (const file of files) await pdf.attach(file.bytes, file.name, { description: file.description });
  return pdf.save();
}

/** A PDF whose one attached file, "file.bin", is stored as `contents` with these stream settings (its filters, say). */
async function pdfStoring(contents: Uint8Array, settings: Record<string, unknown> = {}, shape: (pdf: PDFDocument, stream: PDFRef) => unknown = defaultTree) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  const stream = pdf.context.register(pdf.context.stream(contents, { Type: "EmbeddedFile", ...settings }));
  pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ EmbeddedFiles: shape(pdf, stream) } as never));
  return pdf.save();
}
const fileSpec = (pdf: PDFDocument, files: Record<string, PDFRef>) => pdf.context.obj({ Type: "Filespec", F: PDFString.of("file.bin"), EF: files });
const defaultTree = (pdf: PDFDocument, stream: PDFRef) => ({ Names: [PDFString.of("file.bin"), fileSpec(pdf, { F: stream })] });

const pack = async (bytes: Uint8Array) => new Uint8Array(await new Response(
  new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
const saved = async (file: Promise<Blob>) => Array.from(new Uint8Array(await (await file).arrayBuffer()));

describe("document attachments", () => {
  it("lists the files embedded in the document with their names and descriptions", async () => {
    const pdf = await openPdf(await pdfWith([
      { name: "figures.bin", bytes: binary, description: "Raw figures" },
      { name: "notes.txt", bytes: text },
    ]));
    try {
      expect((await listAttachments(pdf)).map(({ name, description }) => ({ name, description }))).toEqual([
        { name: "figures.bin", description: "Raw figures" },
        { name: "notes.txt", description: "" },
      ]);
    } finally { await pdf.loadingTask.destroy(); }
  });

  it("returns each file's bytes exactly as they were attached", async () => {
    const bytes = await pdfWith([{ name: "figures.bin", bytes: binary }, { name: "notes.txt", bytes: text }, { name: "empty", bytes: new Uint8Array() }]);
    const pdf = await openPdf(bytes);
    try {
      const [figures, notes, empty] = await listAttachments(pdf);
      expect(await saved(attachmentBytes(bytes, figures.id))).toEqual(Array.from(binary));
      expect(await saved(attachmentBytes(bytes, notes.id))).toEqual(Array.from(text));
      expect(await saved(attachmentBytes(bytes, empty.id))).toEqual([]);
      await expect(attachmentBytes(bytes, "missing")).rejects.toThrow("no content");
    } finally { await pdf.loadingTask.destroy(); }
  });

  it("returns a file stored without packing, or in the ways PDF writers vary the packing", async () => {
    const packed = await pack(binary);
    const stored = async (contents: Uint8Array, settings?: Record<string, unknown>) => saved(attachmentBytes(await pdfStoring(contents, settings), "file.bin"));
    expect(await stored(binary)).toEqual(Array.from(binary));
    expect(await stored(packed, { Filter: "Fl" })).toEqual(Array.from(binary));
    expect(await stored(packed, { Filter: ["FlateDecode"], DecodeParms: [{ Predictor: 1 }] })).toEqual(Array.from(binary));
    expect(await stored(packed, { Filter: ["FlateDecode"], DecodeParms: [null] })).toEqual(Array.from(binary));
    // qpdf stores an empty file as packed data of no length at all.
    expect(await stored(new Uint8Array(), { Filter: "FlateDecode" })).toEqual([]);
    // A line break after the data that was counted as part of it.
    expect(await stored(Uint8Array.of(...packed, 13, 10), { Filter: "FlateDecode" })).toEqual(Array.from(binary));
    await expect(stored(packed.subarray(0, packed.length - 8), { Filter: "FlateDecode" })).rejects.toThrow();
  });

  it("finds the file pdf.js listed: by the name it read, and the stream it would take", async () => {
    const other = new TextEncoder().encode("the other file");
    // A name starting with the UTF-8 mark, which pdf-lib reads differently from pdf.js.
    const marked = await pdfStoring(binary, {}, (pdf, stream) => ({ Names: [PDFHexString.of("EFBBBF66696C65"), fileSpec(pdf, { F: stream })] }));
    const pdf = await openPdf(marked);
    try {
      const [file] = await listAttachments(pdf);
      expect(file.id).toBe("file");
      expect(await saved(attachmentBytes(marked, file.id))).toEqual(Array.from(binary));
    } finally { await pdf.loadingTask.destroy(); }
    // Of a file kept under several keys, the first of pdf.js's order is the one.
    const both = await pdfStoring(binary, {}, (pdf, stream) => ({ Names: [PDFString.of("file.bin"),
      fileSpec(pdf, { F: pdf.context.register(pdf.context.stream(other)), UF: stream })] }));
    expect(await saved(attachmentBytes(both, "file.bin"))).toEqual(Array.from(binary));
    // pdf.js lists nothing from a node that has Kids, whatever else it holds.
    const parent = await pdfStoring(binary, {}, (pdf, stream) => ({ Kids: 0, Names: [PDFString.of("file.bin"), fileSpec(pdf, { F: stream })] }));
    await expect(attachmentBytes(parent, "file.bin")).rejects.toThrow("no content");
  });

  it("stops reading a PDF whose packed lists of objects unpack past the limit", async () => {
    // What pdf-lib unpacks just to open the file: 8 MB here, from a few kilobytes.
    const hidden = (pdf: PDFDocument, stream: PDFRef) => {
      pdf.context.register(pdf.context.stream(zeros, { Type: "ObjStm", N: 0, First: 0, Filter: "FlateDecode" }));
      return defaultTree(pdf, stream);
    };
    const zeros = await pack(new Uint8Array(8 * 1024 * 1024));
    const bytes = await pdfStoring(binary, {}, hidden);
    expect(bytes.length).toBeLessThan(100_000);
    // How far pdf-lib's unpackers were let to grow their output.
    const unpackers = DecodeStream.prototype as unknown as { ensureBuffer(requested: number): Uint8Array };
    const grow = unpackers.ensureBuffer;
    let largest = 0;
    unpackers.ensureBuffer = function (requested) { largest = Math.max(largest, requested); return grow.call(this, requested); };
    try {
      await expect(attachmentBytes(bytes, "file.bin", { openLimit: 1024 * 1024 })).rejects.toThrow("too large for Folio");
      expect(largest).toBeLessThanOrEqual(1024 * 1024);
      expect(await saved(attachmentBytes(bytes, "file.bin", { openLimit: 32 * 1024 * 1024 }))).toEqual(Array.from(binary));
      expect(largest).toBeGreaterThan(4 * 1024 * 1024);
    } finally { unpackers.ensureBuffer = grow; }
  });

  it("lists nothing for a document without attachments", async () => {
    const pdf = await openPdf(await pdfWith([]));
    try {
      expect(await listAttachments(pdf)).toEqual([]);
    } finally { await pdf.loadingTask.destroy(); }
  });

  it("lists only as many files, and as much of a description, as it was asked to", async () => {
    const pdf = await openPdf(await pdfWith([
      { name: "one.txt", bytes: text, description: "d".repeat(2000) }, { name: "two.txt", bytes: text }, { name: "three.txt", bytes: text },
    ]));
    try {
      const listed = await listAttachments(pdf, 2);
      expect(listed.map(file => file.name)).toEqual(["one.txt", "two.txt"]);
      expect(listed[0].description.length).toBe(500);
    } finally { await pdf.loadingTask.destroy(); }
  });

  it("refuses a file that unpacks to more than the size limit", async () => {
    const bytes = await pdfWith([{ name: "figures.bin", bytes: binary }]);
    await expect(attachmentBytes(bytes, "figures.bin", { limit: binary.length - 1 })).rejects.toThrow("too large");
    expect((await attachmentBytes(bytes, "figures.bin", { limit: binary.length })).size).toBe(binary.length);
    await expect(attachmentBytes(await pdfStoring(binary), "file.bin", { limit: binary.length - 1 })).rejects.toThrow("too large");
  });

  it("stops reading once the limit is passed, without asking for the rest", async () => {
    let asked = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { asked++; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(readWithin(endless, 4096)).rejects.toThrow("too large");
    expect(asked).toBe(5);
    expect(cancelled).toBe(true);
  });

  it("unpacks a file that packs small only as far as the limit, a small piece at a time", async () => {
    // 64 MB in one packed block. Chromium unpacks every piece it is handed in full, so what counts is how much it is handed.
    const zeros = await pack(new Uint8Array(64 * 1024 * 1024));
    expect(zeros.length).toBeLessThan(100_000);
    let largest = 0, handed = 0, unpacked = 0;
    const counted = () => {
      const unpacker = new DecompressionStream("deflate") as ReadableWritablePair<Uint8Array, Uint8Array>;
      const before = new TransformStream<Uint8Array, Uint8Array>({ transform(piece, next) {
        largest = Math.max(largest, piece.length); handed += piece.length; next.enqueue(piece);
      } });
      const after = new TransformStream<Uint8Array, Uint8Array>({ transform(piece, next) { unpacked += piece.length; next.enqueue(piece); } });
      void before.readable.pipeTo(unpacker.writable).catch(() => {});
      return { writable: before.writable, readable: unpacker.readable.pipeThrough(after) };
    };
    await expect(attachmentBytes(await pdfStoring(zeros, { Filter: "FlateDecode" }), "file.bin", { limit: 4096, unpacker: counted })).rejects.toThrow("too large");
    expect(largest).toBe(16 * 1024);
    expect(handed).toBeLessThanOrEqual(4 * 16 * 1024);
    // A file refused for its size isn't tried a second time, as one that merely ends in a stray line break is.
    handed = 0;
    await expect(attachmentBytes(await pdfStoring(Uint8Array.of(...zeros, 10), { Filter: "FlateDecode" }), "file.bin", { limit: 4096, unpacker: counted })).rejects.toThrow("too large");
    expect(handed).toBeLessThanOrEqual(4 * 16 * 1024);
    expect(unpacked).toBeGreaterThan(4096);
    expect(unpacked).toBeLessThan(4 * 1024 * 1024);
  });

  it("refuses a file stored in a way it can't read correctly or unpack within a limit", async () => {
    const refused = async (contents: Uint8Array, settings: Record<string, unknown>) =>
      expect(attachmentBytes(await pdfStoring(contents, settings), "file.bin")).rejects.toThrow("can't save");
    const packed = await pack(binary);
    await refused(new TextEncoder().encode("48656c6c6f>"), { Filter: "ASCIIHexDecode" });
    // Packed twice: the first unpacking could grow a thousandfold without a byte of the file coming out.
    await refused(await pack(packed), { Filter: ["FlateDecode", "FlateDecode"] });
    await refused(packed, { Filter: "FlateDecode", DecodeParms: { Predictor: 12, Columns: 4 } });
    await refused(packed, { F: "FlateDecode" });
    // A stated length that doesn't lead to the end of the data: pdf-lib then guesses where the data ends.
    const wrongLength = await pdfStoring(packed, { Filter: "FlateDecode" });
    const stated = new TextEncoder().encode(`/Length ${packed.length}`);
    const at = wrongLength.findIndex((_, i) => stated.every((byte, j) => wrongLength[i + j] === byte));
    expect(at).toBeGreaterThan(0);
    wrongLength.set(new TextEncoder().encode(`/Length ${packed.length - 1}`), at);
    await expect(attachmentBytes(wrongLength, "file.bin")).rejects.toThrow("can't save");
  });

  it("says so when the PDF is protected, where it can't unpack a file within a limit", async () => {
    await expect(attachmentBytes(protectedByOwner, "figures.bin")).rejects.toThrow("protected PDF");
  });

  it("knows which names would run when the saved file is opened", () => {
    for (const name of ["setup.exe", "Invoice.PDF.Exe", "run.bat", "install.sh", "Tool.app", "notes.desktop", "update.msi", "report.pdf.js", "setup.exe.", "setup.exe . ",
      "setup.exe\u200d", "setup.exe::$DATA", "notes.txt:run.exe", "Budget.xlsm", "console.msc", "disk.iso",
      "run.vb\u017f", "setup.m\u017f\u0131", "office.rdp", "page.hta", "Slides.ppsm", "tool.snap"]) {
      expect(runsWhenOpened(name), name).toBe(true);
    }
    for (const name of ["figures.bin", "notes.txt", "README", "exe", "report.exe.pdf", "photo.jpeg", "data.json"]) {
      expect(runsWhenOpened(name), name).toBe(false);
    }
  });

  it("keeps a name from hiding its ending behind blank or invisible characters", () => {
    expect(saveName("invoice.pdf" + "\u00a0".repeat(200) + ".exe")).toBe("invoice.pdf .exe");
    expect(saveName("invoice.pdf\u2800\u3164.exe")).toBe("invoice.pdf .exe");
    expect(saveName("invoice.pdf\u200b.exe")).toBe("invoice.pdf.exe");
    expect(saveName("a\u2028b\u0085.txt")).toBe("ab.txt");
    expect(saveName(". .bashrc")).toBe("bashrc");
    // Joiners that Persian and Indic names need are kept.
    expect(saveName("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.pdf")).toBe("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.pdf");
    const long = saveName("a".repeat(5000) + ".txt");
    expect(long.length).toBe(255);
    expect(long.endsWith(".txt")).toBe(true);
    expect(plainText("Raw\u202e figures\n\u00a0 here")).toBe("Raw figures here");
  });

  it("keeps a name from the PDF from being a path or a hidden file", () => {
    expect(saveName("report.pdf")).toBe("report.pdf");
    expect(saveName("..\\..\\Start Menu\\run.bat")).toBe("run.bat");
    expect(saveName("../../.bashrc")).toBe("bashrc");
    expect(saveName("a\u0000b\n.txt")).toBe("ab.txt");
    expect(saveName("")).toBe("attachment");
    // Right-to-left override: would be shown as "exe.jpg" while the file is gpj.exe.
    expect(saveName("\u202Egpj.exe")).toBe("gpj.exe");
    expect(saveName("invoice.pdf\u2066.exe\u200F")).toBe("invoice.pdf.exe");
    expect(saveName("\u05E9\u05DC\u05D5\u05DD.pdf")).toBe("\u05E9\u05DC\u05D5\u05DD.pdf");
    expect(saveName(undefined)).toBe("attachment");
  });
});
