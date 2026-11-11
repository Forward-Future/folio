// An abandoned document must not keep its OCR hooks after another open begins.
export async function restoreForOpen(session: { restore(): Promise<void>; destroy(): void }, signal: AbortSignal) {
  try {
    signal.throwIfAborted();
    await session.restore();
    signal.throwIfAborted();
  } catch (error) {
    session.destroy();
    throw error;
  }
}
