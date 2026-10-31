import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OcrBanner } from "./OcrBanner";
import type { OcrSession } from "../../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../../lib/ocr/types";

const session = () => ({ cancel: vi.fn(), dismiss: vi.fn() }) as unknown as OcrSession & { cancel: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };
const html = (state: OcrState, onStart = () => {}) => renderToStaticMarkup(<OcrBanner session={session()} state={state} onStart={onStart} />);

/** The buttons in a rendered tree, with their label (text or aria-label) and click handler. */
function buttons(node: ReactNode, found: { label: string; click: () => void }[] = []) {
  if (!isValidElement(node)) return found;
  const props = node.props as { children?: ReactNode; onClick?: () => void; "aria-label"?: string };
  const text = (n: ReactNode): string => (typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n.props as { children?: ReactNode }).children) : "");
  if (node.type === "button" && props.onClick) found.push({ label: props["aria-label"] ?? text(props.children), click: props.onClick });
  for (const child of [props.children].flat()) buttons(child as ReactNode, found);
  return found;
}
const click = (tree: ReactNode, label: string) => buttons(tree).find((b) => b.label === label)!.click();
const render = (state: OcrState, s = session(), onStart = vi.fn()) => ({ tree: OcrBanner({ session: s, state, onStart }), s, onStart });

describe("OcrBanner", () => {
  it("shows nothing when there's nothing to say", () => {
    expect(html({ phase: "idle", done: 0, total: 0 })).toBe("");
    expect(html({ phase: "done", done: 3, total: 3 })).toBe("");
  });

  it("offers to recognize text on a scan", () => {
    const markup = html({ phase: "offer", done: 0, total: 5 });
    expect(markup).toContain("This looks like a scan");
    expect(markup).toContain("Recognize text");
    expect(markup).toContain('aria-label="Not now"');
  });

  it("starts recognition from the offer, and goes away when dismissed", () => {
    const { tree, s, onStart } = render({ phase: "offer", done: 0, total: 5 });
    click(tree, "Recognize text");
    expect(onStart).toHaveBeenCalledTimes(1);
    click(tree, "Not now");
    expect(s.dismiss).toHaveBeenCalledTimes(1);
  });

  it("shows progress while it works, and the page it is on", () => {
    const markup = html({ phase: "running", done: 1, total: 4 });
    expect(markup).toContain("Recognizing text… 25%");
    expect(markup).toContain("Page 2 of 4");
    expect(markup).toContain("You can keep reading");
    expect(markup).toContain("width:25%");
  });

  it("never names a page past the end", () => {
    const markup = html({ phase: "running", done: 4, total: 4 });
    expect(markup).toContain("Page 4 of 4");
    expect(markup).toContain("100%");
  });

  it("doesn't divide by zero before the page count is known", () => {
    const markup = html({ phase: "running", done: 0, total: 0 });
    expect(markup).toContain("0%");
    expect(markup).not.toContain("NaN");
  });

  it("can be stopped while it works", () => {
    const { tree, s } = render({ phase: "running", done: 1, total: 4 });
    click(tree, "Stop");
    expect(s.cancel).toHaveBeenCalledTimes(1);
  });

  it("says what went wrong and offers another go", () => {
    const state: OcrState = { phase: "error", done: 0, total: 3, error: "Couldn't start text recognition." };
    const markup = html(state);
    expect(markup).toContain("Text recognition failed");
    expect(markup).toContain("Couldn&#x27;t start text recognition.");
    const { tree, s, onStart } = render(state);
    click(tree, "Try again");
    expect(onStart).toHaveBeenCalledTimes(1);
    click(tree, "Dismiss");
    expect(s.dismiss).toHaveBeenCalledTimes(1);
  });

  it("is announced to screen readers as a status", () => {
    expect(html({ phase: "offer", done: 0, total: 1 })).toContain('role="status"');
  });
});
