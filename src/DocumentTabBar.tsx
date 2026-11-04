import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ReaderContext } from "./documentTabs";
import { Icon } from "./icons";
import { keys } from "./platform";

export function DocumentTabBar({ tabs, tabKey }: { tabs: ReaderContext["tabs"]; tabKey: number }) {
  useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  const selected = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = strip.current;
    return () => {
      if (tabs.active !== tabKey || !element?.contains(document.activeElement)) return;
      // When the last background tab closes, the strip and its focused Close
      // button disappear. Keep subsequent shortcuts in this reader's window.
      const reader = element.parentElement;
      if (reader) {
        if (!reader.hasAttribute("tabindex")) reader.tabIndex = -1;
        reader.focus({ preventScroll: true });
      }
    };
  }, [tabs, tabKey]);
  useLayoutEffect(() => {
    if (tabs.active === tabKey) {
      selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (tabs.keyboardFocus === tabKey) selected.current?.focus({ preventScroll: true });
    }
  }, [tabs.active, tabs.keyboardFocus, tabKey]);
  return <nav ref={strip} className="document-tabs" aria-label="Documents">
    <div className="document-tab-list" role="tablist" aria-label="Open documents">
      {tabs.all.map(tab => {
        const active = tab.key === tabKey;
        const name = tab.name || "Library";
        const waiting = tab.passwordPending || tab.attachmentStatus?.state === "password";
        const description = tab.kind === "attachment" ? `${name}, attachment, read only${waiting ? ", waiting for password" : ""}` : name + (waiting ? ", waiting for password" : "");
        return <div key={tab.key} className={active ? "document-tab selected" : "document-tab"}>
          <button type="button" role="tab" aria-selected={active} aria-controls={active ? "reader-panel" : undefined}
            id={active ? "selected-document-tab" : undefined} tabIndex={active ? 0 : -1}
            ref={active ? selected : undefined} title={description} aria-label={description} onClick={event => tabs.select(tab.key, event.detail === 0)}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              if (event.key === "Home" || event.key === "End") tabs.select(tabs.all[event.key === "Home" ? 0 : tabs.all.length - 1].key, true);
              else tabs.cycle(event.key === "ArrowRight" ? 1 : -1);
            }}>
            <Icon name={tab.name ? "file" : "book"} size={14} /><span>{name}</span>{(tab.kind === "attachment" || waiting) && <span className="attachment-tab-label">{waiting ? "Password" : "Read only"}</span>}
          </button>
          <button className="close-document-tab" title={tab.dirty ? "Unsaved changes · Close tab" : "Close tab"}
            aria-label={`Close ${name}${tab.dirty ? ", unsaved changes" : ""}`} onClick={() => void tabs.close(tab.key)}>
            {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}<Icon name="close" size={13} />
          </button>
        </div>;
      })}
    </div>
    <button className="new-document-tab icon-btn" title={keys("New tab (Ctrl+T)")} aria-label="New tab" onClick={() => tabs.library()}>
      <Icon name="plus" size={16} />
    </button>
  </nav>;
}
