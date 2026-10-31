// Which page to read next, and how recognized text joins a page's own text.

/** The page nearest `focus` that isn't queued yet, or 0 when every page is. Earlier pages win ties. */
export function nearestUnqueued(total: number, queued: ReadonlySet<number>, focus: number): number {
  let best = 0;
  for (let n = 1; n <= total; n++) {
    if (!queued.has(n) && (!best || Math.abs(n - focus) < Math.abs(best - focus))) best = n;
  }
  return best;
}

/** The page's own text chunks first, then one chunk of recognized items. */
export function withRecognized(source: ReadableStream, items: unknown[], styles: object): ReadableStream {
  const reader = source.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (!done) return controller.enqueue(value);
      controller.enqueue({ items, styles, lang: "en" });
      controller.close();
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
