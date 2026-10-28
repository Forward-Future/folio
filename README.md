# Folio

A simple, clean PDF reader for Windows. Free and open source.

**[Download Folio for Windows](https://github.com/Forward-Future/folio-releases/releases/latest/download/Folio-Setup.exe)**
· [All releases](https://github.com/Forward-Future/folio-releases/releases) · [Changelog](CHANGELOG.md)

Installed copies update themselves. Prefer not to install? Download **Folio-Portable.exe** from the
[latest release](https://github.com/Forward-Future/folio-releases/releases/latest); it runs as-is but doesn't auto-update.

> Folio's builds aren't code-signed yet, so Windows SmartScreen may warn the first time you run the installer.
> Choose **More info → Run anyway**, or build Folio yourself from source (below).

## Features

- **Reading:** continuous scroll, page thumbnails, outline/bookmarks, find with match case and whole word plus
  per-page result snippets, zoom (fit width, fit page, presets, Ctrl+wheel/pinch), two-page view, rotate, focus mode,
  light and dark themes, and night reading that dims bright pages.
- **Opening:** drag in a PDF, open from Windows Explorer ("Open with → Folio"), or drop, paste, or enter a link to a
  PDF on the web (Ctrl+Shift+O).
- **Marking up:** highlight, freehand draw, and text boxes with color palettes and undo. Ctrl+S saves a copy with
  annotations embedded as standard PDF annotations.
- **Signing:** add a handwritten signature captured with your camera or from a photo, placed on signature lines Folio
  detects or anywhere you choose. These are visual signatures, not cryptographic certificates.
- **Library:** recent files with thumbnails, each reopening where you left off.

Press `?` in the app for keyboard shortcuts.

## Privacy

Folio has no accounts, analytics, or telemetry, and never uploads your documents. It makes network requests only to:

- check GitHub for updates (installed copies; can be turned off in **About Folio**), and
- download a PDF from a link you give it.

Stored locally in your Windows profile (`%APPDATA%\Folio`): recently opened PDFs and their thumbnails (up to 8,
removable from the home screen with **Clear all**; password-protected PDFs are never kept), reading positions,
preferences, and, only if you choose to remember it, your signature image. This data isn't encrypted, so anyone with
access to your Windows account can read it.

## Building from source

Requires [Node.js](https://nodejs.org/) 22 or newer.

```sh
npm install
npm run app        # build and run the desktop app
npm run dist:win   # build release/Folio-Setup.exe and release/Folio-Portable.exe
npm run dev        # browser version with hot reload at http://localhost:5173
```

If your terminal has `ELECTRON_RUN_AS_NODE=1` set, unset it first.

### How it's put together

- `src/`: the reader UI (React + TypeScript, built with Vite) on top of [pdf.js](https://github.com/mozilla/pdf.js).
- `electron/`: the Windows desktop shell. It serves the built app from `dist/` over a custom `app://` protocol with
  a strict Content Security Policy, runs the page sandboxed with context isolation, opens PDFs passed from Explorer,
  keeps a single window, downloads PDF links, and handles automatic updates.
- `scripts/release.mjs`: the maintainer release script (see [CONTRIBUTING.md](CONTRIBUTING.md#releasing)).

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue
privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Folio includes third-party software under its own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
