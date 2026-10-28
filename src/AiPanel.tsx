import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import type { PDFDocumentProxy } from "./pdf";
import { getAiHistory, saveAiHistory } from "./recent";

export interface AiContext {
  text: string;
  page: number;
}

type Provider = "chatgpt" | "claude";

interface Message extends AiMessage {
  context?: AiContext;
  error?: { message: string; code?: string; link?: string };
}

const USAGE_URL = "https://chatgpt.com/settings/usage";
const CLAUDE_CODE_URL = "https://claude.com/claude-code";
const MAX_DOC_CHARS = 400_000;
const CLAUDE_MODELS = [
  { id: "", name: "Default model" },
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

// ── Document text ───────────────────────────────────────────────────────────────────────
const textCache = new WeakMap<PDFDocumentProxy, Promise<{ text: string; truncated: boolean }>>();

function documentText(pdf: PDFDocumentProxy) {
  let cached = textCache.get(pdf);
  if (!cached) {
    cached = (async () => {
      let text = "";
      let truncated = false;
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        const page = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("")
          .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        const block = `[Page ${n}]\n${page}\n\n`;
        if (text.length + block.length > MAX_DOC_CHARS) {
          truncated = true;
          break;
        }
        text += block;
      }
      return { text, truncated };
    })();
    textCache.set(pdf, cached);
  }
  return cached;
}

function instructions(name: string, doc: { text: string; truncated: boolean }) {
  const hasText = doc.text.replace(/\[Page \d+\]/g, "").trim().length > 0;
  return [
    `You are the reading assistant in Folio, a PDF reader. The user is reading "${name}".`,
    hasText
      ? `Its extracted text is below between <document> tags, with [Page N] markers.${doc.truncated ? " The document is long, so only the beginning is included; say so if a question may depend on later pages." : ""}`
      : "This PDF has no extractable text (it may be scanned images), so you can only answer from the passages the user quotes.",
    "Guidelines:",
    "- Answer from the document. If it doesn't contain the answer, say so plainly; you may add general knowledge if it helps, clearly labeled as such.",
    "- Cite page numbers like (p. 12) when you use specific information from the document.",
    "- When the user quotes a passage, focus on that passage and use the rest of the document as context.",
    "- Be concise. Use short paragraphs, and bullet lists where they help. Use only light Markdown: **bold**, lists, and `code`.",
    "",
    hasText ? `<document>\n${doc.text}</document>` : "",
  ].join("\n");
}

// ── Light Markdown rendering (no HTML is ever injected) ──────────────────────────────────
function inline(text: string, onPage: (n: number) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\((?:p|pp|page|pages)\.?\s*(\d+)(?:[–-]\d+)?\))/gi;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) out.push(<strong key={out.length}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={out.length}>{token.slice(1, -1)}</code>);
    else {
      const n = Number(match[2]);
      out.push(<button key={out.length} className="page-ref" onClick={() => onPage(n)} title={`Go to page ${n}`}>{token}</button>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text, onPage }: { text: string; onPage: (n: number) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i])) items.push(lines[i++].replace(bullet, ""));
      const List = ordered ? "ol" : "ul";
      blocks.push(<List key={blocks.length}>{items.map((item, k) => <li key={k}>{inline(item, onPage)}</li>)}</List>);
      continue;
    }
    const heading = /^#{1,4}\s+(.*)/.exec(line);
    if (heading) { blocks.push(<p key={blocks.length}><strong>{inline(heading[1], onPage)}</strong></p>); i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={blocks.length}>{para.map((p, k) => <Fragment key={k}>{k > 0 && <br />}{inline(p, onPage)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────
const conversations = new Map<string, Message[]>();

interface Props {
  pdf: PDFDocumentProxy;
  docId: string;
  /** Save the conversation with the document (off for password-protected documents). */
  persist: boolean;
  docName: string;
  context: AiContext | null;
  onClearContext: () => void;
  onGoToPage: (n: number) => void;
  onClose: () => void;
}

export function AiPanel({ pdf, docId, persist, docName, context, onClearContext, onGoToPage, onClose }: Props) {
  const ai = window.folioDesktop?.ai;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [provider, setProviderState] = useState<Provider>(() => (localStorage.getItem("folio:ai-provider") as Provider) || "chatgpt");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [model, setModelState] = useState(() => localStorage.getItem(`folio:ai-model:${provider}`) ?? "");
  const [messages, setMessages] = useState<Message[]>(() => conversations.get(docId) ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The panel is mounted per document (keyed by docId in App), so this conversation always belongs to docId.
  const [loaded, setLoaded] = useState(() => conversations.has(docId) || !persist);
  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    void getAiHistory(docId).then((saved) => {
      if (cancelled) return;
      if (saved.length) setMessages(saved);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [docId, loaded]);
  useEffect(() => {
    if (!loaded) return;
    conversations.set(docId, messages);
    // Save once an answer has finished (not on every streamed word); failed answers aren't kept.
    if (persist && !busy) {
      void saveAiHistory(docId, messages.filter((m) => !m.error && m.content).map(({ role, content, context }) => ({ role, content, ...(context ? { context } : {}) })));
    }
  }, [docId, messages, busy, loaded, persist]);
  useEffect(() => { void ai?.status().then(setStatus); }, [ai]);
  useEffect(() => { if (context) inputRef.current?.focus(); }, [context]);

  const setProvider = (next: Provider) => {
    setProviderState(next);
    localStorage.setItem("folio:ai-provider", next);
    setModelState(localStorage.getItem(`folio:ai-model:${next}`) ?? "");
    setSetupError(null);
  };
  const setModel = (id: string) => {
    setModelState(id);
    localStorage.setItem(`folio:ai-model:${provider}`, id);
  };

  // ChatGPT's model list depends on the signed-in account.
  const chatgptConnected = !!status?.chatgpt.connected;
  useEffect(() => {
    if (!ai || provider !== "chatgpt" || !chatgptConnected) return;
    void ai.chatgptModels().then((result) => {
      if (!result.ok) {
        if (result.code === "signed_out") void ai.status().then(setStatus);
        setSetupError(result.error ?? null);
        return;
      }
      const list = result.models ?? [];
      setModels(list);
      setModelState((current) => (list.some((m) => m.id === current) ? current : list[0]?.id ?? ""));
    });
  }, [ai, provider, chatgptConnected]);

  // Stream answers into the last assistant message.
  useEffect(() => {
    if (!ai) return;
    return ai.onEvent((event) => {
      if (event.id !== busyRef.current) return;
      setMessages((list) => {
        const next = list.slice();
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return list;
        if (event.type === "delta") next[next.length - 1] = { ...last, content: last.content + (event.text ?? "") };
        if (event.type === "error") next[next.length - 1] = { ...last, error: { message: event.message ?? "Something went wrong.", code: event.code, link: event.link } };
        return next;
      });
      if (event.type !== "delta") {
        busyRef.current = null;
        setBusy(null);
        if (event.code === "signed_out") void ai.status().then(setStatus);
      }
    });
  }, [ai]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const ready = provider === "chatgpt" ? chatgptConnected : !!status?.claude.installed && status.claude.loggedIn;

  const send = useCallback(async (question: string) => {
    if (!ai || !question.trim() || busyRef.current || !ready) return;
    const doc = await documentText(pdf);
    const userContent = context
      ? `About this passage from page ${context.page}:\n"""\n${context.text}\n"""\n\n${question.trim()}`
      : question.trim();
    const history: Message[] = [...messages.filter((m) => !m.error && m.content), { role: "user", content: userContent }];
    const id = crypto.randomUUID();
    busyRef.current = id;
    setBusy(id);
    setMessages([...messages, { role: "user", content: question.trim(), context: context ?? undefined }, { role: "assistant", content: "" }]);
    setInput("");
    onClearContext();
    try {
      await ai.ask({ id, provider, model, instructions: instructions(docName, doc), messages: history.map(({ role, content }) => ({ role, content })) });
    } catch {
      busyRef.current = null;
      setBusy(null);
      setMessages((list) => {
        const next = list.slice();
        next[next.length - 1] = { role: "assistant", content: "", error: { message: "Folio couldn't send that question." } };
        return next;
      });
    }
  }, [ai, pdf, context, messages, provider, model, docName, onClearContext, ready]);

  const signIn = async () => {
    if (!ai) return;
    setSigningIn(true);
    setSetupError(null);
    const result = await ai.signInChatGPT();
    setSigningIn(false);
    if (!result.ok) setSetupError(result.error ?? "ChatGPT sign-in failed.");
    setStatus(await ai.status());
  };

  const placeholder = !ready ? "Connect an AI provider to ask questions"
    : context ? "Ask about the selected passage…" : "Ask about this document…";

  return (
    <aside className="ai-panel" aria-label="Ask AI">
      <header className="ai-head">
        <div className="ai-title"><Icon name="sparkle" size={16} /> Ask AI</div>
        <div className="segmented small" role="tablist" aria-label="AI provider">
          <button role="tab" aria-selected={provider === "chatgpt"} className={provider === "chatgpt" ? "on" : ""} onClick={() => setProvider("chatgpt")}>ChatGPT</button>
          <button role="tab" aria-selected={provider === "claude"} className={provider === "claude" ? "on" : ""} onClick={() => setProvider("claude")}>Claude</button>
        </div>
        <div className="ai-head-actions">
          <button className="pill-btn" title="New conversation" aria-label="New conversation" disabled={!messages.length || !!busy} onClick={() => setMessages([])}>
            <Icon name="plus" size={15} />
          </button>
          <button className="pill-btn" title="Close" aria-label="Close Ask AI" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      <div className="ai-body" ref={listRef}>
        {!ai ? (
          <div className="ai-card"><p>Ask AI is available in the Folio desktop app.</p></div>
        ) : !status ? (
          <p className="ai-checking">Checking connections…</p>
        ) : provider === "chatgpt" && !chatgptConnected ? (
          <div className="ai-card">
            <h3>Use your ChatGPT plan</h3>
            <p>Sign in with ChatGPT to ask questions using your existing ChatGPT plan (Go, Plus, or Pro). No API key needed.</p>
            <button className="btn primary chatgpt-btn" onClick={signIn} disabled={signingIn}>
              {signingIn ? "Waiting for your browser…" : "Continue with ChatGPT"}
            </button>
            {signingIn && <p className="fine">Finish signing in in your browser, then come back here.</p>}
            <p className="fine">When you ask, Folio sends your question and the document's text to OpenAI. Nothing is sent otherwise.</p>
          </div>
        ) : provider === "claude" && !(status.claude.installed && status.claude.loggedIn) ? (
          <div className="ai-card">
            <h3>Use your Claude subscription</h3>
            {!status.claude.installed ? (
              <p>Folio uses Claude Code, Anthropic's official app, signed in with your own Claude Pro or Max account. Install Claude Code, sign in once, then check again.</p>
            ) : (
              <p>Claude Code is installed but not signed in. Open a terminal, run <code>claude</code>, and sign in with your Claude account.</p>
            )}
            <div className="ai-card-actions">
              {!status.claude.installed && <a className="btn ghost" href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">Get Claude Code</a>}
              <button className="btn primary" onClick={async () => setStatus({ ...status, claude: await ai.recheckClaude() })}>Check again</button>
            </div>
            <p className="fine">Folio never sees your Claude password or tokens. When you ask, it sends your question and the document's text to Anthropic through Claude Code.</p>
          </div>
        ) : (
          <>
            {provider === "chatgpt" && !status.chatgpt.welcomeSeen && (
              <div className="ai-card welcome">
                <p><strong>You're connected{status.chatgpt.email ? ` as ${status.chatgpt.email}` : ""}.</strong> Questions you ask in Folio use your ChatGPT plan. You can manage usage in ChatGPT settings.</p>
                <div className="ai-card-actions">
                  <a className="btn ghost" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                  <button className="btn primary" onClick={async () => { await ai.chatgptWelcomeSeen(); setStatus(await ai.status()); }}>Got it</button>
                </div>
              </div>
            )}
            {messages.length === 0 && (
              <div className="ai-empty">
                <p>Ask anything about <strong>{docName.replace(/\.pdf$/i, "")}</strong>, or select text in the document and choose <em>Ask AI</em>.</p>
                <div className="suggestions">
                  {(context ? ["Explain this in simple terms", "Why does this matter?", "Summarize this passage"]
                    : ["Summarize this document", "What are the key takeaways?", "What questions does this leave open?"]).map((q) => (
                    <button key={q} className="suggestion" onClick={() => void send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "user" ? (
                  <>
                    {m.context && <blockquote>p. {m.context.page}: {m.context.text.length > 220 ? m.context.text.slice(0, 220) + "…" : m.context.text}</blockquote>}
                    <p>{m.content}</p>
                  </>
                ) : m.error ? (
                  <div className="msg-error">
                    <p>{m.error.message}</p>
                    {m.error.code === "usage_limit" && provider === "chatgpt" && (
                      <a className="btn primary" href={m.error.link || USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                    )}
                    {m.error.code === "signed_out" && provider === "chatgpt" && (
                      <button className="btn primary" onClick={signIn}>Continue with ChatGPT</button>
                    )}
                  </div>
                ) : m.content ? (
                  <Markdown text={m.content} onPage={onGoToPage} />
                ) : (
                  <div className="typing" aria-label="Thinking"><span /><span /><span /></div>
                )}
              </div>
            ))}
          </>
        )}
        {setupError && <div className="msg-error"><p>{setupError}</p></div>}
      </div>

      <footer className="ai-foot">
        {context && (
          <div className="context-chip">
            <span>p. {context.page}: “{context.text.length > 90 ? context.text.slice(0, 90) + "…" : context.text}”</span>
            <button onClick={onClearContext} aria-label="Ask about the whole document instead" title="Ask about the whole document instead">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            disabled={!ready}
            placeholder={placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button type="button" className="send-btn" onClick={() => void ai?.cancel(busy)} title="Stop" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!ready || !input.trim()} title="Send (Enter)" aria-label="Send">
              <Icon name="send" size={16} />
            </button>
          )}
        </form>
        {ready && (
          <div className="ai-meta">
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              {(provider === "chatgpt" ? models : CLAUDE_MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {provider === "chatgpt" ? (
              <span>Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></span>
            ) : (
              <span>{status?.claude.subscription ? "Using your Claude subscription via Claude Code" : "Using Claude Code"}</span>
            )}
          </div>
        )}
      </footer>
    </aside>
  );
}
