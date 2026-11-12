import { describe, expect, it } from "vitest";

import { MAX_DOC_CHARS, documentNotes, shareBudget } from "./aiAttachments";

const page = (n: number, text: string) => `[Page ${n}]\n${text}\n\n`;
const pages = (text: string, count: number) => Array.from({ length: count }, (_, i) => page(i + 1, text)).join("");
const doc = (name: string, text: string, truncated = false, recognized = false): AiDocument => ({ name, text, truncated, recognized });

describe("shareBudget", () => {
  it("leaves documents within the budget untouched", () => {
    const a = doc("a.pdf", page(1, "hello") + page(2, "world"));
    expect(shareBudget([a])).toEqual([a]);
    const b = doc("b.pdf", page(1, "more"), true);
    expect(shareBudget([a, b], 1000)).toEqual([a, b]);
  });

  it("splits the budget evenly between two long documents, at page boundaries", () => {
    const a = doc("a.pdf", pages("aaaa", 4));
    const b = doc("b.pdf", pages("bbbb", 4));
    const result = shareBudget([a, b], 60);
    expect(result[0].text).toBe(pages("aaaa", 2));
    expect(result[0]).toMatchObject({ name: "a.pdf", truncated: true, recognized: false });
    expect(result[1].text).toBe(pages("bbbb", 2));
    expect(result[1]).toMatchObject({ name: "b.pdf", truncated: true, recognized: false });
    expect(result[0]).not.toBe(a); // new objects; the inputs are untouched
    expect(a.text).toBe(pages("aaaa", 4));
  });

  it("lets a short document keep its text and gives its share to the long one", () => {
    const short = doc("short.pdf", pages("aaaa", 2));
    const long = doc("long.pdf", pages("bbbb", 10));
    const result = shareBudget([short, long], 90);
    expect(result[0].text).toBe(short.text);
    expect(result[0].truncated).toBe(false);
    expect(result[1].text).toBe(pages("bbbb", 4));
    expect(result[1].truncated).toBe(true);
  });

  it("never cuts a page in half", () => {
    const a = doc("a.pdf", page(1, "words of the first page") + page(2, "words of the second page") + page(3, "words of the third"));
    const result = shareBudget([a], 40);
    expect(result[0].text).toBe(page(1, "words of the first page"));
    expect(result[0].text.endsWith("\n\n")).toBe(true);
    expect(result[0].text).not.toContain("[Page 2]");
  });

  it("sends a document with no text when even its first page doesn't fit its share", () => {
    const huge = doc("huge.pdf", page(1, "x".repeat(100)));
    const result = shareBudget([huge], 20);
    expect(result[0].text).toBe("");
    expect(result[0]).toMatchObject({ name: "huge.pdf", truncated: true });
  });

  it("keeps an empty document empty and gives its share to the others", () => {
    const empty = doc("empty.pdf", "");
    const scanned = doc("scan.pdf", page(1, "aaaa"), false, true);
    const result = shareBudget([empty, scanned], 15);
    expect(result[0]).toEqual(empty);
    expect(result[1].text).toBe(page(1, "aaaa"));
    expect(result[1].recognized).toBe(true);
  });

  it("keeps the truncated flag of documents it doesn't shorten", () => {
    const pre = doc("pre.pdf", page(1, "aaaa"), true);
    expect(shareBudget([pre], 100)).toEqual([pre]);
  });

  it("shares the default budget between documents", () => {
    // Three pages of 90k characters each: two such documents don't fit in the default budget together.
    const body = "a".repeat(90_000);
    const a = doc("a.pdf", pages(body, 3));
    const b = doc("b.pdf", pages(body, 3));
    const result = shareBudget([a, b]);
    expect(result[0].text).toBe(pages(body, 2));
    expect(result[1].text).toBe(pages(body, 2));
    expect(result.map(d => d.text).join("").length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });
});

describe("documentNotes", () => {
  it("notes documents that were cut or have no text", () => {
    const notes = documentNotes([
      doc("normal.pdf", page(1, "text")),
      doc("cut.pdf", page(1, "text"), true),
      doc("scan.pdf", ""),
    ]);
    expect(notes).toEqual([
      "Only the first pages of cut.pdf were sent.",
      "scan.pdf has no readable text yet. If it's a scan, wait for text recognition to finish.",
    ]);
  });

  it("says when none of a document fit", () => {
    expect(documentNotes([doc("huge.pdf", "", true)])).toEqual([
      "huge.pdf is too long to include alongside the other documents, so none of it was sent.",
    ]);
  });
});
