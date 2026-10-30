import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The packaged app gets this policy as a response header on app:// (see CSP in electron/main.cjs);
// the meta tag covers the browser edition, where dist/ may be hosted statically. Kept in sync except
// connect-src, which also allows http(s) so "Open a link" can fetch PDFs from any origin.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' https: http: data: blob:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: mediastream:",
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Build only: the dev server needs its HMR websocket and inline preamble, which a CSP would block.
const cspMeta: Plugin = {
  name: "folio-csp-meta",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<title>", `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <title>`),
};

export default defineConfig({
  plugins: [react(), cspMeta],
  build: {
    target: "es2022",
    // pdf.js alone is ~800 KB minified; it is one library and can't usefully be split further.
    chunkSizeWarningLimit: 1200,
  },
});
