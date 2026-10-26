import { useEffect, useState } from "react";
import { listRecent, removeRecent, type RecentFile } from "./recent";
import { Icon } from "./icons";
import { formatBytes } from "./Dialogs";

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Props {
  onPick: () => void;
  onOpenBytes: (name: string, data: Uint8Array) => void;
  onSample: () => void;
  loading: boolean;
}

export function Welcome({ onPick, onOpenBytes, onSample, loading }: Props) {
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.folioDesktop?.getVersion().then(setVersion);
  }, []);

  useEffect(() => {
    listRecent().then(setRecent);
  }, []);

  const reopen = async (f: RecentFile) => onOpenBytes(f.name, new Uint8Array(await f.data.arrayBuffer()));

  const forget = async (id: string) => {
    await removeRecent(id);
    setRecent((r) => r.filter((f) => f.id !== id));
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="hero">
          <h1>Read beautifully.</h1>
          <p>A calm, fast PDF reader. Your files never leave this device.</p>
        </div>

        <button className="dropzone" onClick={onPick} disabled={loading}>
          <div className="dropzone-icon">
            <Icon name={loading ? "file" : "upload"} size={26} />
          </div>
          <div className="dropzone-text">
            <strong>{loading ? "Opening…" : "Open a PDF"}</strong>
            <span>Drop a file anywhere, or click to browse</span>
          </div>
          <kbd>Ctrl O</kbd>
        </button>

        <div className="welcome-links">
          <button className="link" onClick={onSample}>
            <Icon name="book" size={15} /> Try a sample document
          </button>
        </div>

        {recent.length > 0 && (
          <section className="recent">
            <h3>Recent</h3>
            <div className="recent-grid">
              {recent.map((f) => (
                <div key={f.id} className="recent-card" onClick={() => reopen(f)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && reopen(f)}>
                  <div className="recent-thumb">
                    {f.thumb ? <img src={f.thumb} alt="" /> : <Icon name="file" size={28} />}
                    {f.lastPage > 1 && (
                      <span className="recent-progress" style={{ width: `${(f.lastPage / f.pages) * 100}%` }} />
                    )}
                  </div>
                  <div className="recent-meta">
                    <strong title={f.name}>{f.name.replace(/\.pdf$/i, "")}</strong>
                    <span>
                      {timeAgo(f.openedAt)} · {f.pages} {f.pages === 1 ? "page" : "pages"} · {formatBytes(f.size)}
                    </span>
                  </div>
                  <button
                    className="recent-remove"
                    title="Remove from recent"
                    onClick={(e) => {
                      e.stopPropagation();
                      forget(f.id);
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {version && <p className="version">Folio {version}</p>}
      </div>
    </div>
  );
}
