import { useEffect, useState } from "react";
import { Icon } from "./icons";

/** pdf.js FindState: FOUND 0, NOT_FOUND 1, WRAPPED 2, PENDING 3 */
export interface FindResult {
  current: number;
  total: number;
  state: number | null;
}

type FindOpts = { again?: boolean; previous?: boolean; caseSensitive?: boolean; entireWord?: boolean };

export function SearchBar({
  result,
  onFind,
  onClose,
}: {
  result: FindResult;
  onFind: (q: string, o: FindOpts) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [entireWord, setWord] = useState(false);

  // Search as you type, debounced so large documents stay responsive.
  useEffect(() => {
    const t = window.setTimeout(() => onFind(query, { caseSensitive, entireWord }), 160);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, entireWord]);

  const step = (previous: boolean) => query && onFind(query, { again: true, previous, caseSensitive, entireWord });

  const status =
    !query ? "" : result.state === 3 ? "Searching…" : result.total === 0 ? "No results" : `${result.current} of ${result.total}`;

  return (
    <div className="searchbar" role="search">
      <Icon name="search" size={16} />
      <input
        id="folio-search"
        aria-label="Find in document"
        autoFocus
        placeholder="Find in document"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        spellCheck={false}
      />
      <span className={`search-status ${query && result.total === 0 && result.state !== 3 ? "miss" : ""}`}>{status}</span>
      <button className={`chip ${caseSensitive ? "on" : ""}`} onClick={() => setCase(!caseSensitive)} title="Match case">
        Aa
      </button>
      <button className={`chip ${entireWord ? "on" : ""}`} onClick={() => setWord(!entireWord)} title="Whole words">
        <u>ab</u>
      </button>
      <span className="divider" />
      <button className="pill-btn" onClick={() => step(true)} disabled={!result.total} title="Previous (Shift+Enter)">
        <Icon name="chevronUp" size={16} />
      </button>
      <button className="pill-btn" onClick={() => step(false)} disabled={!result.total} title="Next (Enter)">
        <Icon name="chevronDown" size={16} />
      </button>
      <button className="pill-btn" onClick={onClose} title="Close (Esc)">
        <Icon name="close" size={15} />
      </button>
    </div>
  );
}
