// "Save a copy" for a document with recognized text: put the text into the copy when that is safe, and say why when not.
import type { PDFDocumentProxy } from "../../../pdf";
import type { OcrSession } from "../session/OcrSession";
import { embedRecognizedText } from "./embedText";

/** Why a copy went without the recognized text. */
export type TextProblem = "protected" | "signature" | "failed";

export interface SavedCopy {
  bytes: Uint8Array;
  /** The recognized text is in `bytes`. */
  embedded: boolean;
  problem?: TextProblem;
}

/**
 * Whether the document can't take the text: it is encrypted (pdf-lib can't read it), or has a signature field (rewriting
 * the file could break a signature). pdf.js doesn't say whether a signature field is filled in, and a blank one looks
 * just like a signed one, so any signature field counts.
 */
async function whyNot(pdf: PDFDocumentProxy): Promise<TextProblem | undefined> {
  const { info } = await pdf.getMetadata();
  if ((info as { EncryptFilterName?: string | null }).EncryptFilterName) return "protected";
  const fields = await pdf.getFieldObjects();
  for (const field of fields?.values() ?? []) {
    if (field.some((f) => (f as { type?: string }).type === "signature")) return "signature";
  }
}

/** `bytes` with the session's recognized text added; `bytes` itself, unchanged, when there is none or it can't be added. */
export async function copyWithText(session: OcrSession | null, bytes: Uint8Array): Promise<SavedCopy> {
  if (!session || ![...session.pages.values()].some((items) => items.length)) return { bytes, embedded: false };
  try {
    const problem = await whyNot(session.pdf);
    if (problem) return { bytes, embedded: false, problem };
    return { bytes: await embedRecognizedText(bytes, session.pages, session.embedded), embedded: true };
  } catch {
    return { bytes, embedded: false, problem: "failed" };
  }
}

const REASONS: Record<TextProblem, string> = {
  protected: "The recognized text can't be added to a protected file.",
  signature: "The recognized text was left out because this file has a signature field, and rewriting it could break the signature.",
  failed: "Couldn't add the recognized text.",
};

/** What to tell the reader once a copy is saved. */
export function savedMessage({ markup, embedded, problem }: { markup: boolean } & Omit<SavedCopy, "bytes">): string {
  const extras = [markup && "your highlights and notes", embedded && "the recognized text"].filter(Boolean);
  const saved = extras.length ? `Saved a copy with ${extras.join(" and ")}` : "Download started";
  return problem ? `${saved}. ${REASONS[problem]}` : saved;
}
