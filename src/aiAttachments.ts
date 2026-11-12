// Ask AI can read other open documents along with the one its conversation belongs to.

export type DocText = { text: string; truncated: boolean; recognized: boolean };

/** Characters of document text sent with a question, shared by every document in it. */
export const MAX_DOC_CHARS = 400_000;

/** A document added to a conversation. Saved with the conversation; its text is read again when asked. */
export interface Attachment { name: string; contentId: string }
