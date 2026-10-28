# Changelog

## 1.5.0

- Selecting text shows a note box right away: type a note and press Enter to highlight with it (or click a color to
  highlight without one).
- Click any highlight to change its color, edit its note, ask AI about it, or **Remove** it in one click (or press Delete).
- Night reading keeps photos, figures, and other images in their true colors, on pages and thumbnails alike.
- A cleaner top bar: Notes, Ask AI, and Search stay visible; Save a copy, Print, Document info, Night reading, Focus
  mode, Dark theme, Keyboard shortcuts, and About Folio moved into the **⋯** menu.

## 1.4.0

- **Highlights and notes are first-class.** Select text and a toolbar pops up: click a color to highlight in one click
  (or press H), or choose Note (N) to highlight and write a note. Highlights, notes, drawings, and text boxes now save
  automatically and come back when you reopen a document.
- New **Notes** tab: every highlight with its note (click one to jump to it), a notes box for the whole document, and
  Copy all as Markdown.
- **Ask AI** about the whole document or a selected passage, with clickable page citations. Connect your ChatGPT plan
  with Sign in with ChatGPT, or use your Claude subscription through Claude Code. No API keys needed.
- Focus mode shows a discreet "Esc to exit focus mode" hint.

## 1.3.2

- Folio now lives in the Forward Future GitHub organization: source at github.com/Forward-Future/folio, downloads and
  updates at github.com/Forward-Future/folio-releases. Installed copies switch over automatically.

## 1.3.1

- Folio is now open source under the MIT License.
- Security hardening: a strict Content Security Policy, main-process calls accepted only from Folio's own page,
  locked-down subframes, Electron fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, or inspector flags; app code must
  load from an integrity-checked archive), XFA forms disabled, and Electron 45.1.0.
- Link downloads no longer follow redirects from a public site into local-network addresses; the size limit is now 300 MB.
- Password-protected PDFs are no longer kept in Recent. Added **Clear all** to the Recent list.
- New original sample document (replaces a third-party paper).

## 1.3.0

- Drop a PDF link anywhere in Folio, paste one with Ctrl+V outside a text field, or choose **Open from URL**
  (Ctrl+Shift+O). Folio downloads it and opens it automatically. Redirects are followed, the file name comes from the
  server or the final URL, and failed downloads show a clear error while keeping the current document open.
- Night reading remembers its on/off setting across documents and restarts, independently of the interface theme.

## 1.2.0

- Handwritten signatures: capture dark ink on white paper with your camera, or upload a PNG, JPEG, or WebP photo.
  Crop and adjust ink sensitivity to remove the paper background. Processing stays on your device.
- Folio checks each page for PDF signature fields and likely signature lines. Suggestions never sign automatically;
  you review and approve each placement. Signatures are embedded as visual stamp annotations, not cryptographic
  signatures.
- Remembering a signature is optional, and you can forget it at any time.
- **About Folio** has an Automatic updates toggle, saved across restarts. Manual checks remain available when it's off.
- Restart-to-update runs silently, without the Setup wizard.

## 1.1.1

- Faster thumbnails, zooming, reading-progress storage, and search snippets.

## 1.1.0

- Reopens the last document at startup and remembers each document's page, position, zoom, rotation, sidebar, and
  two-page mode.
- Find shows matching-page snippets and match counts.
- **About Folio** shows the version, edition, installation folder, and update status.
- Restores the window's size, position, and maximized state.

## 1.0.2

- Update status and a **Check for updates** button on the home screen.

## 1.0.1

- The toolbar's bottom border stays visible under the window controls.

## 1.0.0

- First release.
