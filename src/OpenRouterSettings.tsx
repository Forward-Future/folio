import { useEffect, useRef, useState } from "react";
import { saveAiPreference } from "./ai";
import { readSetting } from "./preferences";

const ROUTER_ID = /^[a-z\d_~@.-]+\/[a-z\d_:./~@-]+$/i;

interface PickerProps {
  /** Where the chosen model is saved; the Ask AI panel reads the same key. */
  storageKey: string;
  load: () => Promise<{ models?: OpenRouterModel[]; error?: string }>;
  validId: (id: string) => boolean;
  idExample: string;
}

/** Searches the provider's models, or takes a typed model ID. Shared by OpenRouter and custom endpoints. */
export function ModelPicker({ storageKey, load, validId, idExample }: PickerProps) {
  const [model, setModel] = useState(() => readSetting(storageKey) ?? "");
  const [editing, setEditing] = useState(!model);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!editing) return;
    let current = true;
    setLoading(true);
    setError("");
    load().then(result => {
      if (!current) return;
      setModels(result.models ?? []);
      setError(result.error ?? "");
    }).catch(() => { if (current) setError("Couldn't load models. You can enter a model ID."); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [load, editing]);
  const select = (id: string) => {
    saveAiPreference(storageKey, id);
    setModel(id); setEditing(false); setQuery("");
  };
  const typed = query.trim();
  const matches = models.filter(m => (m.name + " " + m.id).toLowerCase().includes(typed.toLowerCase()));
  const custom = validId(typed) && !models.some(m => m.id === typed);
  if (!editing) return <div className="settings-row"><div className="settings-label"><span>Model</span><small>{model}</small></div>
    <button className="btn ghost" onClick={() => setEditing(true)}>Change model</button></div>;
  return <div className="router-model-picker">
    <label htmlFor="router-model">Model</label>
    <input id="router-model" type="search" placeholder="Search models or enter an ID" maxLength={256} value={query}
      onChange={event => setQuery(event.target.value)} />
    <div className="router-models" aria-label="Available models">
      {matches.map(m => <button key={m.id} onClick={() => select(m.id)}>
        <span>{m.name}<small>{m.id}</small></span>
        {m.contextLength && <small title="Context window in tokens">{m.contextLength.toLocaleString()} tokens</small>}
      </button>)}
      {custom && <button onClick={() => select(typed)}>Use {typed}</button>}
    </div>
    {loading && <small role="status">Loading models…</small>}
    {!loading && !error && !matches.length && !custom && <small>No matching models. You can enter an ID such as {idExample}.</small>}
    {error && <small role="status">{error}</small>}
    {model && <button className="link small" onClick={() => { setEditing(false); setQuery(""); }}>Cancel</button>}
  </div>;
}

export function OpenRouterSettings({ ai, configured, onConfigured }: { ai: FolioAi; configured: boolean; onConfigured: (configured: boolean) => void }) {
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
      const result = await ai.openRouterKey(action, value);
      if (!result.ok) { setError(result.error || "Couldn't update the OpenRouter key."); return; }
      onConfigured(!!result.configured);
      setEditing(false);
      setNotice(action === "check" ? "Connection verified." : "");
      if (action !== "check") saveAiPreference("folio:ai-key-revision", crypto.randomUUID());
    } catch { setError("Couldn't update the OpenRouter key. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="router-settings">
    <p className="settings-hint">OpenRouter bills your account. When you ask, OpenRouter and the provider serving your model receive the text you ask about and the conversation.</p>
    {configured && !editing ? <div className="settings-row">
      <div className="settings-label"><span>API key</span><small>Stored securely on this device.</small></div>
      <button className="link small" disabled={busy} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>Manage key</button>
      <button className="btn ghost" disabled={busy} onClick={() => void act("check")}>{busy ? "Checking…" : "Check connection"}</button>
    </div> : <form className="router-key" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label htmlFor="router-key">{configured ? "Replacement API key" : "API key"}</label>
      <div><input ref={key} id="router-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} required
        placeholder="Paste your OpenRouter key" disabled={busy} />
        <button className="btn primary" disabled={busy}>{busy ? "Checking…" : "Verify and save"}</button></div>
      {configured && <div className="router-key-actions">
        <button type="button" className="link small" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
        <button type="button" className="link small" disabled={busy} onClick={() => void act("remove")}>Remove saved key</button>
      </div>}
    </form>}
    {notice && <p role="status" className="settings-hint">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {configured && <ModelPicker storageKey="folio:ai-model:openrouter" load={ai.openRouterModels} validId={id => ROUTER_ID.test(id)} idExample="provider/model" />}
  </div>;
}
