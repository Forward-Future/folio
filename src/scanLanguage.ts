import catalog from "../electron/ocr-models.json";

export type ScanLanguage = keyof typeof catalog.languages;
export const SCAN_LANGUAGES = (Object.keys(catalog.languages) as ScanLanguage[]).map(id => ({
  id, ...catalog.languages[id],
}));

export function scanLanguagesFrom(value: string | null): ScanLanguage[] {
  const languages = (value ?? "").split("+").filter((id): id is ScanLanguage => Object.hasOwn(catalog.languages, id));
  return languages.length ? [...new Set(languages)] : ["eng"];
}
