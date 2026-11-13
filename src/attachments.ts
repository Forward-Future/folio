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
const RUNNABLE = new Set(("exe com scr pif bat cmd msi msp msix msixbundle appx appxbundle appinstaller ps1 psm1 psd1 ps1xml psc1 vb vbs vbe js jse "
  + "ws wsf wsc wsh sct hta cpl msc ocx xll lnk url website reg jar jnlp dll sys inf scf chm gadget diagcab application appref-ms "
  + "settingcontent-ms library-ms search-ms iso img vhd vhdx docm dotm xlsm xlam pptm iqy slk app command dmg pkg mpkg scpt scptd "
  + "applescript osax workflow action terminal tool webloc inetloc fileloc mobileconfig prefpane sh bash zsh csh ksh fish run "
  + "appimage deb rpm desktop py pyc pyw pyz pyzw pl rb php").split(" "));

/**
 * Whether opening the saved file could run it. Windows drops dots and spaces after the ending, and reads what follows
 * a colon as a second name for the same file, so neither hides the ending.
 */
export function runsWhenOpened(name: string) {
  return [name, name.split(":")[0]].some((name) => {
    const ending = /\.([^.]+)$/.exec(name.replace(/[. ‌‍]+$/, ""))?.[1].toLowerCase();
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
 */
export async function attachmentBytes(source: Uint8Array, id: string, limit = MAX_PDF_BYTES,
  unpacker = (): ReadableWritablePair<Uint8Array, Uint8Array> => new DecompressionStream("deflate") as ReadableWritablePair<Uint8Array, Uint8Array>) {
  const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString } = await import("pdf-lib");
  const name = PDFName.of;
  const pdf = await PDFDocument.load(source, { updateMetadata: false, ignoreEncryption: true });
  // pdf-lib can't read a protected file, and handing it to pdf.js instead would unpack the attachment without a limit.
  if (pdf.isEncrypted) throw new AttachmentError("Folio can't save files attached to a protected PDF.");

  // The same walk as pdf.js, whose list gave us `id`: a node with Kids has no entries of its own, and the last entry
  // with a name is the one that counts.
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
      if ((key instanceof PDFString || key instanceof PDFHexString) && key.decodeText() === id) spec = entries.lookup(i + 1);
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
  // Some writers put a single filter in a list.
  const only = (value: unknown) => value instanceof PDFArray && value.size() === 1 ? value.lookup(0) : value;
  const filter = only(dict.lookup(name("Filter"))), parms = only(dict.lookup(name("DecodeParms"))), length = dict.lookup(name("Length"));
  const packed = filter === name("FlateDecode") || filter === name("Fl");
  const predictor = parms instanceof PDFDict ? parms.lookup(name("Predictor")) : parms;
  if ((filter && !packed) || (predictor && !(predictor instanceof PDFNumber && predictor.asNumber() === 1))
    || ["F", "FFilter", "DP"].some(key => dict.get(name(key), true))
    // Without a length that fits, pdf-lib looked for the end of the data itself and may have stopped early.
    || !(length instanceof PDFNumber) || length.asNumber() !== contents.length) {
    throw new AttachmentError("This attachment is stored in a way Folio can't save.");
  }
  if (!packed) {
    if (contents.length > limit) throw new AttachmentError("This attachment is too large to save.");
    return new Blob([contents as Uint8Array<ArrayBuffer>]);
  }
  // Chromium unpacks all of a piece it is given before anyone can count the result, and a piece can grow a
  // thousandfold, so the pieces are kept small.
  let at = 0;
  const pieces = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < contents.length) controller.enqueue(contents.subarray(at, at += UNPACK_STEP));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  return readWithin(pieces.pipeThrough(unpacker()), limit);
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
