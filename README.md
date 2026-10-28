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

### Open from URL and night reading in 1.3.0

- Drop a PDF link anywhere in Folio (for example, dragged from a browser's address bar or a page link), paste one with Ctrl+V outside a text field, or choose Open from URL (Ctrl+Shift+O). Folio downloads it and opens it automatically.
- Downloads happen in the desktop app's main process, so links work regardless of the site's CORS policy. Redirects are followed, the file name comes from the server or the final URL, and links that aren't PDFs, fail, exceed 500 MB, or take longer than 60 seconds show a clear error while keeping the current document open.
- Night reading remembers its last on/off setting across documents and app restarts, independently of the interface theme. The preference saves immediately when toggled.

### Handwritten signatures in 1.2.0

- About Folio includes an Automatic updates toggle, enabled by default and saved across restarts. Disabling stops background checks/downloads and installation on close; manual checks and explicitly restarting to update remain available. Updates run silently through the updater rather than the manually launched Setup wizard; Windows can still request elevation when required.

- Choose Sign to capture dark ink on white paper using your camera, or upload a PNG, JPEG, or WebP photo. Crop around the signature and adjust ink sensitivity to remove the paper background. Processing stays on this device; the camera stops after capture or closing the dialog.
- Folio checks the current page for PDF signature widgets and possible signature labels after navigation settles. Suggestions never sign automatically: review the page preview and click Approve and add signature. Label detection is heuristic, not OCR; scanned pages still support manual placement.
- Choose a detected field or click a position in the page preview. Signatures preserve their proportions and are embedded as visual PDF stamp annotations. Ctrl+Z undoes placement; Ctrl+S exports a copy, including on repeated saves. This does not create a cryptographic signature or fill a digital-signature certificate field. Editing may affect existing digital signatures; automatic suggestions are suppressed for documents with detected digital signatures.
- Remembering a signature is optional. Saved signature images are stored unencrypted in the local app profile; Forget saved signature removes the reusable image, not signatures already added to documents or exported copies.

### Responsiveness and updates in 1.1.1

- Restart-to-update now runs the installer silently and relaunches Folio. Install-on-close was already silent. First-time manual installation still uses the setup wizard, and Windows may still request permission if elevation is needed.
- The page sidebar only mounts thumbnails near its visible area, cancels discarded thumbnail rendering, and releases off-screen canvases instead of retaining one for every page.
- Reading progress reuses a database connection and updates only the current recent-file record, without fetching and pruning the entire library on every page change.
- Document controls become available without waiting for library thumbnail generation. Search snippets appear in batches without copying every match offset.
- Reading-position writes are coalesced outside the scroll event path and flushed when leaving the app. Repeated zoom commands reuse the current page image before sharpening it after the input settles.

### Reading features

- Reopens the last active document at startup, unless a PDF was explicitly opened from Explorer. Returning to the library clears automatic reopening.
- Remembers each recent document's page, position within the page, zoom, rotation, sidebar visibility, and two-page mode locally. Passwords and unsaved annotations are not saved in the reading session.
- Shows matching-page snippets and match counts beneath Find. Click a result to jump to that page; Enter and Shift+Enter still navigate individual matches with all matches highlighted. Lists at most 100 matching pages to keep the panel responsive.
- Adds About Folio in the toolbar with the running version, installed/portable/development edition, installation folder, and live update status. Installed builds can check for updates or restart to install a downloaded update.
- Restores the desktop window's size, position, and maximized state, adjusting off-screen bounds when monitors change.

```sh
npm run app        # build and run Folio as a desktop app
npm run dist:win   # build release/Folio-Setup-<version>.exe and release/Folio-Portable-<version>.exe
```

The desktop shell lives in `electron/` (Electron). It serves the built app from `dist/` over an `app://`
protocol, opens PDFs passed on the command line or from Explorer ("Open with → Folio"), keeps a single
window (opening another PDF reuses it), and asks before closing with unsaved annotations.

The builds are not code-signed, so Windows SmartScreen may warn on first run ("More info → Run anyway").
If you run Electron from a terminal that has `ELECTRON_RUN_AS_NODE=1` set, unset it first.

## Releasing updates

Installed copies of Folio check [mberman84/folio-releases](https://github.com/mberman84/folio-releases) on launch
and every 4 hours, download new versions in the background, and install them when Folio closes (or right away
via the "Restart" button). To ship an update, commit your changes and run:

```sh
npm run release                                  # 1.0.0 -> 1.0.1
npm run release -- minor --notes "What changed"  # 1.0.0 -> 1.1.0
```

This bumps the version, builds the installers, uploads them to a new public release, and pushes the source
(private repo [mberman84/folio](https://github.com/mberman84/folio)). Needs the GitHub CLI logged in (`gh auth login`).

Install link (always the newest version):
https://github.com/mberman84/folio-releases/releases/latest/download/Folio-Setup.exe
