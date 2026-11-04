# Execution log

## 2026-11-03 — PDF attachments implementation

Implemented the reviewed attachment scope on `feat/pdf-attachments`: lazy metadata discovery, exact-byte saves, serialized embedded-stream authentication, and independent read-only attachment tabs. Parent reading and editing state stays mounted. Temporary children bypass Recent and document persistence; startup restoration now requires confirmed Recent membership. The implementation includes explicit cancellation, replay, close-failure handling, and cross-frame Recent notifications.

Validation completed before the draft PR: TypeScript, production build, 12 broker/adapter cases, 5 session cases, 15 tab cases, and a focused hidden Linux Electron smoke run. The smoke covers late-page listing, exact downloads, extensionless and invalid PDFs, parent form retention, child read-only forms, origin deduplication, committed replay after parent close, embedded-stream cancellation/retry, separate child PDF passwords, and saving locked originals. Runtime characterization uses SHA-verified fixtures from the pinned PDF.js commit; fixture PDFs are fetched for tests, not committed.

Independent correctness review identified and fixed stale page-content delivery and iframe reload during close preflight. Regression tests cover both. The designated Daybreak security review was skipped because `gpt-daybreak-blue-latest` is unavailable on this ChatGPT account; no replacement security review or security approval is claimed.

The remote build passed, but gezie-build lacks `xvfb-run`. Pablo authorized a draft PR for full Windows, macOS, and Linux CI. Full CI and native visible window-drag checks remain pending at this entry. No representative user PDF has been supplied. No release, version, updater, or changelog changes were made.

The final focused smoke also verifies nested-content guidance and responsive fit zoom. Visual inspection led to a fit-width resize fix and copying PDF.js annotation icons. Draft PR: https://github.com/pablopda/folio/pull/1. The fork's CI workflow initially had no registered checks; it was explicitly enabled before retriggering the draft's CI. Screenshot evidence is produced under `release/smoke` for the workflow's artifact upload and is not committed.
