// Tesseract's worker loads its core and language data by name. Ship them locally for offline reading.
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dest = resolve(root, "public/ocr");
mkdirSync(dest, { recursive: true });
function copy(source, name) {
  cpSync(resolve(root, "node_modules", source), resolve(dest, name));
}
for (const name of ["worker.min.js", "worker.min.js.LICENSE.txt"]) copy(`tesseract.js/dist/${name}`, name);
for (const cpu of ["", "-simd", "-relaxedsimd"]) {
  const name = `tesseract-core${cpu}-lstm.wasm.js`;
  copy(`tesseract.js-core/${name}`, name);
}
for (const lang of ["eng", "deu"]) {
  copy(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, `${lang}.traineddata.gz`);
}
copy("tesseract.js-core/LICENSE", "LICENSE.txt");
