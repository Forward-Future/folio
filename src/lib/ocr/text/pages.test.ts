import { describe, expect, it, vi } from "vitest";
import { nearestUnqueued, withRecognized } from "./pages";

describe("nearestUnqueued", () => {
  it("starts at the page being read", () => {
    expect(nearestUnqueued(10, new Set(), 4)).toBe(4);
  });

  it("then spreads outward, earlier page first on a tie", () => {
    const queued = new Set<number>();
    const order: number[] = [];
    for (let n = nearestUnqueued(5, queued, 4); n; n = nearestUnqueued(5, queued, 4)) { queued.add(n); order.push(n); }
    expect(order).toEqual([4, 3, 5, 2, 1]);
  });

  it("skips pages that are already done", () => {
    expect(nearestUnqueued(5, new Set([3]), 3)).toBe(2);
  });

  it("returns 0 when every page is queued, or there are none", () => {
    expect(nearestUnqueued(3, new Set([1, 2, 3]), 2)).toBe(0);
    expect(nearestUnqueued(0, new Set(), 1)).toBe(0);
  });

  it("copes with a focus outside the document", () => {
    expect(nearestUnqueued(5, new Set(), 99)).toBe(5);
    expect(nearestUnqueued(5, new Set(), 0)).toBe(1);
  });
});

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
    expect(await readAll(withRecognized(streamOf(own), ["r"], styles))).toEqual([...own, { items: ["r"], styles, lang: "en" }]);
  });

  it("still yields the recognized chunk when the page has no text of its own", async () => {
    expect(await readAll(withRecognized(streamOf([]), ["r"], {}))).toEqual([{ items: ["r"], styles: {}, lang: "en" }]);
  });

  it("cancels the page's own stream when the reader gives up", async () => {
    const cancelled = vi.fn();
    const stream = withRecognized(streamOf([{ items: [] }, { items: [] }], cancelled), ["r"], {});
    await stream.cancel("done");
    expect(cancelled).toHaveBeenCalledWith("done");
  });
});
