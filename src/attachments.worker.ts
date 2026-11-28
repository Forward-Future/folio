import { AttachmentError, attachmentBytes } from "./attachments";

self.onmessage = async ({ data }: MessageEvent<{ source: Uint8Array; id: string }>) => {
  try {
    self.postMessage({ file: await attachmentBytes(data.source, data.id) });
  } catch (error) {
    // Only a message written for the reader goes back; anything else gets the reader's general one.
    self.postMessage({ error: error instanceof AttachmentError ? error.message : null });
  }
};
