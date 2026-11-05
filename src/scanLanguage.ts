export const SCAN_LANGUAGES = [
  { id: "eng", name: "English" },
  { id: "deu", name: "German" },
  { id: "eng+deu", name: "Both" },
] as const;

export type ScanLanguage = typeof SCAN_LANGUAGES[number]["id"];

export function scanLanguageFrom(value: string | null): ScanLanguage {
  return SCAN_LANGUAGES.find(language => language.id === value)?.id ?? "eng";
}
