import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

const PRESETS: { value: string; label: string; icon?: IconName }[] = [
  { value: "auto", label: "Automatic" },
  { value: "page-width", label: "Fit width", icon: "fitWidth" },
  { value: "page-fit", label: "Fit page", icon: "fitPage" },
];
const LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function ZoomMenu({
  scale,
  onPick,
  spread,
  onToggleSpread,
}: {
  scale: number;
  onPick: (value: string) => void;
  spread: boolean;
  onToggleSpread: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const pick = (v: string) => {
    onPick(v);
    setOpen(false);
  };

  return (
    <div className="zoom" ref={ref}>
      <button className="zoom-value" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Zoom">
        {Math.round(scale * 100)}%
      </button>
      {open && (
        <div className="menu" role="menu">
          {PRESETS.map((p) => (
            <button key={p.value} role="menuitem" onClick={() => pick(p.value)}>
              {p.icon ? <Icon name={p.icon} size={15} /> : <span className="menu-spacer" />}
              {p.label}
            </button>
          ))}
          <hr />
          <button
            role="menuitemcheckbox"
            aria-checked={spread}
            className={spread ? "on" : ""}
            onClick={() => {
              onToggleSpread();
              setOpen(false);
            }}
          >
            <Icon name="book" size={15} />
            Two-page view
            <kbd className="menu-kbd">2</kbd>
          </button>
          <hr />
          {LEVELS.map((l) => (
            <button key={l} role="menuitem" className={Math.abs(scale - l) < 0.005 ? "on" : ""} onClick={() => pick(String(l))}>
              <span className="menu-spacer" />
              {l * 100}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
