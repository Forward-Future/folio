import { describe, expect, it, vi } from "vitest";
import { withRecognized } from "./pages";

describe("withRecognized", () => {
  const streamOf = (chunks: unknown[], onCancel?: () => void) => {
    let i = 0;
    return new ReadableStream({
      pull(controller) { if (i < chunks.length) controller.enqueue(chunks[i++]); else controller.close(); },
      cancel: onCancel,
    });
  };
  const readAll = async (stream: ReadableStream) => {
    const out: unknown[] = [];
    const reader = stream.getReader();
    for (;;) { const { value, done } = await reader.read(); if (done) return out; out.push(value); }
  };

  it("passes the page's own chunks through, then adds one chunk of recognized items", async () => {
    const own = [{ items: [1], styles: {} }, { items: [2], styles: {} }];
    const styles = { ocr: {} };
    expect(await readAll(withRecognized(streamOf(own), ["r"], styles))).toEqual([...own, { items: ["r"], styles, lang: null }]);
  });

  it("still yields the recognized chunk when the page has no text of its own", async () => {
    expect(await readAll(withRecognized(streamOf([]), ["r"], {}))).toEqual([{ items: ["r"], styles: {}, lang: null }]);
  });

  it("cancels the page's own stream when the reader gives up", async () => {
    const cancelled = vi.fn();
    const stream = withRecognized(streamOf([{ items: [] }, { items: [] }], cancelled), ["r"], {});
    await stream.cancel("done");
    expect(cancelled).toHaveBeenCalledWith("done");
  });
});
