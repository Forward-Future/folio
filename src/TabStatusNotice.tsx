import { useSyncExternalStore } from "react";
import type { DocumentTabs } from "./documentTabs";
import { Icon } from "./icons";

export function TabStatusNotice({ tabs, tabKey }: { tabs: DocumentTabs; tabKey: number }) {
  useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  if (tabs.active !== tabKey || !tabs.cleanupError) return null;
  return <div className="tab-status-notice" role="status">
    <span>{tabs.cleanupError}</span>
    <button className="icon-btn" aria-label="Dismiss tab status" onClick={() => tabs.dismissCleanupError()}>
      <Icon name="close" size={16} />
    </button>
  </div>;
}
