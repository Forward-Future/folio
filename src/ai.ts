// Shared by the Ask AI panel and Settings: the providers' pages, and the ChatGPT sign-in flow.
export type AiProvider = "chatgpt" | "claude";

export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const CLAUDE_CODE_URL = "https://claude.com/claude-code";

/** Runs the ChatGPT sign-in (it opens the browser); resolves once it's over with the refreshed status. */
export async function signInChatGPT(ai: FolioAi): Promise<{ status: AiStatus; error: string | null }> {
  const result = await ai.signInChatGPT();
  return { status: await ai.status(), error: result.ok ? null : result.error ?? "ChatGPT sign-in failed." };
}
