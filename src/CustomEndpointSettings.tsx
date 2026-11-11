import { useRef, useState } from "react";
import { saveAiPreference } from "./ai";
import { ModelPicker } from "./OpenRouterSettings";

// Model IDs vary by server ("llama3.1:8b", "glm-5", "accounts/x/models/y"); only spaces and control characters are ruled out.
const MODEL_ID = /^[\x21-\x7e]{1,256}$/;

export function CustomEndpointSettings({ ai, status, onStatus }: { ai: FolioAi; status: CustomEndpointStatus; onStatus: (status: CustomEndpointStatus) => void }) {
  const address = useRef<HTMLInputElement>(null);
  const key = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const act = async (action: "save" | "check" | "remove") => {
    const input = action === "save" ? { baseUrl: address.current?.value.trim() ?? "", key: key.current?.value.trim() ?? "" } : undefined;
    if (key.current) key.current.value = "";
    setNotice(""); setError(""); setBusy(true);
    try {
      const result = await ai.customEndpoint(action, input);
      if (!result.ok || !result.status) { setError(result.error || "Couldn't update the endpoint."); return; }
      // A model ID belongs to one server, so a new address starts with a fresh choice.
      if (result.status.baseUrl !== status.baseUrl) saveAiPreference("folio:ai-model:custom", "");
      onStatus(result.status);
      setEditing(false);
      setNotice(action === "check" ? "Connection verified." : "");
      if (action !== "check") saveAiPreference("folio:ai-key-revision", crypto.randomUUID());
    } catch { setError("Couldn't update the endpoint. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="router-settings">
    <p className="settings-hint">Use any server that accepts OpenAI-style Chat Completions: a provider's API, a company gateway, or a model running on
      this computer. Addresses must use https, except on this computer or your local network, where Folio asks first. When you ask, that
      server receives the text you ask about and the conversation. Its own terms and billing apply.</p>
    {status.configured && !editing ? <div className="settings-row">
      <div className="settings-label"><span>Endpoint</span><small title={status.baseUrl}>{status.baseUrl}{status.hasKey ? " · key stored securely on this device" : ""}</small></div>
      <button className="link small" disabled={busy} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>Change endpoint</button>
      <button className="btn ghost" disabled={busy} onClick={() => void act("check")}>{busy ? "Checking…" : "Check connection"}</button>
    </div> : <form className="router-key" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label htmlFor="endpoint-url">Base URL</label>
      <input ref={address} id="endpoint-url" type="url" autoComplete="off" spellCheck={false} maxLength={512} required disabled={busy}
        placeholder="https://api.example.com/v1" defaultValue={status.baseUrl} />
      <label htmlFor="endpoint-key">API key (optional)</label>
      <div><input ref={key} id="endpoint-key" type="password" autoComplete="off" spellCheck={false} maxLength={1024} disabled={busy}
        placeholder={status.hasKey ? "Enter the key again to keep using it" : "Leave empty if the server doesn't need one"} />
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Connect"}</button></div>
      {status.configured && <div className="router-key-actions">
        <button type="button" className="link small" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
        <button type="button" className="link small" disabled={busy} onClick={() => void act("remove")}>Remove endpoint</button>
      </div>}
    </form>}
    {notice && <p role="status" className="settings-hint">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {status.configured && <ModelPicker key={status.baseUrl} storageKey="folio:ai-model:custom" load={ai.customModels}
      validId={id => MODEL_ID.test(id)} idExample="llama3.1:8b" />}
  </div>;
}
