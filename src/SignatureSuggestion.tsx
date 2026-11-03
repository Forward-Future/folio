import { useState } from "react";
import { Icon } from "./icons";
import { fitSignature, readSignatures, type SignatureImage, type SignatureTarget } from "./signatures";

export function SignatureSuggestion({ targets, page, onSign, onReview, onDismiss }: {
  targets: SignatureTarget[]; page: number;
  onSign: (image: SignatureImage, rect: number[]) => Promise<void>;
  onReview: () => void; onDismiss: () => void;
}) {
  const field = targets.length === 1 && targets[0].kind === "field" ? targets[0] : null;
  const [saved] = useState(() => field ? readSignatures() : []);
  const [key, setKey] = useState(saved.length === 1 ? saved[0].key : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = saved.find(item => item.key === key);
  const sign = async () => {
    if (!field || !selected || busy) return;
    setBusy(true); setError("");
    try { await onSign(selected, fitSignature(selected, field.rect)); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="signature-suggestion" aria-label="Signature suggestion">
    <span>{field?.label || (targets[0].kind === "field" ? "Signature fields" : "Possible signature area")} on page {page}</span>
    {saved.length > 1 && <select aria-label="Signature to add" value={key} disabled={busy} onChange={event => setKey(event.target.value)}>
      <option value="" disabled>Choose a signature</option>
      {saved.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
    </select>}
    {saved.length > 0 && <button className="btn primary" disabled={!selected || busy} onClick={() => void sign()}>
      {busy ? "Adding…" : saved.length === 1 ? "Sign with " + saved[0].name : "Sign field"}
    </button>}
    <button className={saved.length ? "btn ghost" : "btn primary"} disabled={busy} onClick={onReview}>Review signature</button>
    <button className="pill-btn" disabled={busy} aria-label="Dismiss signature suggestion" onClick={onDismiss}><Icon name="close" size={14} /></button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
