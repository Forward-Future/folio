import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { attachmentBytes, listAttachments, plainText, saveName } from "./attachments";
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
    const pdf = await openPdf(await pdfWith([{ name: "figures.bin", bytes: binary }, { name: "notes.txt", bytes: text }]));
    try {
      const [figures, notes] = await listAttachments(pdf);
      expect(Array.from(await attachmentBytes(pdf, figures.id))).toEqual(Array.from(binary));
      expect(Array.from(await attachmentBytes(pdf, notes.id))).toEqual(Array.from(text));
    } finally { await pdf.loadingTask.destroy(); }
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
    const pdf = await openPdf(await pdfWith([{ name: "figures.bin", bytes: binary }]));
    try {
      const [figures] = await listAttachments(pdf);
      await expect(attachmentBytes(pdf, figures.id, binary.length - 1)).rejects.toThrow("too large");
      expect((await attachmentBytes(pdf, figures.id, binary.length)).length).toBe(binary.length);
    } finally { await pdf.loadingTask.destroy(); }
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
