// Preferences are kept in localStorage, which can throw: site data blocked in the browser edition, or no room
// left. A preference then reads as unset, or isn't remembered, instead of taking the reader down with it.

export function readSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Returns whether the value was saved. */
export function writeSetting(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
