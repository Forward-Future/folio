// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ocr", () => ({ ocrSession: () => undefined }));
vi.mock("./recent", () => ({
  getAiHistory: vi.fn(async () => ({ messages: [], attachments: [], generation: 0 })),
  saveAiHistory: vi.fn(async () => {}),
}));
vi.mock("./ai", () => ({
  PROVIDERS: { custom: "Custom" }, CLAUDE_CODE_URL: "", USAGE_URL: "",
  savedProvider: () => "custom", subscribeAiPreferences: () => () => {},
  saveAiPreference: vi.fn(), signInChatGPT: vi.fn(),
}));
vi.mock("./preferences", () => ({ readSetting: (key: string) => key === "folio:ai-model:custom" ? "fixture-model" : null }));

import { AiPanel } from "./AiPanel";
import { getAiHistory, saveAiHistory } from "./recent";
import type { DocumentTabs } from "./documentTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLElement, root: Root, sequence = 0;
let onEvent: (event: AiEvent) => void;
const ask = vi.fn<FolioAi["ask"]>(async () => true);
const cancel = vi.fn<FolioAi["cancel"]>(async () => true);
const originalDesktop = window.folioDesktop;

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  vi.clearAllMocks();
  window.folioDesktop = { ai: {
    status: async () => ({
      chatgpt: { connected: false }, claude: { installed: false, loggedIn: false },
      custom: { configured: true, baseUrl: "https://fixture.test/v1", hasKey: false },
    }),
    ask, cancel, onEvent: (callback: typeof onEvent) => { onEvent = callback; return () => {}; },
  } } as unknown as FolioDesktop;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.folioDesktop = originalDesktop;
});

async function renderPanel({ locked = false, fails = false, name = "Other.pdf" } = {}) {
  const doc = { key: 2, contentId: "fixture-other", name, locked };
  const tabs = {
    subscribe: () => () => {}, snapshot: () => 0, documents: () => [doc],
    documentText: async () => {
      if (fails) throw new Error("damaged content stream");
      return { name: doc.name, locked, text: "private attachment text", truncated: false, recognized: false };
    },
  } as unknown as DocumentTabs;
  const pdf = {
    numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "main text" }] }) }),
  } as unknown as Parameters<typeof AiPanel>[0]["pdf"];
  await act(async () => root.render(<AiPanel pdf={pdf} docId={`attachment-test-${++sequence}`} docName="Main.pdf" persist
    context={null} onClearContext={() => {}} onGoToPage={() => {}} onSettings={() => {}} onClose={() => {}} tabs={tabs} tabKey={1} />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function addOther() {
  await act(async () => button("Add open document").click());
  await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
}
async function send() {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Compare the documents");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function finish() {
  const { id } = ask.mock.calls[0][0];
  await act(async () => onEvent({ id, type: "done" }));
}

describe("Ask AI attached documents", () => {
  it("uses the same distinct name in the picker, chip and request for a same-name PDF", async () => {
    await renderPanel({ name: "Main.pdf" });
    await act(async () => button("Add open document").click());
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent).toContain("Main (2)");
    await act(async () => item.click());
    expect(button("Remove Main (2).pdf")).not.toBeNull();
    await send();
    expect(ask.mock.calls[0][0].document.name).toBe("Main.pdf");
    expect(ask.mock.calls[0][0].attachments?.[0].name).toBe("Main (2).pdf");
    await finish();
  });

  it("sends the question and explains the skip when an attached PDF cannot be read", async () => {
    await renderPanel({ fails: true });
    await addOther();
    await send();
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][0]).not.toHaveProperty("attachments");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Folio couldn't read Other.pdf, so it was left out.");
    await finish();
  });

  it("keeps a protected attachment's conversation session-only even after it is removed", async () => {
    await renderPanel({ locked: true });
    vi.mocked(saveAiHistory).mockClear();
    await addOther();
    await send();
    expect(ask.mock.calls[0][0].attachments?.[0].text).toBe("private attachment text");
    await finish();
    await act(async () => button("Remove Other.pdf").click());
    await send();
    expect(ask).toHaveBeenCalledTimes(2);
    await act(async () => onEvent({ id: ask.mock.calls[1][0].id, type: "done" }));
    expect(saveAiHistory).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("waits for saved attachments to load before allowing additions", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getAiHistory>>) => void;
    vi.mocked(getAiHistory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await renderPanel();
    expect(button("Add open document").disabled).toBe(true);
    await act(async () => resolve({ messages: [], attachments: [{ name: "Saved.pdf", contentId: "saved-id" }], generation: 0 }));
    expect(button("Add open document").disabled).toBe(false);
    expect(button("Remove Saved.pdf")).not.toBeNull();
  });
});
