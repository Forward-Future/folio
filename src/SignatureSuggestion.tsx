import { useState } from "react";
import { Icon } from "./icons";
import { fitSignature, readSignatures, type SavedSignature, type SignatureImage, type SignatureTarget } from "./signatures";

export function SignatureSuggestion({ targets, page, placing, onSign, onReview, onDismiss }: {
  targets: SignatureTarget[]; page: number; placing: boolean;
  onSign: (image: SignatureImage, rect: number[]) => Promise<void>;
  onReview: () => void; onDismiss: () => void;
}) {
  const field = targets.length === 1 && targets[0].kind === "field" ? targets[0] : null;
  const [saved] = useState(() => field ? readSignatures() : []);
  const [error, setError] = useState("");
  const sign = async (mark: SavedSignature) => {
    if (!field || placing) return;
    setError("");
    try { await onSign(mark, fitSignature(mark, field.rect)); }
    catch (reason) { setError((reason as Error).message); }
  };
  return <section className="signature-suggestion" aria-label="Signature suggestion">
    <span>{field?.label || "Possible signature area"} on page {page}</span>
    {/* Names can repeat, so each saved mark shows its image and signs in one click. */}
    {saved.map(mark => <button key={mark.key} className="signature-suggestion-mark" disabled={placing}
      aria-label={"Sign with " + mark.name} title={"Sign with " + mark.name} onClick={() => void sign(mark)}>
      <img src={mark.url} alt="" /><span>{mark.name}</span>
    </button>)}
    <button className={saved.length ? "btn ghost" : "btn primary"} disabled={placing} onClick={onReview}>Review signature</button>
    <button className="pill-btn" disabled={placing} aria-label="Dismiss signature suggestion" onClick={onDismiss}><Icon name="close" size={14} /></button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
