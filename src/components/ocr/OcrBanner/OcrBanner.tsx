import { Icon } from "../../../icons";
import type { OcrSession } from "../../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../../lib/ocr/types";
import "./OcrBanner.css";

/** Offers to make a scanned document searchable, then shows progress while it is read. */
export function OcrBanner({ session, state, onStart }: { session: OcrSession; state: OcrState; onStart: () => void }) {
  if (state.phase === "idle" || state.phase === "done") return null;
  const percent = state.total ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="ocr-card" role="status">
      {state.phase === "offer" && (
        <>
          <div>
            <strong>This looks like a scan</strong>
            <span>Read the text on this device to search, select, highlight, and ask AI about it.</span>
          </div>
          <button className="btn primary" onClick={onStart}>Recognize text</button>
          <button className="pill-btn" aria-label="Not now" title="Not now" onClick={() => session.dismiss()}><Icon name="close" size={15} /></button>
        </>
      )}
      {state.phase === "running" && (
        <>
          <div>
            <strong>Recognizing text… {percent}%</strong>
            <span>Page {Math.min(state.done + 1, state.total)} of {state.total}. You can keep reading.</span>
            <div className="ocr-bar" aria-hidden><i style={{ width: `${percent}%` }} /></div>
          </div>
          <button className="btn ghost" onClick={() => session.cancel()}>Stop</button>
        </>
      )}
      {state.phase === "error" && (
        <>
          <div>
            <strong>Text recognition failed</strong>
            <span>{state.error}</span>
          </div>
          <button className="btn primary" onClick={onStart}>Try again</button>
          <button className="pill-btn" aria-label="Dismiss" title="Dismiss" onClick={() => session.dismiss()}><Icon name="close" size={15} /></button>
        </>
      )}
    </div>
  );
}
