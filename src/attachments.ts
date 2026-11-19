import type { PDFDocumentProxy } from "pdfjs-dist";
import { Dict, LIMITS, PdfReader, pdfText, Ref, Refusal, Stream, type Value } from "./attachmentReader";
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

/** The first `limit` of the PDF's files, and whether it has more than those. */
export async function firstAttachments(pdf: Pick<PDFDocumentProxy, "getAttachments">, limit = MAX_ATTACHMENTS) {
  const files = await listAttachments(pdf, limit + 1);
  return { files: files.slice(0, limit), more: files.length > limit };
}

// Endings that Windows, macOS or Linux run, install, mount or follow when the saved file is opened, rather than show.
// The first list is the one Outlook won't deliver ("Blocked attachments in Outlook", support.microsoft.com), whole, so
// that it can be checked against its source. The second adds newer Windows installers and the Office files and add-ins
// made to carry macros; the everyday Office files (doc, xls, dot), which may carry one too, are not here, or the
// question would lose its meaning. The third is what macOS and Linux run.
const RUNNABLE = new Set([
  "ade adp apk app appcontent-ms application appref-ms appx asp aspx asx bas bat bgi cab cdxml cer chm cmd cnt com cpl "
  + "crt csh der diagcab exe fxp gadget grp hlp hpj hta htc img inf ins iso isp its jar jnlp js jse ksh library-ms lnk mad "
  + "maf mag mam maq mar mas mat mau mav maw mcf mda mdb mde mdt mdw mdz msc mht mhtml msh msh1 msh2 mshxml msh1xml msh2xml "
  + "msi msp mst msu ops osd pcd pif pl plg prf prg printerexport ps1 ps1xml ps2 ps2xml psc1 psc2 psd1 psdm1 pssc pst py "
  + "pyc pyo pyw pyz pyzw reg scf scr sct search-ms settingcontent-ms shb shs theme tmp udl url vb vbe vbp vbs vhd vhdx "
  + "vsmacros vsw webpnp website ws wsb wsc wsf wsh xbap xll xnk",
  "msix msixbundle appxbundle appinstaller ppkg psm1 ocx dll sys job vsix vsto themepack rdp docm dotm xlsm xltm xlam xla "
  + "pptm potm ppsm ppam ppa sldm wll iqy slk",
  "command dmg sparseimage pkg mpkg scpt scptd applescript osax workflow action terminal tool webloc inetloc fileloc "
  + "mobileconfig prefpane sh bash zsh fish run appimage deb rpm snap flatpakref desktop rb php",
].join(" ").split(" "));

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

/** What `stream` delivers, in the pieces it came in, as long as it is no more than `limit` bytes: past that, reading stops and nothing more is asked for. */
async function partsWithin(stream: ReadableStream<Uint8Array>, limit: number) {
  const reader = stream.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  for (let size = 0;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    if ((size += value.length) > limit) {
      void reader.cancel().catch(() => {});
      throw new AttachmentError("This attachment is too large to save.");
    }
    parts.push(value as Uint8Array<ArrayBuffer>);
  }
}

export async function readWithin(stream: ReadableStream<Uint8Array>, limit: number) {
  return new Blob(await partsWithin(stream, limit));
}

type Unpacker = () => ReadableWritablePair<Uint8Array, Uint8Array>;

/**
 * Flate data unpacked, as long as it comes to no more than `limit` bytes. Chromium unpacks all of a piece it is given
 * before anyone can count the result, and a piece can grow a thousandfold, so the pieces are kept small.
 */
async function unpackWithin(packed: Uint8Array, limit: number, unpacker: Unpacker) {
  const unpack = (data: Uint8Array) => {
    let at = 0;
    const pieces = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at < data.length) controller.enqueue(data.subarray(at, at += UNPACK_STEP));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    return partsWithin(pieces.pipeThrough(unpacker()), limit);
  };
  try {
    return await unpack(packed);
  } catch (error) {
    // Some writers count the line break after the data as part of it, which the browser's unpacker won't have.
    const end = packed.length - (packed.at(-1) === 10 ? (packed.at(-2) === 13 ? 2 : 1) : packed.at(-1) === 13 ? 1 : 0);
    if (error instanceof AttachmentError || end === packed.length) throw error;
    return unpack(packed.subarray(0, end));
  }
}

const REFUSALS = {
  limit: "This PDF is too large for Folio to save its attached files.",
  // (Reading a protected file would mean handing it to pdf.js, which unpacks an attachment without a limit.)
  protected: "Folio can't save files attached to a protected PDF.",
  unreadable: "This attachment is stored in a way Folio can't save.",
};

/**
 * The attached file exactly as it was embedded, read from the PDF's own bytes. A few hundred bytes can unpack to
 * gigabytes, and pdf.js unpacks a whole file before its size can be checked. A PDF library, for its part, reads every
 * object in the file to find one, which a small file can make cost gigabytes too. So only the objects that lead to the
 * attachment are read (`PdfReader`, which counts what it uses against `limits`), and the browser unpacks the file a
 * small piece at a time until `limit`. The app does this in a worker (`readAttachment`).
 */
export async function attachmentBytes(source: Uint8Array, id: string, { limit = MAX_PDF_BYTES, limits = LIMITS,
  unpacker = (() => new DecompressionStream("deflate")) as Unpacker, spent = (_used: PdfReader["used"]) => {} } = {}) {
  const reader = new PdfReader(source, async (packed, room) => {
    try {
      return new Uint8Array(await new Blob(await unpackWithin(packed, room, unpacker)).arrayBuffer());
    } catch (error) {
      throw error instanceof AttachmentError ? new Refusal("limit") : error;
    }
  }, limits);
  try {
    await reader.open();

    // The same walk as pdf.js, whose list gave us `id`: a node with Kids has no entries of its own, an entry written
    // twice keeps its first place and its last file, and the first entry whose name reads as `id` is the one.
    const root = await reader.get(reader.trailer, "Root"), names = root instanceof Dict ? await reader.get(root, "Names") : undefined;
    const entries = new Map<Value, Value>();
    if (names instanceof Dict && names.get("EmbeddedFiles") !== undefined) {
      const nodes = [names.get("EmbeddedFiles")], seen = new Set<string>();
      for (const node of nodes) {
        if (node instanceof Ref && seen.size === seen.add(`${node.num} ${node.gen}`).size) throw new Refusal("unreadable");
        const dict = await reader.resolve(node);
        if (!(dict instanceof Dict)) continue;
        const kids = dict.get("Kids") !== undefined, list = await reader.get(dict, kids ? "Kids" : "Names");
        if (!Array.isArray(list)) continue;
        if (kids) nodes.push(...list);
        else for (let i = 0; i < list.length; i += 2) entries.set(await reader.resolve(list[i]), list[i + 1]);
      }
    }
    let spec: Value;
    for (const [key, value] of entries) {
      // (pdf.js makes a name of anything, in its own way; all that PDF writers put here is a string.)
      if (typeof key !== "string") throw new Refusal("unreadable");
      if (pdfText(key) === id) { spec = await reader.resolve(value); break; }
    }
    const embedded = spec instanceof Dict ? await reader.get(spec, "EF") : undefined;
    const platform = embedded instanceof Dict ? ["UF", "F", "Unix", "Mac", "DOS"].find(key => embedded.get(key) !== undefined) : undefined;
    const stream = platform ? await reader.get(embedded as Dict, platform) : undefined;
    if (!(stream instanceof Stream)) throw new AttachmentError("This attachment has no content.");

    // Only what PDF writers do with attached files is read: the bytes as they are, or packed once with Flate.
    const { packed, predictor } = await reader.packing(stream), contents = await reader.contents(stream);
    if (predictor > 1) throw new Refusal("unreadable");
    if (!packed || !contents.length) {
      if (contents.length > limit) throw new AttachmentError("This attachment is too large to save.");
      return new Blob([contents as Uint8Array<ArrayBuffer>]);
    }
    return new Blob(await unpackWithin(contents, limit, unpacker));
  } catch (error) {
    throw error instanceof Refusal ? new AttachmentError(REFUSALS[error.why]) : error;
  } finally {
    spent(reader.used);
  }
}

type ReadingWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/**
 * `attachmentBytes` in a worker, so a PDF that takes long to read doesn't hold up the reader. `signal` abandons it, and
 * so does `patience` running out, counted from the call: `source` (the PDF's bytes, which pdf.js never hands over if
 * the document closes first) is part of the wait.
 */
export function readAttachment(source: Promise<Uint8Array>, id: string, signal: AbortSignal, patience = 30_000,
  start = (): ReadingWorker => new Worker(new URL("./attachments.worker.ts", import.meta.url), { type: "module" })) {
  return new Promise<Blob>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    let worker: ReadingWorker | undefined, settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      clearTimeout(timer);
      signal.removeEventListener("abort", abandon);
      outcome();
    };
    const failed = () => settle(() => reject(new Error("Couldn't read the attachment.")));
    const abandon = () => settle(() => reject(signal.reason));
    const timer = setTimeout(() => settle(() => reject(new AttachmentError("This PDF takes too long to read for Folio to save its attached files."))), patience);
    signal.addEventListener("abort", abandon);
    source.then(bytes => {
      if (settled) return;
      worker = start();
      worker.onmessage = ({ data }: MessageEvent<{ file: Blob } | { error: string | null }>) => settle(() =>
        "file" in data ? resolve(data.file) : reject(data.error ? new AttachmentError(data.error) : new Error("Couldn't read the attachment.")));
      worker.onerror = failed;
      worker.postMessage({ source: bytes, id }, [bytes.buffer as ArrayBuffer]);
    }, failed);
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
