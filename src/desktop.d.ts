interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

// Present only when Folio runs as the Windows desktop app (see electron/preload.cjs).
interface FolioDesktop {
  onOpenFile(callback: (name: string, data: Uint8Array) => void): void;
  setTheme(theme: string): void;
  getVersion(): Promise<string>;
  onUpdateReady(callback: (version: string) => void): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
}

interface Window {
  folioDesktop?: FolioDesktop;
}
