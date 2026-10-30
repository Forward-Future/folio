import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { csp } from "./electron/csp.cjs";

// The browser edition gets the policy as a meta tag, since dist/ may be hosted statically (the desktop app
// sends it as a header; see electron/main.cjs). connect-src also allows http(s) here so "Open a link" can
// fetch PDFs from any origin.
const CSP = csp({ connect: "'self' https: http: data: blob:" });

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
