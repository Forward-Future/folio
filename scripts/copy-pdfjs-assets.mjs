// Copies pdf.js runtime assets (CJK cmaps, standard fonts, wasm decoders, ICC profiles) and the OCR runtime
// (Tesseract worker, wasm cores, English model) into public/.
// quickjs-eval.* runs JavaScript embedded in PDFs, which Folio never does, so it stays out.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "node_modules/pdfjs-dist");
const dest = resolve(root, "public/pdfjs");

// Start clean, so files dropped from this list don't linger from earlier builds.
rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = resolve(src, dir);
  if (existsSync(from)) cpSync(from, resolve(dest, dir), { recursive: true, filter: (file) => !basename(file).startsWith("quickjs-eval") });
}

// OCR runs fully offline. Only the LSTM cores are copied (Folio loads the LSTM-only engine): the
// relaxed-SIMD one Chromium picks today, and the SIMD one it falls back to.
const ocr = resolve(root, "public/ocr");
mkdirSync(resolve(ocr, "core"), { recursive: true });
mkdirSync(resolve(ocr, "lang"), { recursive: true });
cpSync(resolve(root, "node_modules/tesseract.js/dist/worker.min.js"), resolve(ocr, "worker.min.js"));
for (const core of ["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"]) {
  cpSync(resolve(root, "node_modules/tesseract.js-core", core), resolve(ocr, "core", core));
}
cpSync(resolve(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"), resolve(ocr, "lang/eng.traineddata.gz"));
