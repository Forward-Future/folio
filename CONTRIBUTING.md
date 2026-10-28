# Contributing to Folio

Thanks for helping. Bug reports, ideas, and pull requests are all welcome.

## Reporting bugs

[Open an issue](https://github.com/Forward-Future/folio/issues/new) with your Folio version (shown in **About Folio**),
what you did, what you expected, and what happened. If a specific PDF triggers the problem and you can share it,
attach it, or describe how to make one. For security issues, follow [SECURITY.md](SECURITY.md) instead.

## Making changes

1. Install [Node.js](https://nodejs.org/) 22 or newer, then run `npm install`.
2. Run `npm run app` to build and launch the desktop app, or `npm run dev` for the browser version with hot reload.
   To develop the desktop shell against the dev server, start `npm run dev` and then run
   `FOLIO_DEV_URL=http://localhost:5173 npx electron .` (development builds only).
3. Run `npm run build` before opening a pull request. It type-checks and builds, and CI runs the same check.

Keep changes focused, match the surrounding code style, and describe what you changed and how you tested it.
Folio aims to stay simple, fast, and private: no telemetry, no accounts, and no network access beyond updates and
links you open.

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
the same tag. Installed copies see the new version automatically.

CI (`.github/workflows/ci.yml`) type-checks, builds, and runs `npm run smoke` on all three platforms for every push to
`main` and every pull request.
