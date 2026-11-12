import { activeDocument, setActiveDocument } from "./session";
import { getRecent } from "./recent";
import type { DocText } from "./aiAttachments";

export type OpenSource =
  | { kind: "bytes"; name: string; data: Uint8Array; note?: string; password?: string }
  | { kind: "blob"; name: string; blob: Blob; recentId?: string }
  | { kind: "word"; name: string; file: File }
  | { kind: "url"; name: string; url: string }
  | { kind: "sample" | "converting"; name: string }
  | { kind: "error"; name: string; message: string };

export interface Reader {
  open(source: OpenSource): void;
  flush(): Promise<void>;
  /** Text of the open document for Ask AI, or null while nothing is open. */
  text?(): Promise<DocText> | null;
  /** True for a password-protected document, whose text must not be saved with a conversation. */
  locked?(): boolean;
  goTo?(page: number): void;
}

/** An open document that Ask AI can add to another tab's conversation. */
export interface OpenDocument { key: number; name: string; contentId: string; locked: boolean }

export interface ReaderContext { tabs: DocumentTabs; key: number }
export interface ReaderFrame extends HTMLIFrameElement { readerContext?: ReaderContext; disposeReader?: () => void }

interface Tab {
  key: number;
  name: string;
  contentId?: string;
  /** Content of the bytes on screen. An in-place edit changes it while contentId keeps the opened file. */
  liveId?: string;
  dirty: boolean;
  frame?: ReaderFrame;
  reader?: Reader;
  source?: OpenSource;
  closing?: boolean;
}

/** pdf.js installs editing, selection and clipboard handlers on its window. Give each live
 * reader its own document so a shortcut or undo can never edit a background PDF. */
export class DocumentTabs {
  private entries: Tab[] = [];
  private sequence = 0;
  private listeners = new Set<() => void>();
  private revision = 0;
  private linkHintSeen = false;
  active = 0;
  keyboardFocus?: number;
  constructor(private root: HTMLElement) {}

  /** Reader frames share the hint, even if this window cannot use persistent storage. */
  takeLinkHint() {
    if (this.linkHintSeen) return false;
    this.linkHintSeen = true;
    try {
      if (localStorage.getItem("folio:link-return-hint")) return false;
      localStorage.setItem("folio:link-return-hint", "1");
    } catch { /* Once per window when storage is unavailable. */ }
    return true;
  }

  get all(): readonly Tab[] { return this.entries; }
  snapshot = () => this.revision;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  /** Documents open in other tabs. Tabs are identified by content, so a closed and reopened file matches again,
   * and an edited document no longer matches what was added before the edit. */
  documents(except: number): OpenDocument[] {
    return this.entries.filter(tab => tab.key !== except && !tab.closing && tab.liveId && tab.reader?.text)
      .map(tab => ({ key: tab.key, name: tab.name, contentId: tab.liveId!, locked: !!tab.reader?.locked?.() }));
  }
  private byContent(contentId: string) { return this.entries.find(tab => !tab.closing && tab.liveId === contentId); }
  /** The current text of an open document, or null when no tab shows it any more. */
  async documentText(contentId: string): Promise<(DocText & { name: string; locked: boolean }) | null> {
    const tab = this.byContent(contentId);
    const text = tab?.reader?.text?.();
    if (!tab || !text) return null;
    return { ...(await text), name: tab.name, locked: !!tab.reader?.locked?.() };
  }
  /** Switch to the tab showing a document and go to a page. False when it is no longer open. */
  showPage(contentId: string, page: number) {
    const tab = this.byContent(contentId);
    if (!tab) return false;
    this.select(tab.key);
    tab.reader?.goTo?.(page);
    return true;
  }
  private changed() {
    this.revision++;
    const selected = this.entry(this.active);
    document.title = selected?.name ? selected.name + " — Folio" : "Folio";
    for (const fn of this.listeners) fn();
  }
  private entry(key: number) { return this.entries.find(tab => tab.key === key); }
  private create(): Tab {
    const tab = { key: ++this.sequence, name: "", dirty: false };
    this.entries.push(tab);
    return tab;
  }
  select(key: number, focusTab = false) {
    const next = this.entry(key);
    if (!next || next.closing) return;
    if (key !== this.active && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.active = key;
    this.keyboardFocus = focusTab ? key : undefined;
    for (const tab of this.entries) if (tab.frame) {
      tab.frame.inert = tab !== next;
      tab.frame.classList.toggle("active", tab === next);
    }
    if (!next.frame) {
      const frame: ReaderFrame = document.createElement("iframe");
      frame.readerContext = { tabs: this, key };
      frame.className = "document-reader active";
      frame.title = next.name || "Library";
      frame.name = "folio-reader-" + key;
      frame.allowFullscreen = true;
      frame.src = new URL("index.html?reader", location.href).href;
      next.frame = frame;
      this.root.append(frame);
    }
    next.frame.focus({ preventScroll: true });
    setActiveDocument(next.contentId ?? null);
    this.changed();
  }
  library() {
    const blank = this.entries.find(tab => !tab.name && !tab.closing) ?? this.create();
    this.select(blank.key);
  }
  open(sources: OpenSource[]): number {
    if (!sources.length) return this.active;
    let first = 0;
    for (const source of sources) {
      const current = this.entry(this.active);
      const tab = !first && current && !current.name && !current.closing ? current : this.create();
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
  bind(key: number, reader: Reader) {
    const tab = this.entry(key);
    if (tab) { tab.reader = reader; this.deliver(tab); }
  }
  finishConversion(key: number, source: OpenSource) {
    const tab = this.entry(key);
    if (!tab || tab.closing) return;
    tab.name = source.name;
    tab.source = source;
    this.deliver(tab);
    this.changed();
  }
  opened(key: number, id: string, name: string) {
    const tab = this.entry(key);
    if (!tab || tab.closing) return false;
    // Recent, notes and chat are keyed by content. Two editors for identical bytes would overwrite each other.
    const other = this.entries.find(candidate => candidate !== tab && !candidate.closing && candidate.contentId === id);
    if (other) {
      if (this.active === key) this.select(other.key);
      void this.close(key);
      return false;
    }
    tab.name = name;
    tab.contentId = id;
    tab.liveId = id;
    if (tab.frame) tab.frame.title = name;
    if (this.active === key) setActiveDocument(id);
    this.changed();
    return true;
  }
  /** The tab now shows an edited version of its document. */
  revised(key: number, id: string) {
    const tab = this.entry(key);
    if (tab && !tab.closing && tab.liveId !== id) { tab.liveId = id; this.changed(); }
  }
  markDirty(key: number, dirty: boolean) {
    const tab = this.entry(key);
    if (tab && tab.dirty !== dirty) { tab.dirty = dirty; this.changed(); }
  }
  failed(key: number) {
    const tab = this.entry(key);
    if (tab && !tab.contentId) { tab.name = ""; if (tab.frame) tab.frame.title = "Library"; this.changed(); }
  }
  async close(key: number) {
    const tab = this.entry(key);
    if (!tab || tab.closing || (tab.dirty && !window.confirm(`Close “${tab.name}” and discard its unsaved changes?`))) return;
    tab.closing = true;
    try {
      await tab.reader?.flush();
    } catch {
      tab.closing = false;
      this.select(key);
      tab.reader?.open({ kind: "error", name: tab.name, message: "Couldn't finish saving your notes. The tab is still open." });
      return;
    }
    const index = this.entries.indexOf(tab);
    this.entries.splice(index, 1);
    tab.frame?.disposeReader?.();
    tab.frame?.remove();
    if (key === this.active) {
      const next = this.entries.slice(index).find(item => !item.closing) ?? this.entries.findLast(item => !item.closing);
      this.select((next ?? this.create()).key);
    } else this.changed();
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
