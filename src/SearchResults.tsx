import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "./pdf";
import type { EventBus, PDFFindController } from "./viewer";
import { pageText, snippetAt, type PageText, type TextPiece } from "./lib/search";

interface PageResult {
  page: number;
  count: number;
  before: string;
  match: string;
  after: string;
}

const UNREADABLE: PageText = { text: "", breaks: [] };

export function SearchResults({ pdf, controller, bus, onSelect }: {
  pdf: PDFDocumentProxy;
  controller: PDFFindController;
  bus: EventBus;
  onSelect: (page: number) => void;
}) {
  const [results, setResults] = useState<PageResult[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const textCache = useRef(new Map<number, Promise<PageText>>());

  useEffect(() => {
    let generation = 0;
    let timer = 0;
    textCache.current.clear();
    const refresh = async () => {
      const request = ++generation;
      const pages = (controller.pageMatches ?? []).flatMap((matches: number[], index: number) =>
        matches?.length ? [{ page: index + 1, offset: matches[0], count: matches.length, length: controller.pageMatchesLength?.[index]?.[0] ?? 0 }] : []);
      setPageCount(pages.length);
      const next: PageResult[] = [];
      for (const entry of pages.slice(0, 100)) {
        if (request !== generation) return;
        let text = textCache.current.get(entry.page);
        if (!text) {
          // Read the page the way find does: its offsets are into the text as stored, not as normalized for display.
          text = pdf.getPage(entry.page).then(page => page.getTextContent({ disableNormalization: true })).then(content =>
            pageText(content.items as TextPiece[]));
          textCache.current.set(entry.page, text);
        }
        const content = await text.catch(() => UNREADABLE);
        next.push({ page: entry.page, count: entry.count, ...snippetAt(content, entry.offset, entry.length) });
        if (next.length % 10 === 0 && request === generation) {
          setResults([...next]);
          await new Promise(resolve => window.setTimeout(resolve, 0));
        }
      }
      if (request === generation) setResults(next);
    };
    const schedule = () => {
      generation++;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 100);
    };
    const clear = () => {
      generation++;
      window.clearTimeout(timer);
      setResults([]);
      setPageCount(0);
    };
    bus.on("updatetextlayermatches", schedule);
    bus.on("updatefindmatchescount", schedule);
    bus.on("find", clear);
    schedule();
    return () => {
      generation++;
      window.clearTimeout(timer);
      bus.off("updatetextlayermatches", schedule);
      bus.off("updatefindmatchescount", schedule);
      bus.off("find", clear);
    };
  }, [pdf, controller, bus]);

  return <aside className="search-results" aria-label="Search results">
    <h3>Matching pages <span>{pageCount}</span></h3>
    {results.length === 0 && <p className="search-hint">Search above to see matching pages. Enter and Shift+Enter navigate individual matches.</p>}
    <div className="search-result-list">
      {results.map(result => <button key={result.page} aria-label={"Go to page " + result.page + ", " + result.count + " matches"} onClick={() => onSelect(result.page)}>
        <strong>Page {result.page} <span>{result.count} {result.count === 1 ? "match" : "matches"}</span></strong>
        <span>{result.before}<mark>{result.match}</mark>{result.after}</span>
      </button>)}
    </div>
    {pageCount > 100 && <p className="search-hint">Showing the first 100 matching pages. Use Enter to reach every match.</p>}
  </aside>;
}
