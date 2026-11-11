// Shared by the Ask AI panel and Settings: the providers' pages, and the ChatGPT sign-in flow.
import { readSetting, writeSetting } from "./preferences";

export const PROVIDERS = { chatgpt: "ChatGPT", claude: "Claude", openrouter: "OpenRouter", custom: "Custom endpoint" } as const;
export type AiProvider = keyof typeof PROVIDERS;

export function savedProvider(): AiProvider {
  const saved = readSetting("folio:ai-provider");
  return saved && Object.hasOwn(PROVIDERS, saved) ? saved as AiProvider : "chatgpt";
}

// Storage events reach the other document tabs. The local event updates the panel beside Settings.
export const AI_PREFERENCES = "folio:ai-preferences";
export function subscribeAiPreferences(listener: () => void) {
  const sync = (event: StorageEvent) => { if (!event.key || event.key.startsWith("folio:ai-")) listener(); };
  window.addEventListener("storage", sync);
  window.addEventListener(AI_PREFERENCES, listener);
  return () => {
    window.removeEventListener("storage", sync);
    window.removeEventListener(AI_PREFERENCES, listener);
  };
}
export function saveAiPreference(name: string, value: string) {
  writeSetting(name, value);
  window.dispatchEvent(new Event(AI_PREFERENCES));
}

export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const CLAUDE_CODE_URL = "https://claude.com/claude-code";

/** Runs the ChatGPT sign-in (it opens the browser); resolves once it's over with the refreshed status. */
export async function signInChatGPT(ai: FolioAi): Promise<{ status: AiStatus; error: string | null }> {
  const result = await ai.signInChatGPT();
  return { status: await ai.status(), error: result.ok ? null : result.error ?? "ChatGPT sign-in failed." };
}
