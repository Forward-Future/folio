import { useState } from "react";
import { Icon } from "./icons";
import { fitSignature, readSignatures, type SignatureImage, type SignatureTarget } from "./signatures";

export function SignatureSuggestion({ targets, page, placing, onSign, onReview, onDismiss }: {
  targets: SignatureTarget[]; page: number; placing: boolean;
  onSign: (image: SignatureImage, rect: number[]) => Promise<void>;
  onReview: () => void; onDismiss: () => void;
}) {
  const field = targets.length === 1 && targets[0].kind === "field" ? targets[0] : null;
  const [saved] = useState(() => field ? readSignatures() : []);
  const [key, setKey] = useState(saved.length === 1 ? saved[0].key : "");
  const [error, setError] = useState("");
  const selected = saved.find(item => item.key === key);
  const sign = async () => {
    if (!field || !selected || placing) return;
    setError("");
    try { await onSign(selected, fitSignature(selected, field.rect)); }
    catch (reason) { setError((reason as Error).message); }
  };
  return <section className="signature-suggestion" aria-label="Signature suggestion">
    <span>{field?.label || "Possible signature area"} on page {page}</span>
    {saved.length > 1 && <select aria-label="Signature to add" value={key} disabled={placing} onChange={event => setKey(event.target.value)}>
      <option value="" disabled>Choose a signature</option>
      {saved.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}
    </select>}
    {saved.length > 0 && <button className="btn primary" disabled={!selected || placing} onClick={() => void sign()}>
      {placing ? "Adding…" : saved.length === 1 ? "Sign with " + saved[0].name : "Sign field"}
    </button>}
    <button className={saved.length ? "btn ghost" : "btn primary"} disabled={placing} onClick={onReview}>Review signature</button>
    <button className="pill-btn" disabled={placing} aria-label="Dismiss signature suggestion" onClick={onDismiss}><Icon name="close" size={14} /></button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
