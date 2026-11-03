# Printing in this checkout

From your Folio checkout, start the desktop app:

```sh
npm run app
```

Open a PDF and press Ctrl+P, or choose More > Print. Folio prepares a snapshot with current annotations and page ordering. Preparing or printing does not save the document or clear its unsaved marker.

Choose a printer, copies, all/current/custom pages, paper size, orientation and layout. The preview uses the same sheet plan as the output. Continue to print opens the system print dialog for final confirmation. Check its printer, copies, paper, scaling and duplex settings before confirming. No silent printing is used.

- Size offers Fit, Actual size, Shrink oversized pages and Custom scale from 10% to 400%.
- Poster tiles each selected page left to right, then top to bottom, at the chosen scale. Set overlap in inches or millimeters; switching units preserves the physical amount. The default is 0.25 inches, or 6.35 mm. Zero gives adjoining tiles. Overlap must be smaller than both printable dimensions. Trim the quarter-inch paper margins and align the repeated content when joining. Cut marks and tile labels are not included.
- Multiple places 2, 4, 6, 9 or 16 pages on a sheet, in row order.
- Booklet creates left-bound page pairs, front then back, and pads to a multiple of four with blank pages. For eight source pages the pairs are 8/1, 2/7, 6/3, 4/5. Enable duplex in the system dialog, with short-edge binding for landscape or long-edge binding for portrait. Duplex availability and handling depend on the printer. Manual duplex and right-bound booklets are not implemented.

Grayscale converts the rendered content. Save ink/toner lightens it to 70% opacity; it is not a hardware toner-saving setting and actual savings are printer-dependent.

Printer Properties and Advanced controls are disabled inside Folio and are provided by the subsequent system dialog when the driver supports them. Automatic paper-tray selection by PDF page size is unavailable. Choose a tray in printer properties instead.

All sheets in a job use Letter, A4 or Legal, one orientation, and quarter-inch margins. Auto follows the first selected page, or chooses landscape for Multiple and Booklet. Mixed paper sizes, per-page automatic orientation and borderless printing are not implemented. Actual size and custom scale can clip content at the margins, as shown in the preview.

Choose 150, 300 or 600 dpi under Print quality. Each visible tile or cell renders directly at the selected resolution; there is no 6,000-pixel source cap or automatic quality downgrade. A Letter sheet contains 1,275 by 1,650 pixels at 150 dpi, 2,550 by 3,300 at 300 dpi, and 5,100 by 6,600 at 600 dpi. The on-screen preview uses a lower resolution with the same layout. Higher DPI cannot add detail absent from a scanned source image.

Preparation renders one sheet and one cropped source region at a time, then releases their canvases. PNG encoding is asynchronous. The isolated print window loads the job through a temporary in-memory protocol handler, avoiding Chromium's inline-URL size limit without writing print content to disk. Cancel preparation stops rendering or discards an in-progress encoding before any print handoff; it waits for that work to settle before another job can start. The system dialog handles cancellation after handoff.

Jobs are limited to 100 sheets, 48 megapixels per sheet, 576 MiB of decoded sheet pixels and 64 MiB of encoded PNG data. The decoded-image limit is checked before rendering and again at the desktop boundary, which also verifies PNG dimensions against the chosen DPI and paper. It allows four Letter sheets at 600 dpi, or three Legal sheets. PDF resources, temporary rendering surfaces and printer-driver memory are additional overhead, so this is not a cap on total process memory. If a limit is exceeded, select fewer pages, reduce poster scale or overlap, or explicitly choose a lower DPI. Quality is never silently reduced.

Keep 100% scaling and the same paper size in the system dialog to preserve the preview's layout. Folio also requests the selected printer DPI, but physical device resolution and driver behavior depend on the printer.

The browser edition retains Folio's original browser print workflow. The new dialog requires Electron. The code is shared across desktop platforms, but this checkout was verified on Windows only.

## Checks

```sh
node scripts/test-print.mjs
npm run build
node scripts/smoke-print.mjs
node scripts/smoke-print-resolution.mjs
npm run smoke
```

The print smoke check runs hidden and intercepts the native print call. It writes screenshots and generated PDF evidence to `release/smoke-print`; it never sends a print job. Tests cover page ranges, sizing, poster tiles, booklet ordering and padding, duplex requests, preview interaction, unit switching, invalid overlap, memory-budget errors, focus trapping, IPC validation, output sheet counts and paper dimensions. The resolution check starts a temporary local Vite server and a hidden Electron window to test actual PDF pixels at every DPI, effective viewport scale, cropped allocation sizes, matching overlap pixels, preview geometry and cancellation. The main smoke test checks that preparing an annotated print snapshot preserves unsaved work.

Physical printing and driver-specific dialogs require a manual check on the intended printer. No printer job was submitted during development.
