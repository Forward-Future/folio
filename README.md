# Folio

A simplified, clean PDF reader built on pdf.js — React + Vite, runs fully in the browser.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

**Reading:** continuous scroll, page thumbnails, outline/bookmarks, find (match case / whole word),
zoom (fit width, fit page, presets, Ctrl+wheel/pinch), two-page view, rotate, focus mode, dark theme, night-reading page inversion.

**Marking up:** highlight, freehand draw, and text boxes with color palettes and undo.
Ctrl+S downloads a copy with annotations embedded as real PDF annotations.

**Library:** drag a PDF anywhere to open it. Recent files (with thumbnail and reading progress)
are kept locally in IndexedDB; each file reopens on the page you left off. Nothing is uploaded.

Press `?` in the app for keyboard shortcuts.

## Windows app

```sh
npm run app        # build and run Folio as a desktop app
npm run dist:win   # build release/Folio-Setup-<version>.exe and release/Folio-Portable-<version>.exe
```

The desktop shell lives in `electron/` (Electron). It serves the built app from `dist/` over an `app://`
protocol, opens PDFs passed on the command line or from Explorer ("Open with → Folio"), keeps a single
window (opening another PDF reuses it), and asks before closing with unsaved annotations.

The builds are not code-signed, so Windows SmartScreen may warn on first run ("More info → Run anyway").
If you run Electron from a terminal that has `ELECTRON_RUN_AS_NODE=1` set, unset it first.
