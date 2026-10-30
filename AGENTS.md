# Working on Folio (notes for AI coding agents and maintainers)

Folio ships for **Windows, macOS, and Linux from one codebase**. Every change and every release must reach all three.

## Releasing: one way only

- **Release only with `npm run release`** (`-- minor`, `-- major`, `-- --notes "…"` as needed). It bumps the version,
  pushes the tag, waits for `.github/workflows/release-build.yml` to build and check the Windows, macOS, and Linux
  installers, then publishes all of them together and verifies the result with `scripts/check-release.mjs`.
- **Never publish by hand.** Don't run `gh release create`/`upload`, `electron-builder --publish`, or a
  single-platform `npm run dist:*` and upload the output. A release missing a platform leaves those users behind; the
  daily **Release check** workflow opens an issue when that happens.
- If the release build fails, nothing is published. Fix the problem on `main`, then run
  `npm run release -- --publish-only` to publish the same tag.
- **One release at a time.** Releases are built from committed, pushed code. If another session is working in the same
  checkout, coordinate: don't commit or release its uncommitted work, and use a separate `git worktree` for your own.

## Keeping every platform working

- CI (`.github/workflows/ci.yml`) builds and runs `npm run smoke` on Windows, macOS, and Linux for every push to `main`
  and every pull request. Keep it green on all three before releasing.
- Platform differences live in a few places; check them when you touch related code:
  - `electron/main.cjs`: window chrome (`titleBarOverlay` on Windows/Linux, traffic lights on macOS), file opening
    (argv on Windows/Linux, `open-file` on macOS), install kinds and update behavior (`installKind`, `NOTIFY_ONLY`).
  - `src/platform.ts`: `keys()` writes shortcuts as ⌘/⇧ on macOS. Use it for every shortcut shown in the UI.
  - `package.json` `build.win` / `build.mac` / `build.linux`, `build/linux/*.tpl` (the .deb's install scripts).
- Paths shown to users differ per OS; don't hard-code Windows paths or "Explorer" in UI or docs.

## How each platform gets updates

| Install | Update path |
| --- | --- |
| Windows installer | electron-updater reads `latest.yml`, installs silently |
| Windows portable | none (download again) |
| macOS | electron-updater reads `latest-mac.yml`; installs itself only when built with the Developer ID secrets (see SIGNING.md), otherwise shows a download link |
| Linux AppImage | electron-updater reads `latest-linux.yml`, replaces itself |
| Linux .deb | apt: the package adds Folio's signed repository (`Packages`/`InRelease` on each release, signed with the `APT_SIGNING_KEY` secret) |

All of these files are produced by the release build and published together; `scripts/check-release.mjs` lists them.

## Code layout

New code is grouped by layer, then by feature, so a feature's pieces sit beside the others of their kind:

- `src/components/<feature>/` React components (each in its own folder with its CSS and test),
- `src/hooks/<feature>/` hooks,
- `src/lib/<feature>/` everything that isn't UI: logic, storage, and the session or controller behind a feature.

Each feature folder has an `index.ts` that exports what the rest of the app may use; import from there, not from deep paths.
Tests sit next to the file they test (`Thing.ts` and `Thing.test.ts`). Text recognition (OCR) is the first feature laid out
this way (`components/ocr`, `hooks/ocr`, `lib/ocr`, plus `lib/search` for the words shown around a search match); older
files in `src/` can move over as they are touched.

Keep logic out of the big files (`App.tsx` and the like) by putting it in a function or hook with a test, so that what is
left there is a call. Tests run in plain Node; a test of a component or hook starts with `// @vitest-environment jsdom`.
When what matters is what pdf.js or pdf-lib really does (offsets, text positions, a rewritten file), test against the real
libraries with `src/testing/pdfjs.ts` instead of a fake: the fakes in older tests only repeat our assumptions.

## Code style

Match the surrounding code: comments explain why, not what; user-facing text is plain and short. Run
`npx tsc --noEmit`, `npm test`, `npm run build`, and `npm run smoke` before committing.
