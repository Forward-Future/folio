import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const ocr = (...parts: string[]) => resolve(root, "public/ocr", ...parts);

beforeAll(() => {
  execFileSync(process.execPath, [resolve(root, "scripts/copy-ocr-assets.mjs")], { cwd: root });
});

describe("the OCR runtime that ships with the app", () => {
  it.each([
    "worker.min.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-lstm.wasm.js",
    "eng.traineddata.gz",
  ])("includes %s", (file) => {
    expect(existsSync(ocr(file))).toBe(true);
    expect(statSync(ocr(file)).size).toBeGreaterThan(100_000);
  });

  it("ships the language model compressed, as Tesseract is told to expect", () => {
    const [first, second] = readFileSync(ocr("eng.traineddata.gz"));
    expect([first, second]).toEqual([0x1f, 0x8b]);
  });

  it("ships exactly the core files this Tesseract version asks for in LSTM-only mode", () => {
    // If a Tesseract upgrade renames its cores, OCR would silently fail to start; this catches it at the source.
    const loader = readFileSync(resolve(root, "node_modules/tesseract.js/src/worker-script/browser/getCore.js"), "utf8");
    expect(loader).toContain("tesseract-core-relaxedsimd-lstm.wasm.js");
    expect(loader).toContain("tesseract-core-simd-lstm.wasm.js");
    expect(loader).toContain("tesseract-core-lstm.wasm.js");
  });

  it("is kept out of version control, like the other copied assets", () => {
    // (Windows checks files out with CRLF line endings.)
    expect(readFileSync(resolve(root, ".gitignore"), "utf8").split(/\r?\n/)).toContain("public/ocr");
  });

  it("uses main's shared OCR asset paths", () => {
    const source = readFileSync(resolve(root, "src/ocrWorker.ts"), "utf8");
    expect(source).toContain('`${import.meta.env.BASE_URL}ocr`');
    expect(source).toContain('corePath: base, langPath: base');
  });
});
