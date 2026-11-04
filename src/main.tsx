import { createRoot } from "react-dom/client";
import { DocumentTabs, type ReaderFrame } from "./documentTabs";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles.css";
import "./reading-tools.css";

const root = document.getElementById("root")!;
const reader = (window.frameElement as ReaderFrame | null)?.readerContext;
if (reader) {
  const desktop = window.parent.folioDesktop;
  if (desktop) {
    window.folioDesktop = { ...desktop, installUpdate: () => {
      if (reader.tabs.all.some(tab => tab.dirty) && !window.parent.confirm("Restart Folio and discard unsaved changes?")) return;
      desktop.installUpdate();
    } };
    document.documentElement.classList.add("desktop", `platform-${desktop.platform}`);
  }
  const documentToken = reader.tabs.readerDocumentLoaded(reader.key);
  window.addEventListener("pagehide", () => {
    if (documentToken) reader.tabs.readerDocumentUnloaded(reader.key, documentToken);
  }, { once: true });
  // No StrictMode: the pdf.js viewer binds imperatively to its container once.
  void (reader.kind === "attachment" ? import("./AttachmentReader") : import("./App")).then(({ default: App }) => {
    const frame = window.frameElement as ReaderFrame | null;
    if (!frame || !documentToken || !reader.tabs.isReaderDocument(reader.key, documentToken)) return;
    const app = createRoot(root);
    frame.disposeReader = () => app.unmount();
    app.render(<App tabs={reader.tabs} tabKey={reader.key} />);
  });
} else {
  void new DocumentTabs(root).start();
}
