// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiMarkdown } from "./AiMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (text: string, files?: string[]) => {
  const onPage = vi.fn();
  act(() => root.render(<AiMarkdown text={text} files={files} onPage={onPage} />));
  return { onPage, buttons: () => Array.from(container.querySelectorAll<HTMLButtonElement>("button.page-ref")) };
};

describe("AiMarkdown citations", () => {
  it("turns plain page references into page buttons", () => {
    const { onPage, buttons } = render("See (p. 12), (pp. 3-4) and (page 5).");
    expect(buttons().map((button) => button.title)).toEqual(["Go to page 12", "Go to page 3", "Go to page 5"]);
    buttons()[1].click();
    expect(onPage.mock.calls).toEqual([[3]]);
  });

  it("turns file citations into buttons that name the file", () => {
    const { onPage, buttons } = render("(Report.pdf, p. 12) and (NOTES, pp. 3–4).", ["Report.pdf", "Notes.pdf"]);
    expect(buttons().map((button) => button.title)).toEqual(["Go to page 12 of Report.pdf", "Go to page 3 of Notes.pdf"]);
    buttons()[1].click();
    expect(onPage.mock.calls).toEqual([[3, "Notes.pdf"]]);
  });

  it("keeps citations to files that are not open as plain text", () => {
    const { onPage, buttons } = render("(Mystery.pdf, p. 7) and (p. 3).", ["Report.pdf"]);
    expect(buttons().map((button) => button.title)).toEqual(["Go to page 3"]);
    expect(container.textContent).toContain("(Mystery.pdf, p. 7)");
    buttons()[0].click();
    expect(onPage.mock.calls).toEqual([[3]]);
  });

  it("opens the page of a file citation when no files are given", () => {
    const { onPage, buttons } = render("(Report.pdf, p. 12).");
    expect(buttons().map((button) => button.title)).toEqual(["Go to page 12"]);
    buttons()[0].click();
    expect(onPage.mock.calls).toEqual([[12]]);
  });
});
