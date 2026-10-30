# Contributing to Folio

Thanks for helping. Bug reports, ideas, and pull requests are all welcome.

## Before you start

Review time is limited. Opening a pull request doesn't mean it will be reviewed or merged: we may close it, ask for a
smaller one, or build the idea differently ourselves.

- **Search first.** Check open issues and pull requests before starting. If someone is already fixing the same problem,
  help on their pull request instead of opening a second one.
- **Bug fixes** are the most welcome. A small fix for an obvious bug can go straight to a pull request; for anything
  larger, open an issue first so we agree on what's broken.
- **New features and changes to how Folio behaves** need an issue first, and a maintainer agreeing to the idea and its
  scope, before you build them. Link that comment in your pull request. Unrequested features, rewrites, and unrelated
  cleanup are usually closed.

Folio aims to stay simple, fast, and private: no telemetry, no accounts, and no network access beyond updates and
links you open. Changes that work against that won't be merged.

## Reporting bugs

[Open an issue](https://github.com/Forward-Future/folio/issues/new/choose) with your Folio version (shown in **About
Folio**), your operating system, what you did, what you expected, and what happened. If a specific PDF triggers the
problem and you can share it, attach it, or describe how to make one. Keep each issue to one problem. For security
issues, follow [SECURITY.md](SECURITY.md) instead.

## Making changes

1. Install [Node.js](https://nodejs.org/) 22 or newer, then run `npm install`.
2. Run `npm run app` to build and launch the desktop app, or `npm run dev` for the browser version with hot reload.
   To develop the desktop shell against the dev server, start `npm run dev` and then run
   `FOLIO_DEV_URL=http://localhost:5173 npx electron .` (development builds only).
3. Run `npm test`, `npm run build`, and `npm run smoke` before opening a pull request. The tests are fast (Vitest, next
   to the code they cover); the build type-checks and builds. CI runs all three on Windows, macOS, and Linux.

### One problem per pull request

If a pull request fixes two unrelated things, we'll ask you to split it, even when both fixes are good. Include
everything that one fix needs; put cleanups and second fixes in their own pull requests.

### Show that it works

Say how you reproduced the problem, how you checked the fix, and what you saw. Name the operating system you tested
on and anything you couldn't check. "Build passes" alone isn't enough.

Folio runs on Windows, macOS, and Linux. If your change touches window chrome, file opening, shortcuts, menus,
printing, the clipboard, or updates, say which platforms you tried, and read the platform notes in
[AGENTS.md](AGENTS.md#keeping-every-platform-working).

Visible changes need before and after screenshots; add a short recording when motion or timing matters. Attach them to
the pull request, not the repository.

### Titles and descriptions

Use a short, plain title that says what changes for the user, like "Keep text boxes when a document is reopened". The
[template](.github/pull_request_template.md) asks for the problem, the change, and how you checked it. If an AI agent
wrote the code, say which one at the end of the description. That's fine, but you're responsible for the result.

### How pull requests are merged

A maintainer reviews and merges. CI must pass on all three platforms. Pull requests are squash-merged, so the title
becomes the commit message on `main`. Merged changes ship with the next release. Don't change the version or the
changelog; maintainers update both when releasing.

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).

## Releasing

Maintainers publish releases with the GitHub CLI logged in to an account that can write to
[Forward-Future/folio-releases](https://github.com/Forward-Future/folio-releases). Commit everything, then run:

```sh
npm run release                                  # 1.0.0 -> 1.0.1
npm run release -- minor --notes "What changed"  # 1.0.0 -> 1.1.0
```

This bumps the version and pushes the commit and tag. The tag starts the **Release build** workflow
(`.github/workflows/release-build.yml`), which builds the Windows, macOS, and Linux installers on GitHub Actions and
checks that each packaged app starts. The script waits for it, downloads the installers, and publishes the release.
Nothing is published if any platform fails; fix the problem, then run `npm run release -- --publish-only` to publish
the same tag. After publishing, the script checks the release with `scripts/check-release.mjs`: every platform's files
are present and every update feed (Windows, macOS, AppImage, apt) offers the new version. The daily **Release check**
workflow repeats that check and opens an issue if anything is off.

**Never publish any other way** (no hand-made `gh release` uploads or single-platform builds); see
[AGENTS.md](AGENTS.md). Signing certificates are set up as repository secrets; see [SIGNING.md](SIGNING.md).

CI (`.github/workflows/ci.yml`) runs `npm test`, type-checks, builds, and runs `npm run smoke` on all three platforms for every push to
`main` and every pull request.
