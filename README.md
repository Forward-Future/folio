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
- **Highlights and notes:** select text and click a color (or press H) to highlight it; choose Note (N) to attach a
  note. The Notes tab lists every highlight with its note, plus a notes box for the whole document, and copies them all
  as Markdown. Everything saves automatically and comes back when you reopen the file. Ctrl+S saves a PDF copy with
  highlights and notes embedded as standard PDF annotations. Freehand drawing and text boxes are there too.
- **Ask AI:** ask questions about the whole document, or select a passage and ask about just that part. Answers cite
  clickable page numbers. Uses your own ChatGPT plan (Sign in with ChatGPT) or your Claude subscription through
  [Claude Code](https://claude.com/claude-code); no API keys needed.
- **Signing:** add a handwritten signature captured with your camera or from a photo, placed on signature lines Folio
  detects or anywhere you choose. These are visual signatures, not cryptographic certificates.
- **Library:** recent files with thumbnails, each reopening where you left off.

Press `?` in the app for keyboard shortcuts.

## Privacy

Folio has no accounts, analytics, or telemetry, and never uploads your documents on its own. It makes network requests
only to:

- check GitHub for updates (installed copies; can be turned off in **About Folio**),
- download a PDF from a link you give it, and
- answer a question you ask in **Ask AI**. Only then, the document's text (up to about 400,000 characters), any passage
  you selected, and the conversation go to the provider you chose: OpenAI for ChatGPT, or Anthropic through your
  installed Claude Code. Their privacy terms apply to that data.

For ChatGPT, Folio stores its sign-in tokens encrypted with Windows' per-user data protection and never shows them to
the page. For Claude, Folio runs your own Claude Code with every tool disabled; it never sees or stores your Claude
credentials.

Stored locally in your Windows profile (`%APPDATA%\Folio`): recently opened PDFs and their thumbnails (up to 8,
removable from the home screen with **Clear all**; password-protected PDFs are never kept), highlights and
notes for each document (except password-protected ones), reading positions, preferences, and, only if you choose to
remember it, your signature image. This data isn't encrypted, so anyone with
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
