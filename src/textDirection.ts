// Other RTL scripts stay protected until the editor can shape and round-trip them.
const RIGHT_TO_LEFT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;
export const RIGHT_TO_LEFT_MESSAGE = "Folio can't edit right-to-left text in this script yet.";
export function hasRightToLeft(text: string) { return RIGHT_TO_LEFT.test(text); }
export function isArabicText(text: string) { return /\p{Script_Extensions=Arabic}/u.test(text); }
export function unsupportedDirection(text: string) {
  return hasRightToLeft(text) && Array.from(text).some(ch => RIGHT_TO_LEFT.test(ch) && !/\p{Script_Extensions=Arabic}/u.test(ch));
}
