import type { AttachmentActionState, AttachmentItem, DiscoverySnapshot } from "./attachments";
import { Icon } from "./icons";
import "./attachments.css";

export function AttachmentsPanel({ state, actions = [], onSave, onRead, onRetryDiscovery, onCancelAction }: {
  state: DiscoverySnapshot;
  actions?: AttachmentActionState[];
  onSave(item: AttachmentItem): void;
  onRead(item: AttachmentItem): void;
  onRetryDiscovery?(): void;
  onCancelAction?(id: string): void;
}) {
  return <section className="attachments-panel" aria-label="Attachments">
    <div className="attachments-heading"><h2>Attachments</h2>{state.complete && <span>{state.items.length}{state.truncated ? "+" : ""}</span>}</div>
    {state.isCollection && <p className="attachments-help">This PDF contains a Portfolio. Its component files are shown in a flat list.</p>}
    {!state.complete && <p className="attachments-progress" role="status">{state.catalogLoading ? "Checking document attachments…" : state.pagesLoading ? "Checking page attachments…" : "Checking attachments…"}</p>}
    {state.errors.length > 0 && <div className="attachments-discovery-error" role="status">
      <p>Some attachments couldn't be checked.</p>
      {state.errors.map((error, index) => <p key={index}>{error}</p>)}
      {onRetryDiscovery && <button className="btn ghost" onClick={onRetryDiscovery}>Check again</button>}
    </div>}
    {state.truncated && <p className="attachments-help">The attachment list reached Folio's limit. More files may be present.</p>}
    {state.complete && !state.items.length && !state.errors.length && <p className="attachments-help">No supported attachments found.</p>}
    <ul className="attachment-list">
      {state.items.map(item => {
        const action = actions.findLast(candidate => candidate.key === item.key);
        const busy = action && ["queued", "extracting", "awaiting-password"].includes(action.status);
        const isPdf = /\.pdf$/i.test(item.filename);
        return <li className="attachment-item" key={item.key} data-attachment-key={item.key} data-attachment-id={item.retrievalId} data-attachment-source={item.sourceKind}>
          <div className="attachment-filename"><Icon name="file" size={17} /><span>{item.filename || "Unnamed attachment"}</span></div>
          {item.description && <p className="attachment-description">{item.description}</p>}
          <p className="attachment-source">{item.sourceKind === "document" ? "Document attachment" : item.pageNumbers.length ? `Page ${item.pageNumbers.join(", ")}` : "Page attachment"}</p>
          <div className="attachment-actions">
            <button className="btn ghost" disabled={!!busy} onClick={() => onSave(item)} aria-label={`Save ${item.filename || "unnamed attachment"}`}><Icon name="download" size={14} />Save</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => onRead(item)} aria-label={`${isPdf ? "Read PDF" : "Try as PDF"}: ${item.filename || "unnamed attachment"}`}>{isPdf ? "Read PDF" : "Try as PDF"}</button>
          </div>
          {busy && <div className="attachment-action-status" role="status"><span>{action.status === "queued" ? "Queued…" : action.status === "awaiting-password" ? "Waiting for password…" : "Extracting…"}</span>{onCancelAction && <button onClick={() => onCancelAction(action.id)}>Cancel</button>}</div>}
          {action?.status === "error" && <p className="attachment-file-error" role="status">{action.error || "Couldn't extract this file. Try again."}</p>}
        </li>;
      })}
    </ul>
    <p className="attachments-help attachments-scope">Some associated files or Portfolio features may not appear here.</p>
  </section>;
}
