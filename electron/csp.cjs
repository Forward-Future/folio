// The page only loads its own bundled code; PDFs can't bring in scripts or reach the network.
// Inline styles are needed by pdf.js page layout; wasm by its image decoders; blob: frames for printing.
// The desktop app sends this as a header on app:// (main.cjs); the browser edition gets it as a meta tag
// (vite.config.ts). They differ only in connect-src: the browser edition fetches "Open a link" PDFs itself.
function csp({ connect }) {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob: mediastream:",
    "frame-src 'self' blob:",
    "object-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

module.exports = { csp };
