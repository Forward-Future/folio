import { describe, expect, it, vi } from "vitest";
import { restoreForOpen } from "./restore";

describe("OCR restore during document opening", () => {
  it("destroys the old session if a newer document opens during restore", async () => {
    let finish!: () => void;
    const session = { restore: () => new Promise<void>(resolve => { finish = resolve; }), destroy: vi.fn() };
    const controller = new AbortController();
    const old = restoreForOpen(session, controller.signal);
    controller.abort(); finish();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    expect(session.destroy).toHaveBeenCalledOnce();
  });
  it("cleans up if restore fails and leaves a successful session alive", async () => {
    const failing = { restore: vi.fn().mockRejectedValue(new Error("failed")), destroy: vi.fn() };
    await expect(restoreForOpen(failing, new AbortController().signal)).rejects.toThrow("failed");
    expect(failing.destroy).toHaveBeenCalledOnce();
    const good = { restore: vi.fn().mockResolvedValue(undefined), destroy: vi.fn() };
    await restoreForOpen(good, new AbortController().signal);
    expect(good.destroy).not.toHaveBeenCalled();
  });
});
