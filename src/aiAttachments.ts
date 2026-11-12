// Ask AI can read other open documents along with the one its conversation belongs to.

export type DocText = { text: string; truncated: boolean; recognized: boolean };

/** Characters of document text sent with a question, shared by every document in it. */
export const MAX_DOC_CHARS = 400_000;

/** Documents that can be added to one conversation; the main process accepts no more. */
export const MAX_ATTACHMENTS = 20;

/** A document added to a conversation. Saved with the conversation; its text is read again when asked. */
export interface Attachment { name: string; contentId: string }

/** Same-name PDFs need separate names in the prompt and citations; keep those names with the conversation. */
export function distinctAttachmentNames(mainName: string, attachments: Attachment[]): Attachment[] {
  const key = (name: string) => name.trim().replace(/\.pdf$/i, "").toLowerCase();
  const reserved = new Set([mainName, ...attachments.map(a => a.name)].map(key));
  const seen = new Set([key(mainName)]);
  return attachments.map(attachment => {
    if (!seen.has(key(attachment.name))) { seen.add(key(attachment.name)); return attachment; }
    const extension = attachment.name.match(/\.pdf$/i)?.[0] ?? "";
    const stem = extension ? attachment.name.slice(0, -extension.length) : attachment.name;
    let number = 2, name: string;
    do { name = `${stem} (${number++})${extension}`; } while (reserved.has(key(name)));
    reserved.add(key(name));
    seen.add(key(name));
    return { ...attachment, name };
  });
}

/** Fit every document of a question into one shared budget, cutting at page boundaries. */
export function shareBudget(documents: AiDocument[], budget = MAX_DOC_CHARS): AiDocument[] {
  const blocks = documents.map(doc => pageBlocks(doc.text));
  // Water-filling: documents shorter than an equal share keep all their text; the rest split what is left.
  const lengths = documents.map(doc => doc.text.length);
  let pending = documents.map((_, i) => i);
  let remaining = budget;
  const caps = documents.map(() => 0);
  while (pending.length > 0) {
    const share = remaining / pending.length;
    const keepers = pending.filter(i => lengths[i] <= share);
    if (keepers.length === 0) break;
    for (const i of keepers) caps[i] = Infinity;
    pending = pending.filter(i => !keepers.includes(i));
    remaining -= keepers.reduce((sum, i) => sum + lengths[i], 0);
  }
  for (const i of pending) caps[i] = remaining / pending.length;
  return documents.map((doc, i) => {
    if (caps[i] === Infinity) return doc;
    let text = "";
    for (const block of blocks[i]) {
      if (text.length + block.length > caps[i]) break;
      text += block;
    }
    // A document whose first page alone doesn't fit its share is sent without text.
    return { ...doc, text, truncated: true };
  });
}

/** Notes to show under the chat for documents the question could not fully include. */
export function documentNotes(documents: AiDocument[]): string[] {
  return documents.flatMap(doc => {
    if (doc.truncated && doc.text === "") return [`${doc.name} is too long to include alongside the other documents, so none of it was sent.`];
    if (doc.truncated) return [`Only the first pages of ${doc.name} were sent.`];
    if (doc.text === "") return [`${doc.name} has no readable text yet. If it's a scan, wait for text recognition to finish.`];
    return [];
  });
}

/** Whole "[Page N]" blocks; a final page cut short by extraction counts as one block. */
function pageBlocks(text: string): string[] {
  const starts: number[] = [];
  // Only markers at the start of a line, so "[Page 3]" quoted inside a page's own text is not a boundary.
  const marker = /(?<=^|\n)\[Page \d+\]\n/g;
  for (let match = marker.exec(text); match; match = marker.exec(text)) starts.push(match.index);
  if (starts.length === 0) return text === "" ? [] : [text];
  if (starts[0] > 0) starts.unshift(0); // keep any text before the first marker with the first page
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}
