import { useEffect, useRef, type RefObject } from "react";
import type { OcrSession } from "../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../lib/ocr/types";
import type { EventBus, PDFFindController } from "../../viewer";

/** The request pdf.js find is working on (its `state`), as the find bar sent it. */
type FindRequest = { query?: unknown };

/**
 * pdf.js find reads every page's text once and keeps it, so words recognized after a search began are missing from its
 * results. When recognition has stopped or finished and the search is open, find is pointed at the document again
 * (which empties it), and the search that was showing is run again so the reader doesn't have to type it twice. As
 * with typing it again, the view moves to the first match from the page being read.
 */
export function useOcrSearchRefresh({ session, searchOpen, phase, find, bus }: {
  session: OcrSession | null;
  searchOpen: boolean;
  phase: OcrState["phase"];
  find: RefObject<PDFFindController | null>;
  bus: RefObject<EventBus | null>;
}) {
  // The text version find has seen, per document: a new document starts from whatever it was opened with.
  const seen = useRef<{ session: OcrSession; version: number } | null>(null);
  useEffect(() => {
    if (!session) return;
    if (seen.current?.session !== session) seen.current = { session, version: session.version };
    // Mid-run, each page would reset find again, so it waits for a pause.
    if (!searchOpen || session.version === seen.current.version || phase === "running") return;
    seen.current.version = session.version;
    const controller = find.current!;
    // `highlightMatches` is true while a search is showing and false once the find bar was closed (its last query is
    // then stale), and has to be read before setDocument clears both.
    const request = controller.highlightMatches ? (controller as unknown as { state: FindRequest | null }).state : null;
    controller.setDocument(session.pdf);
    // A fresh forward search, not a repeat of the last Enter or Shift+Enter.
    if (request?.query) bus.current!.dispatch("find", { ...request, type: "", findPrevious: false });
  }, [session, searchOpen, phase, find, bus]);
}
