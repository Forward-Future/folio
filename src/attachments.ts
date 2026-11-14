import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_PDF_BYTES } from "./pdfInput";

export interface Attachment {
  /** The key pdf.js fetches the file's bytes by. */
  id: string;
  name: string;
  description: string;
}

// A PDF of a few kilobytes can name hundreds of thousands of files. These keep the list one a reader can use.
export const MAX_ATTACHMENTS = 500;
const MAX_NAME = 255;
const MAX_DESCRIPTION = 500;

/** The files embedded in the document itself, in the order the PDF lists them. Files attached to a page as an
 *  annotation aren't included. */
export async function listAttachments(pdf: Pick<PDFDocumentProxy, "getAttachments">, limit = MAX_ATTACHMENTS): Promise<Attachment[]> {
  const files = await pdf.getAttachments();
  const listed: Attachment[] = [];
  for (const [id, file] of files ?? []) {
    if (listed.length === limit) break;
    listed.push({ id, name: saveName(file.filename), description: plainText(file.description || "").slice(0, MAX_DESCRIPTION) });
  }
  return listed;
}

// Endings that Windows, macOS or Linux run, install, mount or follow when the saved file is opened, rather than show.
// Office files that carry macros are here; the everyday ones (doc, xls, html) are not, or the question would lose its meaning.
const RUNNABLE = new Set(("exe com scr pif bat cmd msi msp msu msix msixbundle appx appxbundle appinstaller ppkg cab ps1 psm1 psd1 ps1xml psc1 msh "
  + "vb vbs vbe js jse ws wsf wsc wsh sct hta cpl msc ocx xll lnk url website reg jar jnlp dll sys inf scf chm hlp gadget diagcab "
  + "application appref-ms settingcontent-ms library-ms search-ms theme themepack rdp wsb job shb shs xbap vsix vsto iso img vhd vhdx "
  + "docm dotm xlsm xltm xlam pptm potm ppsm ppam sldm iqy slk app command dmg sparseimage pkg mpkg scpt scptd applescript osax "
  + "workflow action terminal tool webloc inetloc fileloc mobileconfig prefpane sh bash zsh csh ksh fish run appimage deb rpm snap "
  + "flatpakref desktop py pyc pyw pyz pyzw pl rb php").split(" "));

/**
 * Whether opening the saved file could run it. Windows drops dots and spaces after the ending, reads what follows a
 * colon as a second name for the same file, and ignores case (which takes ſ for s, and ı for i), so none of those
 * hides the ending.
 */
export function runsWhenOpened(name: string) {
  return [name, name.split(":")[0]].some((name) => {
    const ending = /\.([^.]+)$/.exec(name.replace(/[. ‌‍]+$/, ""))?.[1].toUpperCase().toLowerCase();
    return !!ending && RUNNABLE.has(ending);
  });
}

const UNPACK_STEP = 16 * 1024;

/** A problem saving an attachment, worded for the reader. */
export class AttachmentError extends Error {}

/** What `stream` delivers, as long as it is no more than `limit` bytes: past that, reading stops and nothing more is asked for. */
export async function readWithin(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(), parts: Uint8Array[] = [];
  for (let size = 0;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(parts as Uint8Array<ArrayBuffer>[]);
    if ((size += value.length) > limit) {
      void reader.cancel().catch(() => {});
      throw new AttachmentError("This attachment is too large to save.");
    }
    parts.push(value);
  }
}

/**
 * The attached file exactly as it was embedded, read from the PDF's own bytes. A few hundred bytes can unpack to
 * gigabytes, and pdf.js and pdf-lib both unpack a whole file, or a whole block of one, before its size can be checked.
 * So pdf-lib only finds the packed bytes, and the browser unpacks them a small piece at a time until the limit.
 * Finding them means reading the whole PDF, which can take a while: the app does this in a worker (`readAttachment`).
 */
export async function attachmentBytes(source: Uint8Array, id: string, { limit = MAX_PDF_BYTES, openLimit = MAX_PDF_BYTES,
  unpacker = (): ReadableWritablePair<Uint8Array, Uint8Array> => new DecompressionStream("deflate") as ReadableWritablePair<Uint8Array, Uint8Array> } = {}) {
  const { ParseSpeeds, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFString } = await import("pdf-lib/es");
  const name = PDFName.of;

  // pdf-lib unpacks every packed list of objects in the file as it opens it, each in one go, and those can be as
  // inflated as an attachment. Its unpackers all grow their output through one method, so that is where the total is kept.
  const growing = (await import("pdf-lib/es/core/streams/DecodeStream")).default.prototype as unknown as
    { ensureBuffer(this: { buffer: Uint8Array; minBufferLength: number }, requested: number): Uint8Array };
  const grow = growing.ensureBuffer;
  let unpacked = 0;
  growing.ensureBuffer = function (requested) {
    let size = Math.max(this.buffer.byteLength, this.minBufferLength);
    while (size < requested) size *= 2;
    if ((unpacked += size - this.buffer.byteLength) > openLimit) throw new Error("Too much to unpack.");
    return grow.call(this, requested);
  };
  // (No pauses while reading: in a worker there is no one to make way for, and each pause costs a few milliseconds.)
  const pdf = await PDFDocument.load(source, { updateMetadata: false, ignoreEncryption: true, parseSpeed: ParseSpeeds.Fastest })
    .finally(() => { growing.ensureBuffer = grow; });
  // (pdf-lib carries on past an object it couldn't read, so the count is what says the limit was reached.)
  if (unpacked > openLimit) throw new AttachmentError("This PDF is too large for Folio to save its attached files.");
  // pdf-lib can't read a protected file, and handing it to pdf.js instead would unpack the attachment without a limit.
  if (pdf.isEncrypted) throw new AttachmentError("Folio can't save files attached to a protected PDF.");

  // The same walk as pdf.js, whose list gave us `id`: a node with Kids has no entries of its own, and the last entry
  // with a name is the one that counts.
  const text = (key: { asBytes(): Uint8Array; decodeText(): string }) => {
    const bytes = key.asBytes();
    // pdf-lib doesn't know the UTF-8 mark that newer PDFs may start a name with.
    return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? new TextDecoder().decode(bytes) : key.decodeText();
  };
  let spec: unknown;
  const names = pdf.catalog.lookup(name("Names"));
  const nodes: unknown[] = [names instanceof PDFDict ? names.lookup(name("EmbeddedFiles")) : undefined];
  const seen = new Set<unknown>();
  for (const node of nodes) {
    if (!(node instanceof PDFDict) || seen.has(node)) continue;
    seen.add(node);
    const kids = node.lookup(name("Kids")), entries = node.lookup(name("Names"));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) nodes.push(kids.lookup(i));
    else if (!node.get(name("Kids"), true) && entries instanceof PDFArray) for (let i = 0; i + 1 < entries.size(); i += 2) {
      const key = entries.lookup(i);
      if ((key instanceof PDFString || key instanceof PDFHexString) && text(key) === id) spec = entries.lookup(i + 1);
    }
  }
  const embedded = spec instanceof PDFDict ? spec.lookup(name("EF")) : undefined;
  let stream: unknown;
  if (embedded instanceof PDFDict) {
    const platform = ["UF", "F", "Unix", "Mac", "DOS"].map(name).find(key => embedded.get(key, true));
    stream = platform && embedded.lookup(platform);
  }
  if (!(stream instanceof PDFRawStream)) throw new AttachmentError("This attachment has no content.");

  // Only what PDF writers do with attached files is read: the bytes as they are, or packed once with Flate. Anything
  // else is refused, since pdf-lib would hand over the wrong bytes for it or it couldn't be unpacked within a limit.
  const { dict, contents } = stream;
  // Some writers put a single filter in a list, or write an empty setting out.
  const only = (value: unknown) => {
    const one = value instanceof PDFArray && value.size() === 1 ? value.lookup(0) : value;
    return one === PDFNull ? undefined : one;
  };
  const filter = only(dict.lookup(name("Filter"))), parms = only(dict.lookup(name("DecodeParms"))), length = dict.lookup(name("Length"));
  const packed = filter === name("FlateDecode") || filter === name("Fl");
  const predictor = parms instanceof PDFDict ? parms.lookup(name("Predictor")) : parms;
  if ((filter && !packed) || (predictor && !(predictor instanceof PDFNumber && predictor.asNumber() === 1))
    || ["F", "FFilter", "DP"].some(key => dict.get(name(key), true))
    // Without a length that fits, pdf-lib looked for the end of the data itself and may have stopped early.
    || !(length instanceof PDFNumber) || length.asNumber() !== contents.length) {
    throw new AttachmentError("This attachment is stored in a way Folio can't save.");
  }
  if (!packed || !contents.length) {
    if (contents.length > limit) throw new AttachmentError("This attachment is too large to save.");
    return new Blob([contents as Uint8Array<ArrayBuffer>]);
  }
  // Chromium unpacks all of a piece it is given before anyone can count the result, and a piece can grow a
  // thousandfold, so the pieces are kept small.
  const unpack = (data: Uint8Array) => {
    let at = 0;
    const pieces = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < data.length) controller.enqueue(data.subarray(at, at += UNPACK_STEP));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    return readWithin(pieces.pipeThrough(unpacker()), limit);
  };
  try {
    return await unpack(contents);
  } catch (error) {
    // Some writers count the line break after the data as part of it, which the browser's unpacker won't have.
    const end = contents.length - (contents.at(-1) === 10 ? (contents.at(-2) === 13 ? 2 : 1) : contents.at(-1) === 13 ? 1 : 0);
    if (error instanceof AttachmentError || end === contents.length) throw error;
    return unpack(contents.subarray(0, end));
  }
}

/**
 * `attachmentBytes` in a worker, so a PDF that takes long to read doesn't hold up the reader. `signal` abandons it, and
 * so does `patience` running out: pdf-lib can be made to read a small PDF for hours.
 */
export function readAttachment(source: Uint8Array, id: string, signal: AbortSignal, patience = 30_000) {
  return new Promise<Blob>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const worker = new Worker(new URL("./attachments.worker.ts", import.meta.url), { type: "module" });
    const settle = (settled: () => void) => { worker.terminate(); clearTimeout(timer); signal.removeEventListener("abort", abandon); settled(); };
    const abandon = () => settle(() => reject(signal.reason));
    const timer = setTimeout(() => settle(() => reject(new AttachmentError("This PDF takes too long to read for Folio to save its attached files."))), patience);
    signal.addEventListener("abort", abandon);
    worker.onmessage = ({ data }: MessageEvent<{ file: Blob } | { error: string | null }>) => settle(() =>
      "file" in data ? resolve(data.file) : reject(data.error ? new AttachmentError(data.error) : new Error("Couldn't read the attachment.")));
    worker.onerror = () => settle(() => reject(new Error("Couldn't read the attachment.")));
    worker.postMessage({ source, id }, [source.buffer as ArrayBuffer]);
  });
}

export function plainText(text: string) {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/gu, "")
    .replace(/[\p{Zs}\u115f\u1160\u2800\u3164\uffa0]+/gu, " ").trim();
}

/** A plain file name to show and to offer to save under: no folders, not hidden, and not too long for a file system. */
export function saveName(name: string | undefined) {
  let plain = plainText((name ?? "").replace(/\\/g, "/")).split("/").pop()!;
  while (/^[. ]/.test(plain)) plain = plain.slice(1);
  if (plain.length > MAX_NAME) {
    const ending = /\.[^.]{1,16}$/.exec(plain)?.[0] ?? "";
    plain = plain.slice(0, MAX_NAME - ending.length) + ending;
  }
  return plain || "attachment";
}
