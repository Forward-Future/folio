// Copies pdf.js runtime assets (CJK cmaps, standard fonts, wasm decoders, ICC profiles) into public/.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "node_modules/pdfjs-dist");
const dest = resolve(root, "public/pdfjs");

for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = resolve(src, dir);
  if (existsSync(from)) cpSync(from, resolve(dest, dir), { recursive: true });
}
