import "./pdfjs-global";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./reading-tools.css";

if (window.folioDesktop) document.documentElement.classList.add("desktop", `platform-${window.folioDesktop.platform}`);

// No StrictMode: the pdf.js viewer binds imperatively to its container once.
createRoot(document.getElementById("root")!).render(<App />);
