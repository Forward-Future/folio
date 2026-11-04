import { AttachmentBroker, discoverAttachments, type AttachmentItem, type DiscoverySnapshot,
  type AttachmentActionState, type AttachmentPasswordChallenge } from "./attachments";
import type { PDFDocumentProxy } from "./pdf";
import type { AttachmentOrigin, DocumentTabs } from "./documentTabs";
import { saveBlob } from "./download";

const emptyDiscovery: DiscoverySnapshot = {
  items: [], catalogLoading: false, pagesLoading: false, complete: false,
  isCollection: false, errors: [], truncated: false,
};

/** One parent's attachment operations outlive its sidebar, but never its PDF instance. */
export class AttachmentSession {
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private scanning = false;
  private disposed = false;
  private cancels = new Map<string, () => void>();
  private broker: AttachmentBroker;
  private snapshot: { discovery: DiscoverySnapshot; actions: AttachmentActionState[];
    password: AttachmentPasswordChallenge | null; error: string | null } = {
    discovery: emptyDiscovery, actions: [], password: null, error: null,
  };

  constructor(private pdf: PDFDocumentProxy, private tabs: DocumentTabs,
    private parentTabKey: number, private parentDocumentInstance: number) {
    this.broker = new AttachmentBroker(pdf, {
      onError: (action, error) => {
        if (action.intent === "page-content") this.update({ error: error instanceof Error ? error.message : "Could not read embedded content." });
      },
      onPassword: challenge => {
        this.tabs.setAttachmentPasswordPending(this.parentTabKey, !!challenge && challenge.intent !== "read");
        if (challenge?.intent === "read") {
          const key = Number(challenge.owner);
          this.tabs.setAttachmentStatus(key, { state: "password", password: {
            incorrect: challenge.reason === 2, submit: challenge.submit, cancel: challenge.cancel,
          } });
        }
        this.update({ password: challenge?.intent === "read" ? null : challenge });
      },
    });
    this.broker.subscribe(() => {
      const actions = this.broker.getSnapshot();
      this.update({ actions: [...actions] });
      for (const action of actions) {
        if (action.intent !== "read") continue;
        if (action.status === "queued" || action.status === "extracting") {
          this.tabs.setAttachmentStatus(Number(action.owner), { state: action.status });
        }
      }
    });
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<typeof this.snapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private live() { return !this.disposed && this.tabs.currentDocumentInstance(this.parentTabKey) === this.parentDocumentInstance; }
  private origin(item: AttachmentItem): AttachmentOrigin {
    return { parentTabKey: this.parentTabKey, parentDocumentInstance: this.parentDocumentInstance,
      sourceKind: item.sourceKind, retrievalId: item.retrievalId };
  }
  discover = () => {
    if (this.scanning || this.disposed) return;
    this.scanning = true;
    void discoverAttachments(this.pdf, discovery => this.update({ discovery }), { signal: this.abort.signal })
      .catch(error => { if (this.live()) this.update({ error: String(error) }); })
      .finally(() => { this.scanning = false; });
  };
  cancel = (id: string) => { this.cancels.get(id)?.(); };
  save = (item: AttachmentItem) => {
    if (!this.live()) return;
    const action = this.broker.enqueue({ retrievalId: item.retrievalId, intent: "save", owner: "parent", key: item.key });
    this.cancels.set(action.id, action.cancel);
    this.update({ error: null });
    void action.promise.then(bytes => {
      if (!this.live()) return;
      if (bytes === null) throw new Error("This attachment's content is unavailable.");
      saveBlob(new Blob([bytes as Uint8Array<ArrayBuffer>]), item.filename || "attachment");
    }).catch(error => {
      if (this.live() && error?.name !== "AbortError") this.update({ error: error.message || "Couldn't save the attachment." });
    }).finally(() => this.cancels.delete(action.id));
  };
  read = (item: AttachmentItem) => {
    if (!this.live()) return;
    const origin = this.origin(item);
    let cancel = () => {};
    const child = this.tabs.reserveAttachment(origin, item.filename || "attachment", {
      cancel: () => cancel(), retry: () => start(),
    });
    const start = () => {
      if (!this.live()) return;
      const action = this.broker.enqueue({ retrievalId: item.retrievalId, intent: "read", owner: String(child.key), key: item.key });
      cancel = action.cancel;
      this.cancels.set(action.id, action.cancel);
      void action.promise.then(bytes => {
        if (!this.live()) return;
        if (bytes === null) throw new Error("This attachment's content is unavailable.");
        this.tabs.commitAttachment(child.key, origin, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
      }).catch(error => {
        if (this.live()) this.tabs.setAttachmentStatus(child.key, { state: "error",
          message: error?.name === "AbortError" ? "Attachment reading canceled." : error.message || "Couldn't read the attachment." });
      }).finally(() => this.cancels.delete(action.id));
    };
    if (child.created) start();
  };
  pageContent = (id: string) => {
    if (!this.live()) return Promise.resolve(null);
    const action = this.broker.enqueue({ retrievalId: id, intent: "page-content", owner: "parent" });
    this.cancels.set(action.id, action.cancel);
    return action.promise.then(bytes => this.live() ? bytes : null).finally(() => this.cancels.delete(action.id));
  };
  dispose = () => {
    if (this.disposed) return;
    this.tabs.setAttachmentPasswordPending(this.parentTabKey, false);
    this.disposed = true;
    this.abort.abort();
    this.broker.dispose();
    this.cancels.clear();
    this.listeners.clear();
  };
}
