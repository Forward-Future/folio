import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createWorker: vi.fn(), installed: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker, OEM: { LSTM_ONLY: 1 }, PSM: { AUTO: 3 } }));
vi.mock("./scanLanguagePacks", () => ({ installedScanLanguages: mocks.installed, OCR_CACHE_PATH: "local-ocr" }));
import { startOcrWorker } from "./ocrWorker";

class FakeWorker {
  terminate = vi.fn();
  constructor(_url: string | URL, _options?: WorkerOptions) {}
}
let browserWorker: FakeWorker;
beforeEach(() => { vi.stubGlobal("Worker", FakeWorker); mocks.createWorker.mockReset(); mocks.installed.mockResolvedValue(new Set(["eng", "deu"])); });
afterEach(() => vi.unstubAllGlobals());

describe("OCR worker startup", () => {
  it("uses selected languages and the installed language cache", async () => {
    const worker = { setParameters: vi.fn().mockResolvedValue(undefined), terminate: vi.fn() };
    mocks.createWorker.mockResolvedValue(worker);
    await startOcrWorker(new AbortController().signal, ["deu", "eng"]);
    expect(mocks.createWorker).toHaveBeenCalledWith(["deu", "eng"], 1,
      expect.objectContaining({ cachePath: "local-ocr", cacheMethod: "readOnly" }));
  });

  it("explains a missing language pack without starting a worker", async () => {
    mocks.installed.mockResolvedValue(new Set(["eng"]));
    await expect(startOcrWorker(new AbortController().signal, ["deu"])).rejects.toThrow("Download the German pack");
    expect(mocks.createWorker).not.toHaveBeenCalled();
  });

  it("terminates the native worker and rejects when language initialization reports an error", async () => {
    mocks.createWorker.mockImplementation((_language, _mode, options) => {
      browserWorker = new Worker("worker.js") as unknown as FakeWorker;
      queueMicrotask(() => options.errorHandler(new Error("language unavailable")));
      return new Promise(() => {});
    });
    await expect(startOcrWorker(new AbortController().signal)).rejects.toThrow("language unavailable");
    expect(browserWorker.terminate).toHaveBeenCalledOnce();
    expect(globalThis.Worker).toBe(FakeWorker);
  });

  it("releases a worker if the document closes during initialization", async () => {
    mocks.createWorker.mockImplementation(() => {
      browserWorker = new Worker("worker.js") as unknown as FakeWorker;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const starting = startOcrWorker(controller.signal);
    await vi.waitFor(() => expect(mocks.createWorker).toHaveBeenCalledOnce());
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(browserWorker.terminate).toHaveBeenCalledOnce();
  });

  it("settles startup when the document closes during configuration", async () => {
    let release!: () => void;
    const config = new Promise<void>(resolve => { release = resolve; });
    const worker = { setParameters: vi.fn(() => config), terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker.mockImplementation(() => Promise.resolve(worker));
    const controller = new AbortController();
    const starting = startOcrWorker(controller.signal);
    await vi.waitFor(() => expect(worker.setParameters).toHaveBeenCalledOnce());
    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    release();
  });

  it("terminates an initialized worker if configuring it fails", async () => {
    const worker = { setParameters: vi.fn().mockRejectedValue(new Error("configuration failed")), terminate: vi.fn().mockResolvedValue(undefined) };
    mocks.createWorker.mockImplementation(() => {
      browserWorker = new Worker("worker.js") as unknown as FakeWorker;
      return Promise.resolve(worker);
    });
    await expect(startOcrWorker(new AbortController().signal)).rejects.toThrow("configuration failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
