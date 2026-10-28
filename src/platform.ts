// Which operating system Folio is running on, and shortcut labels written its way.
const platform =
  window.folioDesktop?.platform ??
  (/Mac|iPhone|iPad/.test(navigator.platform) ? "darwin" : /Linux/.test(navigator.platform) ? "linux" : "win32");

export const IS_MAC = platform === "darwin";

/** Writes a shortcut the way this platform does: "Ctrl S" stays on Windows/Linux, becomes "⌘ S" on macOS. */
export function keys(label: string) {
  return IS_MAC ? label.replace(/Ctrl\+/g, "⌘").replace(/Ctrl/g, "⌘").replace(/Shift/g, "⇧") : label;
}
