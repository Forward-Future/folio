import { useRef, useState } from "react";
import { GEMINI_KEYS_URL, saveAiPreference } from "./ai";
import { ModelPicker } from "./OpenRouterSettings";

const GEMINI_ID = /^[a-z\d][a-z\d._-]{0,127}$/i;

export function GeminiSettings({ ai, configured, onConfigured }: { ai: FolioAi; configured: boolean; onConfigured: (configured: boolean) => void }) {
  const key = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const act = async (action: "save" | "check" | "remove") => {
    const value = action === "save" ? key.current?.value.trim() : undefined;
    if (key.current) key.current.value = "";
    setNotice(""); setError(""); setBusy(true);
    try {
      const result = await ai.geminiKey(action, value);
      if (!result.ok) { setError(result.error || "Couldn't update the Gemini key."); return; }
      onConfigured(!!result.configured);
      setEditing(false);
      setNotice(action === "check" ? "Connection verified." : "");
      if (action !== "check") saveAiPreference("folio:ai-key-revision", crypto.randomUUID());
    } catch { setError("Couldn't update the Gemini key. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="router-settings">
    <p className="settings-hint">Google bills your Gemini API key. When you ask, Google receives the text you ask about and the conversation.{" "}
      <a href={GEMINI_KEYS_URL} target="_blank" rel="noreferrer">Get a key in Google AI Studio</a>.</p>
    {configured && !editing ? <div className="settings-row">
      <div className="settings-label"><span>API key</span><small>Stored securely on this device.</small></div>
      <button className="link small" disabled={busy} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>Manage key</button>
      <button className="btn ghost" disabled={busy} onClick={() => void act("check")}>{busy ? "Checking…" : "Check connection"}</button>
    </div> : <form className="router-key" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label htmlFor="gemini-key">{configured ? "Replacement API key" : "API key"}</label>
      <div><input ref={key} id="gemini-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} required
        placeholder="Paste your Gemini API key" disabled={busy} />
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Verify and save"}</button></div>
      {configured && <div className="router-key-actions">
        <button type="button" className="link small" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
        <button type="button" className="link small" disabled={busy} onClick={() => void act("remove")}>Remove saved key</button>
      </div>}
    </form>}
    {notice && <p role="status" className="settings-hint">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {configured && <ModelPicker storageKey="folio:ai-model:gemini" load={ai.geminiModels}
      validId={id => GEMINI_ID.test(id) && !id.includes("..")} idExample="gemini-2.5-flash" />}
  </div>;
}
