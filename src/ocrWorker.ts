import { SCAN_LANGUAGES, type ScanLanguage } from "./scanLanguage";
import { installedScanLanguages, OCR_CACHE_PATH } from "./scanLanguagePacks";
export class MissingScanPack extends Error {}
import type { Worker as OcrWorker } from "tesseract.js";

/** Start Tesseract and own the browser worker even if initialization never resolves. */
export async function startOcrWorker(signal: AbortSignal, languages: ScanLanguage[] = ["eng"]): Promise<OcrWorker> {
  if (languages.some(code => code !== "eng")) {
    const installed = await installedScanLanguages();
    signal.throwIfAborted();
    const missing = SCAN_LANGUAGES.find(({ id }) => languages.includes(id) && !installed.has(id));
    if (missing) throw new MissingScanPack(`Download the ${missing.name} pack in Settings to read this scan.`);
  }
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  signal.throwIfAborted();
  const base = `${import.meta.env.BASE_URL}ocr`;
  const NativeWorker = globalThis.Worker;
  let raw: Worker | undefined;
  let rejected = false;
  let initializing = true;
  let abort: (() => void) | undefined;
  let creation: Promise<OcrWorker>;
  try {
    // Tesseract creates the native worker synchronously but doesn't expose it until initialization completes.
    // Capture that worker only during the synchronous call, then immediately restore the global constructor.
    globalThis.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        raw = this;
      }
    };
    creation = new Promise<OcrWorker>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (!initializing) return;
        rejected = true;
        raw?.terminate();
        reject(error);
      };
      abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        createWorker(languages, OEM.LSTM_ONLY, {
          workerPath: `${base}/worker.min.js`, workerBlobURL: false, corePath: base, langPath: base,
          cachePath: OCR_CACHE_PATH, cacheMethod: "readOnly", errorHandler: fail,
        }).then(worker => {
          if (rejected) void worker.terminate();
          else resolve(worker);
        }, fail);
      } catch (error) { fail(error); }
    });
  } finally {
    globalThis.Worker = NativeWorker;
  }
  try {
    const worker = await creation;
    try {
      signal.throwIfAborted();
      let stopConfig: (() => void) | undefined;
      try {
        await Promise.race([worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO }), new Promise<never>((_, reject) => {
          stopConfig = () => reject(signal.reason);
          if (signal.aborted) stopConfig();
          else signal.addEventListener("abort", stopConfig, { once: true });
        })]);
      } finally {
        if (stopConfig) signal.removeEventListener("abort", stopConfig);
      }
      signal.throwIfAborted();
      initializing = false;
      return worker;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
