import type { PDFDocumentProxy } from "pdfjs-dist";

// These are acceptance limits after PDF.js has decoded metadata/content, not allocation bounds.
export const MAX_ATTACHMENT_ENTRIES = 10_000;
export const MAX_ATTACHMENT_BYTES = 300 * 1024 * 1024;

export interface AttachmentItem {
  key: string;
  sourceKind: "document" | "annotation";
  retrievalId: string;
  filename: string;
  description: string;
  pageNumbers: number[];
}

export interface DiscoverySnapshot {
  items: AttachmentItem[];
  catalogLoading: boolean;
  pagesLoading: boolean;
  complete: boolean;
  isCollection: boolean;
  errors: string[];
  truncated: boolean;
}

/** Reads only metadata. A page scan failure must not hide usable catalog entries. */
export async function discoverAttachments(
  pdf: Pick<PDFDocumentProxy, "getAttachments" | "getAnnotationsByType" | "getMetadata">,
  onState: (snapshot: DiscoverySnapshot) => void,
  { signal, maxEntries = MAX_ATTACHMENT_ENTRIES }: { signal?: AbortSignal; maxEntries?: number } = {},
): Promise<DiscoverySnapshot> {
  const state: DiscoverySnapshot = {
    items: [], catalogLoading: true, pagesLoading: true, complete: false,
    isCollection: false, errors: [], truncated: false,
  };
  const itemIndex = new Map<string, AttachmentItem>();
  const publish = () => {
    if (!signal?.aborted) onState({ ...state, items: state.items.map(item => ({ ...item, pageNumbers: [...item.pageNumbers] })), errors: [...state.errors] });
  };
  const add = (item: AttachmentItem) => {
    const existing = itemIndex.get(item.key);
    if (existing) {
      existing.pageNumbers = [...new Set([...existing.pageNumbers, ...item.pageNumbers])].sort((a, b) => a - b);
    } else if (state.items.length < Math.max(0, maxEntries)) { state.items.push(item); itemIndex.set(item.key, item); }
    else state.truncated = true;
  };
  publish();
  await Promise.all([
    (async () => {
      try {
        const attachments = await pdf.getAttachments();
        if (signal?.aborted) return;
        for (const [retrievalId, file] of attachments ?? []) add({
          key: `document:${retrievalId}`, sourceKind: "document", retrievalId,
          filename: file.filename || "", description: file.description || "", pageNumbers: [],
        });
      } catch {
        if (!signal?.aborted) state.errors.push("Could not check document attachments.");
      } finally { state.catalogLoading = false; publish(); }
    })(),
    (async () => {
      try {
        // AnnotationType.FILEATTACHMENT in the pinned PDF.js API. Keep this adapter free of viewer imports.
        const annotations = await pdf.getAnnotationsByType(new Set([17]), new Set());
        if (signal?.aborted) return;
        for (const value of annotations ?? []) {
          const annotation = value as { fileId?: string; file?: { filename?: string; description?: string }; pageIndex?: number };
          if (typeof annotation.fileId !== "string" || !annotation.fileId) continue;
          add({
            key: `annotation:${annotation.fileId}`, sourceKind: "annotation", retrievalId: annotation.fileId,
            filename: annotation.file?.filename || "", description: annotation.file?.description || "",
            pageNumbers: Number.isInteger(annotation.pageIndex) && annotation.pageIndex! >= 0 ? [annotation.pageIndex! + 1] : [],
          });
        }
      } catch {
        if (!signal?.aborted) state.errors.push("Could not check page attachments.");
      } finally { state.pagesLoading = false; publish(); }
    })(),
    (async () => {
      try {
        const metadata = await pdf.getMetadata();
        if (!signal?.aborted) state.isCollection = !!(metadata.info as { IsCollectionPresent?: boolean }).IsCollectionPresent;
      } catch {
        if (!signal?.aborted) state.errors.push("Could not check PDF Portfolio information.");
      }
    })(),
  ]);
  state.complete = true;
  publish();
  return { ...state, items: [...state.items], errors: [...state.errors] };
}

export type AttachmentIntent = "save" | "read" | "page-content";
export type AttachmentActionStatus = "queued" | "extracting" | "awaiting-password" | "done" | "error" | "cancelled";
export interface AttachmentRequest {
  retrievalId: string;
  intent: AttachmentIntent;
  owner: string;
  key?: string;
}
export interface AttachmentActionState extends AttachmentRequest {
  id: string;
  status: AttachmentActionStatus;
  error?: string;
}
export interface AttachmentAction {
  id: string;
  promise: Promise<Uint8Array | null>;
  cancel(): void;
}
export interface AttachmentPasswordChallenge {
  actionId: string;
  challengeId: number;
  owner: string;
  intent: AttachmentIntent;
  reason: number;
  submit(password: string): void;
  cancel(): void;
}
interface RecordEntry {
  state: AttachmentActionState;
  action: AttachmentAction;
  resolve(value: Uint8Array | null): void;
  reject(error: unknown): void;
  settled: boolean;
  cancelled: boolean;
}
type PasswordResponse = (password: string | Error) => void;
interface BrokerOptions {
  onState?: (states: AttachmentActionState[]) => void;
  onPassword?: (challenge: AttachmentPasswordChallenge | null) => void;
  onError?: (state: AttachmentActionState, error: unknown) => void;
  maxBytes?: number;
}
const cancelledError = () => new DOMException("Attachment action cancelled.", "AbortError");

/** One broker belongs to one loaded parent PDF instance, including page-level content requests. */
export class AttachmentBroker {
  private readonly pdf: Pick<PDFDocumentProxy, "getAttachmentContent" | "loadingTask">;
  private readonly options: BrokerOptions;
  private readonly entries = new Map<string, RecordEntry>();
  private readonly states = new Map<string, AttachmentActionState>();
  private readonly listeners = new Set<(states: AttachmentActionState[]) => void>();
  private queue: RecordEntry[] = [];
  private active: RecordEntry | null = null;
  private disposed = false;
  private nextId = 0;
  private nextChallenge = 0;
  private challenge: { token: number; answer: PasswordResponse; entry: RecordEntry } | null = null;
  private readonly previousPasswordHandler: Function;
  private readonly passwordHandler = (answer: PasswordResponse, reason: number) => {
    const entry = this.active;
    // Canceled actions still own the PDF.js slot until their API promise settles. Incoming
    // challenges must be answered even when the owning UI has already gone away.
    if (this.disposed || !entry || entry.cancelled) { answer(cancelledError()); return; }
    const token = ++this.nextChallenge;
    this.challenge = { token, answer, entry };
    entry.state.status = "awaiting-password";
    this.emit();
    if (!this.options.onPassword) { this.cancel(entry); return; }
    try {
      this.options.onPassword({
        actionId: entry.state.id, challengeId: token, owner: entry.state.owner, intent: entry.state.intent, reason,
        submit: password => {
          if (this.challenge?.token !== token || entry.cancelled || this.disposed) return;
          this.challenge = null;
          this.passwordUI(null);
          entry.state.status = "extracting";
          this.emit();
          answer(password);
        },
        cancel: () => { if (this.challenge?.token === token) this.cancel(entry); },
      });
    } catch { this.cancel(entry); }
  };

  constructor(pdf: Pick<PDFDocumentProxy, "getAttachmentContent" | "loadingTask">, options: BrokerOptions = {}) {
    this.pdf = pdf;
    this.options = options;
    this.previousPasswordHandler = pdf.loadingTask.onPassword;
    pdf.loadingTask.onPassword = this.passwordHandler;
  }

  getSnapshot(): AttachmentActionState[] {
    return [...this.states.values()].map(state => ({ ...state }));
  }

  subscribe(listener: (states: AttachmentActionState[]) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  enqueue(request: AttachmentRequest): AttachmentAction {
    if (request.key) {
      const existing = [...this.entries.values()].find(entry => entry.state.key === request.key && !entry.settled);
      if (existing) return existing.action;
    }
    const id = `attachment-action-${++this.nextId}`;
    let resolve!: RecordEntry["resolve"], reject!: RecordEntry["reject"];
    const promise = new Promise<Uint8Array | null>((yes, no) => { resolve = yes; reject = no; });
    const entry: RecordEntry = {
      state: { ...request, id, status: "queued" },
      action: { id, promise, cancel: () => this.cancel(entry) }, resolve, reject, settled: false, cancelled: false,
    };
    // Keep error/status history bounded without retaining decoded attachment data.
    for (const [key, old] of this.states) {
      if ((request.key && old.key === request.key && !this.entries.has(key)) || (this.states.size >= 100 && !this.entries.has(key))) this.states.delete(key);
    }
    this.entries.set(id, entry);
    this.states.set(id, entry.state);
    if (this.disposed) this.cancel(entry);
    else { this.queue.push(entry); this.emit(); this.pump(); }
    return entry.action;
  }

  cancelAction(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.cancel(entry);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) if (!entry.settled) this.cancel(entry);
    this.queue = [];
    this.restorePasswordHandler();
    this.listeners.clear();
  }

  private passwordUI(challenge: AttachmentPasswordChallenge | null) {
    try { this.options.onPassword?.(challenge); } catch { /* A closed owner cannot strand the queue. */ }
  }

  private emit() {
    const states = this.getSnapshot();
    try { this.options.onState?.(states); } catch { /* Observers do not own extraction settlement. */ }
    for (const listener of this.listeners) {
      try { listener(states); } catch { /* Other owners must still receive their state. */ }
    }
  }

  private settle(entry: RecordEntry, bytes: Uint8Array | null, error?: unknown) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.state.intent === "page-content") entry.resolve(error ? null : bytes);
    else if (error) entry.reject(error);
    else entry.resolve(bytes);
  }

  private cancel(entry: RecordEntry) {
    if (entry.settled) return;
    entry.cancelled = true;
    entry.state.status = "cancelled";
    const challenge = this.challenge;
    if (challenge?.entry === entry) {
      this.challenge = null;
      this.passwordUI(null);
      challenge.answer(cancelledError());
    }
    this.queue = this.queue.filter(queued => queued !== entry);
    if (entry !== this.active) this.entries.delete(entry.state.id);
    this.settle(entry, null, cancelledError());
    this.emit();
  }

  private restorePasswordHandler() {
    if (this.disposed && !this.active && this.pdf.loadingTask.onPassword === this.passwordHandler) {
      this.pdf.loadingTask.onPassword = this.previousPasswordHandler;
    }
  }

  private pump() {
    if (this.active || this.disposed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.active = entry;
    entry.state.status = "extracting";
    this.emit();
    void (async () => {
      try {
        const bytes = await this.pdf.getAttachmentContent(entry.state.retrievalId);
        if (entry.cancelled || this.disposed) return;
        if (bytes === null) throw new Error("This attachment's content is unavailable.");
        if (bytes.byteLength > (this.options.maxBytes ?? MAX_ATTACHMENT_BYTES)) throw new Error("That attachment is larger than Folio's file limit.");
        entry.state.status = "done";
        this.settle(entry, bytes);
      } catch (error) {
        if (!entry.cancelled && !this.disposed) {
          entry.state.status = "error";
          entry.state.error = error instanceof Error ? error.message : "Could not read this attachment.";
          this.settle(entry, null, error);
          try { this.options.onError?.({ ...entry.state }, error); } catch { /* Keep the queue moving. */ }
        }
      } finally {
        if (this.challenge?.entry === entry) { this.challenge = null; this.passwordUI(null); }
        this.active = null;
        this.entries.delete(entry.state.id);
        this.emit();
        this.restorePasswordHandler();
        this.pump();
      }
    })();
  }
}
