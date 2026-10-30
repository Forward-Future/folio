// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OcrSession } from "../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../lib/ocr/types";
import { useOcrState } from "./useOcrState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The part of a session the hook reads: its state, and a way to hear that it changed. */
function fakeSession(state: OcrState) {
  const listeners = new Set<() => void>();
  return {
    state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change(next: OcrState) { this.state = next; listeners.forEach((l) => l()); },
    listening: () => listeners.size,
  };
}

let root: Root;
let seen: OcrState[];
function Probe({ session }: { session: OcrSession | null }) {
  seen.push(useOcrState(session));
  return null;
}
const render = (session: ReturnType<typeof fakeSession> | null) => act(async () => { root.render(<Probe session={session as unknown as OcrSession | null} />); });

beforeEach(() => { root = createRoot(document.createElement("div")); seen = []; });
afterEach(() => act(() => root.unmount()));

describe("useOcrState", () => {
  it("is idle with no document", async () => {
    await render(null);
    expect(seen.at(-1)).toEqual({ phase: "idle", done: 0, total: 0 });
  });

  it("reports the session's state, and follows it as it changes", async () => {
    const session = fakeSession({ phase: "offer", done: 0, total: 5 });
    await render(session);
    expect(seen.at(-1)).toEqual({ phase: "offer", done: 0, total: 5 });
    await act(async () => session.change({ phase: "running", done: 2, total: 5 }));
    expect(seen.at(-1)).toEqual({ phase: "running", done: 2, total: 5 });
  });

  it("stops listening when the session goes away", async () => {
    const session = fakeSession({ phase: "offer", done: 0, total: 5 });
    await render(session);
    expect(session.listening()).toBe(1);
    await render(null);
    expect(session.listening()).toBe(0);
    expect(seen.at(-1)?.phase).toBe("idle");
  });
});
