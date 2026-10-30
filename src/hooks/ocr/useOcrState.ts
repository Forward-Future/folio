import { useSyncExternalStore } from "react";
import type { OcrSession } from "../../lib/ocr/session/OcrSession";
import type { OcrState } from "../../lib/ocr/types";

const IDLE: OcrState = { phase: "idle", done: 0, total: 0 };
const never = () => () => {};

export function useOcrState(session: OcrSession | null): OcrState {
  return useSyncExternalStore(session?.subscribe ?? never, () => session?.state ?? IDLE);
}
