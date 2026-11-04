import { activeDocument, setActiveDocument } from "./session";
import { getRecent, listRecent, subscribeRecent } from "./recent";

export type AttachmentOrigin = {
  parentTabKey: number;
  parentDocumentInstance: number;
  sourceKind: "document" | "annotation";
  retrievalId: string;
};
export interface AttachmentStatus {
  state: "queued" | "extracting" | "password" | "error" | "ready";
  message?: string;
  password?: { incorrect: boolean; submit(password: string): void; cancel(): void };
}
export type OpenSource =
  | { kind: "bytes"; name: string; data: Uint8Array; note?: string; password?: string }
  | { kind: "blob"; name: string; blob: Blob; recentId?: string }
  | { kind: "attachment"; name: string; blob: Blob }
  | { kind: "word"; name: string; file: File }
  | { kind: "url"; name: string; url: string }
  | { kind: "sample" | "converting"; name: string }
  | { kind: "error"; name: string; message: string };

interface Reader {
  open(source: OpenSource): void;
  flush(): Promise<void>;
  dispose?(): Promise<void>;
  attachmentStatus?(status: AttachmentStatus): void;
  focusAttachment?(origin: AttachmentOrigin): void;
}
interface AttachmentActions { cancel(): void; retry?(): void }
export interface ReaderContext { tabs: DocumentTabs; key: number; kind: "normal" | "attachment" }
export interface ReaderFrame extends HTMLIFrameElement { readerContext?: ReaderContext; disposeReader?: () => void }

interface Tab {
  key: number;
  kind: "normal" | "attachment";
  name: string;
  contentId?: string;
  documentInstance: number;
  selectionRank: number;
  restoreAllowed?: boolean;
  passwordPending?: boolean;
  dirty: boolean;
  frame?: ReaderFrame;
  reader?: Reader;
  binding?: object;
  frameDocument?: object;
  source?: OpenSource;
  origin?: AttachmentOrigin;
  snapshot?: Blob;
  attachmentStatus?: AttachmentStatus;
  attachmentActions?: AttachmentActions;
  closing?: boolean;
  disposing?: boolean;
}

/** Each reader has its own window: PDF.js keyboard and editing handlers cannot reach a hidden tab. */
export class DocumentTabs {
  private entries: Tab[] = [];
  private sequence = 0;
  private instanceSequence = 0;
  private selectionSequence = 0;
  private membershipRevision = 0;
  private unloading = false;
  private listeners = new Set<() => void>();
  private revision = 0;
  active = 0;
  keyboardFocus?: number;
  cleanupError?: string;
  constructor(private root: HTMLElement) {
    subscribeRecent(() => { void this.recomputeStartup(); });
    window.addEventListener("pagehide", () => {
      this.unloading = true;
      ++this.membershipRevision;
    });
  }

  get all(): readonly Tab[] { return this.entries; }
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  dismissCleanupError() {
    if (!this.cleanupError) return;
    this.cleanupError = undefined;
    this.changed();
  }
  private changed() {
    this.revision++;
    const selected = this.entry(this.active);
    document.title = selected?.name ? selected.name + " — Folio" : "Folio";
    for (const fn of this.listeners) fn();
  }
  private entry(key: number) { return this.entries.find(tab => tab.key === key); }
  private create(kind: Tab["kind"] = "normal"): Tab {
    const tab: Tab = { key: ++this.sequence, kind, name: "", documentInstance: 0, selectionRank: 0, dirty: false };
    this.entries.push(tab);
    return tab;
  }
  private async recomputeStartup() {
    if (this.unloading) return;
    const revision = ++this.membershipRevision;
    const recent = new Set((await listRecent()).map(file => file.id));
    if (this.unloading || revision !== this.membershipRevision) return;
    const winner = this.entries.filter(tab => tab.kind === "normal" && !tab.disposing && tab.contentId &&
      tab.restoreAllowed && tab.selectionRank > 0 && recent.has(tab.contentId)).sort((a, b) => b.selectionRank - a.selectionRank)[0];
    setActiveDocument(winner?.contentId ?? null);
  }
  select(key: number, focusTab = false) {
    const next = this.entry(key);
    if (!next || next.closing) return;
    if (key !== this.active && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.active = key;
    this.keyboardFocus = focusTab ? key : undefined;
    if (next.kind === "normal") next.selectionRank = ++this.selectionSequence;
    for (const tab of this.entries) if (tab.frame) {
      tab.frame.inert = tab !== next;
      tab.frame.classList.toggle("active", tab === next);
    }
    if (!next.frame) {
      const frame: ReaderFrame = document.createElement("iframe");
      frame.readerContext = { tabs: this, key, kind: next.kind };
      frame.className = "document-reader active";
      frame.title = next.name || "Library";
      frame.name = "folio-reader-" + key;
      frame.allowFullscreen = true;
      frame.src = new URL("index.html?reader", location.href).href;
      next.frame = frame;
      this.root.append(frame);
    }
    next.frame.focus({ preventScroll: true });
    void this.recomputeStartup();
    this.changed();
  }
  library() {
    const blank = this.entries.find(tab => tab.kind === "normal" && !tab.name && !tab.closing) ?? this.create();
    this.select(blank.key);
  }
  open(sources: OpenSource[]): number {
    if (!sources.length) return this.active;
    let first = 0;
    for (const source of sources) {
      const current = this.entry(this.active);
      const tab = !first && current?.kind === "normal" && !current.name && !current.closing ? current : this.create();
      tab.name = source.name;
      tab.source = source;
      first ||= tab.key;
      this.deliver(tab);
    }
    this.select(first);
    return first;
  }
  private deliver(tab: Tab) {
    if (!tab.reader || !tab.source) return;
    const source = tab.source;
    tab.source = undefined;
    tab.reader.open(source);
  }
  /** A document token spans binding refreshes, but never an actual iframe navigation. */
  readerDocumentLoaded(key: number) {
    const tab = this.entry(key);
    if (!tab || tab.disposing) return undefined;
    if (tab.frameDocument) this.readerDocumentUnloaded(key, tab.frameDocument);
    if (!this.entry(key) || tab.disposing) return undefined;
    const token = {};
    tab.frameDocument = token;
    return token;
  }
  isReaderDocument(key: number, token: object) {
    const tab = this.entry(key);
    return !!tab && !tab.disposing && tab.frameDocument === token;
  }
  readerDocumentUnloaded(key: number, token: object) {
    const tab = this.entry(key);
    if (!tab || tab.frameDocument !== token || tab.disposing) return;
    tab.frameDocument = undefined;
    const reader = tab.reader;
    tab.reader = undefined;
    tab.binding = undefined;
    // A whole-window restart keeps the already-confirmed normal startup choice.
    // Individual iframe reloads still invalidate their old live document below.
    if (this.unloading) { void reader?.dispose?.().catch(() => {}); return; }
    if (tab.kind === "attachment") {
      if (!tab.snapshot) void this.disposeTab(tab);
      else tab.source = { kind: "attachment", name: tab.name, blob: tab.snapshot };
    } else {
      this.beginDocument(key);
    }
    void reader?.dispose?.().catch(() => {
      this.cleanupError = "Some reader resources couldn't be released after reloading.";
      this.changed();
    });
  }
  bind(key: number, reader: Reader) {
    const tab = this.entry(key);
    if (!tab || tab.disposing) {
      void reader.dispose?.().catch(() => {});
      return () => {};
    }
    const token = {};
    tab.binding = token;
    tab.reader = reader;
    if (tab.kind === "attachment" && tab.snapshot && !tab.source) {
      tab.source = { kind: "attachment", name: tab.name, blob: tab.snapshot };
    }
    if (tab.attachmentStatus) reader.attachmentStatus?.(tab.attachmentStatus);
    this.deliver(tab);
    return () => {
      if (tab.binding === token) { tab.reader = undefined; tab.binding = undefined; }
    };
  }
  currentDocumentInstance(key: number) { return this.entry(key)?.documentInstance; }
  beginDocument(key: number) {
    const tab = this.entry(key);
    if (!tab || tab.kind !== "normal" || tab.disposing) return 0;
    this.invalidateChildren(tab);
    tab.documentInstance = ++this.instanceSequence;
    tab.contentId = undefined;
    tab.restoreAllowed = false;
    tab.passwordPending = false;
    void this.recomputeStartup();
    this.changed();
    return tab.documentInstance;
  }
  private originLive(origin: AttachmentOrigin) {
    const parent = this.entry(origin.parentTabKey);
    return !!parent && parent.kind === "normal" && !parent.disposing && parent.documentInstance === origin.parentDocumentInstance;
  }
  private sameOrigin(a: AttachmentOrigin, b: AttachmentOrigin) {
    return a.parentTabKey === b.parentTabKey && a.parentDocumentInstance === b.parentDocumentInstance &&
      a.sourceKind === b.sourceKind && a.retrievalId === b.retrievalId;
  }
  reserveAttachment(origin: AttachmentOrigin, name: string, actions: AttachmentActions) {
    if (!this.originLive(origin)) return { key: 0, created: false };
    const existing = this.entries.find(tab => tab.origin && !tab.closing && this.sameOrigin(tab.origin, origin));
    if (existing) { this.select(existing.key); return { key: existing.key, created: false }; }
    const tab = this.create("attachment");
    tab.name = name;
    tab.origin = { ...origin };
    tab.attachmentActions = actions;
    tab.attachmentStatus = { state: "queued" };
    this.select(tab.key);
    return { key: tab.key, created: true };
  }
  commitAttachment(key: number, origin: AttachmentOrigin, blob: Blob) {
    const tab = this.entry(key);
    if (!tab || tab.kind !== "attachment" || tab.closing || !tab.origin || !this.sameOrigin(tab.origin, origin) || !this.originLive(origin)) return false;
    // The Blob is retained before delivery; from here the parent is no longer needed for replay.
    tab.snapshot = blob;
    tab.attachmentActions = undefined;
    tab.source = { kind: "attachment", name: tab.name, blob };
    this.setAttachmentStatus(key, { state: "ready" });
    this.deliver(tab);
    return true;
  }
  setAttachmentStatus(key: number, status: AttachmentStatus) {
    const tab = this.entry(key);
    if (!tab || tab.kind !== "attachment" || tab.closing) return;
    tab.attachmentStatus = status;
    tab.reader?.attachmentStatus?.(status);
    this.changed();
  }
  setAttachmentPasswordPending(key: number, pending: boolean) {
    const tab = this.entry(key);
    if (tab && !tab.disposing && tab.passwordPending !== pending) { tab.passwordPending = pending; this.changed(); }
  }
  retryAttachment(key: number) {
    const tab = this.entry(key);
    if (tab?.origin && !tab.closing && this.originLive(tab.origin)) tab.attachmentActions?.retry?.();
  }
  cancelAttachment(key: number) { this.entry(key)?.attachmentActions?.cancel(); }
  canBackToParent(key: number) {
    const tab = this.entry(key);
    return !!tab?.origin && this.originLive(tab.origin);
  }
  backToParent(key: number) {
    const tab = this.entry(key);
    if (!tab?.origin || !this.originLive(tab.origin)) return;
    const parent = this.entry(tab.origin.parentTabKey)!;
    this.select(parent.key);
    parent.reader?.focusAttachment?.(tab.origin);
  }
  private invalidateChildren(parent: Tab) {
    for (const child of this.entries.slice()) {
      if (child.origin?.parentTabKey !== parent.key || child.origin.parentDocumentInstance !== parent.documentInstance || child.snapshot || child.closing) continue;
      void this.disposeTab(child);
    }
  }
  finishConversion(key: number, source: OpenSource) {
    const tab = this.entry(key);
    if (!tab || tab.closing) return;
    tab.name = source.name;
    tab.source = source;
    this.deliver(tab);
    this.changed();
  }
  opened(key: number, id: string, name: string, instance?: number, restoreAllowed = true) {
    const tab = this.entry(key);
    if (!tab || tab.kind !== "normal" || tab.closing || (instance !== undefined && instance !== tab.documentInstance)) return false;
    const other = this.entries.find(candidate => candidate !== tab && candidate.kind === "normal" && !candidate.closing && candidate.contentId === id);
    if (other) {
      if (this.active === key) this.select(other.key);
      void this.close(key);
      return false;
    }
    tab.name = name;
    tab.contentId = id;
    tab.restoreAllowed = restoreAllowed;
    if (tab.frame) tab.frame.title = name;
    void this.recomputeStartup();
    this.changed();
    return true;
  }
  markDirty(key: number, dirty: boolean) {
    const tab = this.entry(key);
    if (tab?.kind === "normal" && tab.dirty !== dirty) { tab.dirty = dirty; this.changed(); }
  }
  failed(key: number) {
    const tab = this.entry(key);
    if (tab?.kind === "normal" && !tab.contentId) { tab.name = ""; if (tab.frame) tab.frame.title = "Library"; this.changed(); }
  }
  async close(key: number) {
    const tab = this.entry(key);
    if (!tab || tab.closing || (tab.dirty && !window.confirm(`Close “${tab.name}” and discard its unsaved changes?`))) return;
    tab.closing = true;
    try { await tab.reader?.flush(); }
    catch {
      if (tab.disposing || this.entry(key) !== tab) return;
      tab.closing = false;
      this.cleanupError = "Couldn't finish saving your notes. The tab is still open.";
      this.changed();
      return;
    }
    if (tab.disposing || this.entry(key) !== tab) return;
    await this.disposeTab(tab);
  }
  private async disposeTab(tab: Tab) {
    if (tab.disposing || this.entry(tab.key) !== tab) return;
    const key = tab.key;
    tab.closing = true;
    tab.disposing = true;
    this.invalidateChildren(tab);
    tab.attachmentActions?.cancel();
    ++this.membershipRevision;
    let cleanupFailed = false;
    try { await tab.reader?.dispose?.(); }
    catch { cleanupFailed = true; }
    finally {
      try { tab.frame?.disposeReader?.(); } catch { cleanupFailed = true; }
      const index = this.entries.indexOf(tab);
      this.entries.splice(index, 1);
      tab.source = undefined;
      tab.snapshot = undefined;
      tab.attachmentStatus = undefined;
      tab.attachmentActions = undefined;
      tab.frame?.remove();
      if (cleanupFailed) this.cleanupError = "The tab closed, but some reader resources couldn't be released.";
      if (key === this.active) {
        const parent = tab.origin && this.originLive(tab.origin) ? this.entry(tab.origin.parentTabKey) : undefined;
        const next = parent && !parent.closing ? parent : this.entries.slice(index).find(item => !item.closing) ?? this.entries.findLast(item => !item.closing);
        this.select((next ?? this.create()).key);
      } else this.changed();
      void this.recomputeStartup();
    }
  }
  cycle(direction: number) {
    const index = this.entries.findIndex(tab => tab.key === this.active);
    this.select(this.entries[(index + direction + this.entries.length) % this.entries.length].key, true);
  }
  async start() {
    const last = activeDocument();
    this.library();
    const initial = this.revision;
    const desktop = window.folioDesktop;
    desktop?.onTabCommand(command => {
      if (command === "new") this.library();
      else if (command === "close") void this.close(this.active);
      else this.cycle(command === "next" ? 1 : -1);
    });
    const conversions = new Map<string, number>();
    desktop?.onConverting((name, token) => conversions.set(token, this.open([{ kind: "converting", name }])));
    desktop?.onOpenFile((name, data, note, token) => {
      const source: OpenSource = { kind: "bytes", name, data, note };
      const key = token && conversions.get(token);
      if (token && key) { conversions.delete(token); this.finishConversion(key, source); }
      else this.open([source]);
    });
    desktop?.onOpenFailed((message, token) => {
      const key = conversions.get(token);
      if (key) { conversions.delete(token); this.finishConversion(key, { kind: "error", name: "", message }); }
    });
    window.addEventListener("beforeunload", event => {
      if (this.entries.some(tab => tab.dirty)) event.preventDefault();
    });
    if (await desktop?.ready() || !last || this.revision !== initial) return;
    const recent = await getRecent(last);
    if (recent && this.revision === initial) this.open([{ kind: "blob", name: recent.name, blob: recent.data, recentId: recent.id }]);
  }
}
