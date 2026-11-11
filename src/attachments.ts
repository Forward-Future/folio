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

/** The attached file exactly as it was embedded. A few hundred bytes can unpack to gigabytes, so there is a limit. */
export async function attachmentBytes(pdf: Pick<PDFDocumentProxy, "getAttachmentContent">, id: string, limit = MAX_PDF_BYTES) {
  const bytes = await pdf.getAttachmentContent(id);
  if (!bytes) throw new Error("This attachment has no content.");
  if (bytes.byteLength > limit) throw new Error("This attachment is too large to save.");
  return bytes;
}

/** Text from the PDF, which is untrusted, on one line: no control or direction characters that would show it as
 *  something else ("exe.jpg"), and no run of blank characters that would push its ending out of sight. The joiners
 *  that Persian and Indic text needs are kept. */
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
