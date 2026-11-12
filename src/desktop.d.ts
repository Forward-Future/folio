interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

// Present only when Folio runs as the desktop app (see electron/preload.cjs).
interface FolioDesktop {
  getPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>;
  printSheets(job: { images: string[]; paper: "Letter" | "A4" | "Legal"; landscape: boolean; dpi: 150 | 300 | 600;
    copies: number; printer: string; booklet: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** `note` says where a converted Word document's PDF was saved. */
  onOpenFile(callback: (name: string, data: Uint8Array, note?: string, token?: string) => void): () => void;
  onConverting(callback: (name: string, token: string) => void): () => void;
  onOpenFailed(callback: (message: string, token: string) => void): () => void;
  onTabCommand(callback: (command: "new" | "close" | "next" | "previous") => void): () => void;
  openDocument(file: File): Promise<{ name: string; data: Uint8Array; note?: string }>;
  ready(): Promise<boolean>;
  /** Null when the user declines to open an address on their computer or local network, or the request is stopped. */
  fetchPdf(url: string, id: string): Promise<{ name: string; data: Uint8Array } | null>;
  /** Stops the fetchPdf request that was started with this id (it then resolves to null). */
  cancelFetchPdf(id: string): Promise<boolean>;
  getAppInfo(): Promise<{ version: string; mode: "development" | "portable" | "installed" | "appimage" | "package"; location: string; platform: string;
    /** True when updates are announced with a download link instead of installed (unsigned macOS builds). */
    notifyOnly: boolean }>;
  /** "win32", "darwin", or "linux". */
  platform: string;
  /** Opens the releases page (macOS, where updates are downloaded manually). */
  openDownload(): Promise<void>;
  downloadOcrModel(code: string): Promise<Uint8Array<ArrayBuffer>>;
  openInstallation(): Promise<string>;
  setTheme(theme: string): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  getAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>;
  ai: FolioAi;
}

interface AiStatus {
  openrouter: { configured: boolean };
  custom: CustomEndpointStatus;
  chatgpt: { connected: boolean; email: string; name: string; welcomeSeen: boolean; encrypted: boolean };
  claude: { installed: boolean; loggedIn: boolean; version?: string; subscription?: boolean; authMethod?: string };
}

interface AiMessage {
  role: "user" | "assistant";
  content: string;
  context?: { text: string; page: number };
}

interface AiEvent {
  id: string;
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
  code?: string;
  link?: string;
}

interface FolioAi {
  status(): Promise<AiStatus>;
  signInChatGPT(): Promise<{ ok: boolean; status?: AiStatus["chatgpt"]; error?: string }>;
  signOutChatGPT(): Promise<AiStatus["chatgpt"]>;
  chatgptWelcomeSeen(): Promise<boolean>;
  chatgptModels(): Promise<{ ok: boolean; models?: { id: string; name: string }[]; error?: string; code?: string }>;
  recheckClaude(): Promise<AiStatus["claude"]>;
  openRouterKey(action: "save" | "check" | "remove", key?: string): Promise<{ ok: boolean; configured?: boolean; error?: string }>;
  openRouterModels(): Promise<{ ok: boolean; models?: OpenRouterModel[]; error?: string }>;
  customEndpoint(action: "save" | "check" | "remove", input?: { baseUrl: string; key: string }): Promise<{ ok: boolean; status?: CustomEndpointStatus; error?: string }>;
  customModels(): Promise<{ ok: boolean; models?: OpenRouterModel[]; error?: string }>;
  ask(request: { id: string; provider: "chatgpt" | "claude" | "openrouter" | "custom"; model: string; document: { name: string; text: string; truncated: boolean; recognized: boolean };
    messages: AiMessage[] }): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  onEvent(callback: (event: AiEvent) => void): () => void;
}

interface OpenRouterModel { id: string; name: string; contextLength: number | null }

interface CustomEndpointStatus { configured: boolean; baseUrl: string; hasKey: boolean }

interface Window {
  folioDesktop?: FolioDesktop;
}
