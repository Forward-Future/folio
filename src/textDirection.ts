// Edit mode writes text through PDFium one character at a time, left to right. It has no bidirectional
// reordering or Arabic shaping, so right-to-left text can't be edited without scrambling it.
// Hebrew through Arabic Extended-A, the Hebrew and Arabic presentation forms, and the right-to-left
// blocks outside the Basic Multilingual Plane. The third range stops just before the byte-order mark.
const RIGHT_TO_LEFT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

export const RIGHT_TO_LEFT_MESSAGE = "Folio can't edit right-to-left text, such as Arabic or Hebrew, yet.";

export function hasRightToLeft(text: string) {
  return RIGHT_TO_LEFT.test(text);
}
