# Folio

A simple, clean PDF reader for Windows, macOS, and Linux. Free and open source.

## Download

| Platform | Download | Updates |
| --- | --- | --- |
| **Windows** 10/11 (64-bit) | [Folio-Setup.exe](https://github.com/Forward-Future/folio-releases/releases/latest/download/Folio-Setup.exe) | Automatic |
| **macOS** 12 or later (Apple Silicon and Intel) | [Folio-mac.dmg](https://github.com/Forward-Future/folio-releases/releases/latest/download/Folio-mac.dmg) | Folio tells you when a new version is out |
| **Linux**: Ubuntu, Debian, and derivatives (64-bit) | [Folio-linux-amd64.deb](https://github.com/Forward-Future/folio-releases/releases/latest/download/Folio-linux-amd64.deb) | Automatic, with your system updates (apt) |
| **Linux**: other distributions (64-bit) | [Folio-linux-x86_64.AppImage](https://github.com/Forward-Future/folio-releases/releases/latest/download/Folio-linux-x86_64.AppImage) | Automatic |

[All releases](https://github.com/Forward-Future/folio-releases/releases) · [Changelog](CHANGELOG.md) · Prefer not to
install on Windows? **Folio-Portable.exe** on the release page runs as-is (it doesn't auto-update).

Folio's builds aren't signed with paid developer certificates yet, so the first launch needs one extra step:

- **Windows:** if SmartScreen warns, choose **More info → Run anyway**.
- **macOS:** open the DMG and drag Folio to Applications. The first time you open it, macOS says it can't verify the
  developer: click **Done**, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **Linux (.deb):** `sudo apt install ./Folio-linux-amd64.deb`, then open Folio from your applications menu. The
  package adds Folio's signed apt repository, so new versions arrive with your regular system updates (or
  `sudo apt update && sudo apt upgrade`). Copies installed from a .deb before 1.9 need the new .deb installed once.
- **Linux (AppImage):** make it executable (`chmod +x Folio-linux-x86_64.AppImage`) and run it. AppImages need FUSE 2:
  `sudo apt install libfuse2t64` on Ubuntu 24.04 or later, `libfuse2` on older releases.

Or build Folio yourself from source (below).

## Features

- **Reading:** continuous scroll, page thumbnails, outline/bookmarks, find with match case and whole word plus
  per-page result snippets, zoom (fit width, fit page, presets, Ctrl+wheel/pinch), two-page view, rotate, focus mode
  (F; Esc to exit), light and dark themes, and night reading that dims bright pages while keeping images in their true
  colors.
- **Opening:** drag in a PDF, open one from your file manager ("Open with → Folio" in File Explorer, Finder, or your
  Linux file manager), or drop, paste, or enter a link (Ctrl+Shift+O; ⌘⇧O on a Mac). PDF links open directly; **webpages are converted to a PDF** you can highlight, annotate, and ask AI
  about, keeping the site's on-screen look (backgrounds, transparency, colors, and layout) and selectable text.
- **Images:** click an image to view it larger in Folio, or open it in your browser when it has a web address.
- **Highlights and notes:** select text and click a color (or press H) to highlight it, or type a note in the box that
  appears under the colors and press Enter. Click any highlight to recolor it, edit its note, or remove it. The Notes
  tab lists every highlight with its note, plus a notes box for the whole document, and copies them all as Markdown. Everything saves automatically and comes back when you reopen the file. Ctrl+S saves a PDF copy with
  highlights and notes embedded as standard PDF annotations. Freehand drawing and text boxes are there too.
- **Ask AI:** ask questions about the whole document, or select a passage and ask about just that part. Answers cite
  clickable page numbers. Uses your own ChatGPT plan (Sign in with ChatGPT) or your Claude subscription through
  [Claude Code](https://claude.com/claude-code); no API keys needed.
- **Signing:** add a handwritten signature captured with your camera or from a photo, placed on signature lines Folio
  detects or anywhere you choose. These are visual signatures, not cryptographic certificates.
- **Library:** recent files with thumbnails, each reopening where you left off.

Press `?` in the app for keyboard shortcuts. On a Mac, use ⌘ wherever this README says Ctrl.

## Using Ask AI

Open **Ask AI** with the sparkle button in the toolbar, or select text and choose **Ask AI** in the pop-up toolbar.
Then pick a provider at the top of the panel:

- **ChatGPT:** click **Continue with ChatGPT** and sign in in your browser. Questions use your ChatGPT plan (Go, Plus,
  or Pro), and usage counts toward that plan's limits; manage it in
  [ChatGPT settings](https://chatgpt.com/settings/usage). Sign out from the bottom of the panel.
- **Claude:** install [Claude Code](https://claude.com/claude-code), run `claude` once in a terminal, and sign in with
  your Claude account (Pro or Max). Then click **Check again** in Folio. Questions use your Claude subscription.

Ask AI is available in the desktop app only, not the browser version.

## Privacy

Folio has no accounts, analytics, or telemetry, and never uploads your documents on its own. It makes network requests
only to:

- check GitHub for updates (installed copies; can be turned off in **About Folio**),
- open a link you give it (a webpage is loaded in a hidden, sandboxed window with its own temporary session, so no
  cookies or sign-ins are shared, and every permission is denied; its scripts run while it loads, as in any browser,
  and it's then printed to PDF), and
- answer a question you ask in **Ask AI**. Only then, the document's text (up to about 400,000 characters), any passage
  you selected, and the conversation go to the provider you chose: OpenAI for ChatGPT, or Anthropic through your
  installed Claude Code. Their privacy terms apply to that data.

For ChatGPT, Folio stores its sign-in tokens in its data folder (below, under `ai`), encrypted with the system's
credential protection (Windows data protection, the macOS Keychain, or the Linux secret store; if a Linux desktop has
no secret store, you sign in again each time Folio starts), and never exposes them to the page. For Claude, Folio runs your own Claude Code with every tool disabled;
it never sees or stores your Claude credentials. The question's context is written to a temporary file for Claude Code
and deleted as soon as the answer finishes. Each document's Ask AI conversation is saved with it on this computer (except for password-protected documents) and
is there when you reopen the document; the **+** button in the panel starts over and deletes it.

Stored locally in your user profile (`%APPDATA%\Folio` on Windows, `~/Library/Application Support/Folio` on macOS,
`~/.config/Folio` on Linux): recently opened PDFs and their thumbnails (up to 8,
removable from the home screen with **Clear all**; password-protected PDFs are never kept), highlights, notes, and
Ask AI conversations for each document (except password-protected ones), reading positions, preferences, and, only if you choose to remember
it, your signature image. Apart from the ChatGPT sign-in, this data isn't encrypted, so anyone with access to your
user account can read it.

## Building from source

Requires [Node.js](https://nodejs.org/) 22 or newer.

```sh
npm install
npm run app        # build and run the desktop app
npm run smoke      # end-to-end check: launches the built app and exercises the basics
npm run dev        # browser version with hot reload at http://localhost:5173

npm run dist:win   # on Windows: release/Folio-Setup.exe and release/Folio-Portable.exe
npm run dist:mac   # on macOS: release/Folio-mac.dmg (universal: Apple Silicon and Intel)
npm run dist:linux # on Linux: release/Folio-linux-x86_64.AppImage and release/Folio-linux-amd64.deb
```

Each platform's installers are built on that platform; GitHub Actions builds all three for every release. If your
terminal has `ELECTRON_RUN_AS_NODE=1` set, unset it first.

### How it's put together

- `src/`: the reader UI (React + TypeScript, built with Vite) on top of [pdf.js](https://github.com/mozilla/pdf.js).
  `markup.ts` saves and restores highlights and notes, `NotesPanel.tsx` and `Selection.tsx` are their UI, and
  `AiPanel.tsx` is the Ask AI panel.
- `electron/`: the desktop shell for Windows, macOS, and Linux. `main.cjs` serves the built app from `dist/` over a
  custom `app://` protocol with a strict Content Security Policy, runs the page sandboxed with context isolation, opens
  PDFs from the file manager, keeps a single window, downloads links, and handles updates. `webpage.cjs` converts
  webpages to PDF. `ai.cjs` runs Ask AI (ChatGPT
  sign-in and requests, and Claude Code) so credentials never reach the page.
- `scripts/release.mjs` and `.github/workflows/release-build.yml`: the release pipeline (see
  [CONTRIBUTING.md](CONTRIBUTING.md#releasing)). `scripts/smoke-test.mjs` is the cross-platform smoke test CI runs.

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a security issue
privately, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Folio includes third-party software under its own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
