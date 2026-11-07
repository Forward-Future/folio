// How recognized text joins a page’s own text.

/** The page's own text chunks first, then one chunk of recognized items. */
export function withRecognized(source: ReadableStream, items: unknown[], styles: object): ReadableStream {
  const reader = source.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (!done) return controller.enqueue(value);
      controller.enqueue({ items, styles, lang: null });
      controller.close();
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
