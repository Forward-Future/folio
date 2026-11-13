import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
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
async function pdfStoring(contents: Uint8Array, settings: Record<string, unknown> = {}) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]);
  const stream = pdf.context.register(pdf.context.stream(contents, { Type: "EmbeddedFile", ...settings }));
  const file = pdf.context.obj({ Type: "Filespec", F: PDFString.of("file.bin"), EF: { F: stream } });
  pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({ EmbeddedFiles: { Names: [PDFString.of("file.bin"), file] } }));
  return pdf.save();
}

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

  it("returns a file stored without packing, or with its one filter in a list", async () => {
    expect(await saved(attachmentBytes(await pdfStoring(binary), "file.bin"))).toEqual(Array.from(binary));
    expect(await saved(attachmentBytes(await pdfStoring(await pack(binary), { Filter: "Fl" }), "file.bin"))).toEqual(Array.from(binary));
    const listed = await pdfStoring(await pack(binary), { Filter: ["FlateDecode"], DecodeParms: [{ Predictor: 1 }] });
    expect(await saved(attachmentBytes(listed, "file.bin"))).toEqual(Array.from(binary));
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
    await expect(attachmentBytes(bytes, "figures.bin", binary.length - 1)).rejects.toThrow("too large");
    expect((await attachmentBytes(bytes, "figures.bin", binary.length)).size).toBe(binary.length);
    await expect(attachmentBytes(await pdfStoring(binary), "file.bin", binary.length - 1)).rejects.toThrow("too large");
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
    await expect(attachmentBytes(await pdfStoring(zeros, { Filter: "FlateDecode" }), "file.bin", 4096, counted)).rejects.toThrow("too large");
    expect(largest).toBe(16 * 1024);
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
      "setup.exe\u200d", "setup.exe::$DATA", "notes.txt:run.exe", "Budget.xlsm", "console.msc", "disk.iso"]) {
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
