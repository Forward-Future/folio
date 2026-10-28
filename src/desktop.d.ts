interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

// Present only when Folio runs as the Windows desktop app (see electron/preload.cjs).
interface FolioDesktop {
  onOpenFile(callback: (name: string, data: Uint8Array) => void): () => void;
  ready(): Promise<boolean>;
  fetchPdf(url: string): Promise<{ name: string; data: Uint8Array }>;
  getAppInfo(): Promise<{ version: string; mode: "development" | "portable" | "installed"; location: string }>;
  openInstallation(): Promise<string>;
  setTheme(theme: string): void;
  getVersion(): Promise<string>;
  onUpdateReady(callback: (version: string) => void): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  getAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>;
}

interface Window {
  folioDesktop?: FolioDesktop;
}
