// Staff colour themes (Axel, 2026-11-13) — each person picks one on their own phone (Menu › Colours).
// Stored in this browser only (localStorage), never in the database. 'ivoire' = default = no class.
// The re-skin itself is CSS (globals.css, html.lp-theme-*); alert colours never change.
export type UiThemeId = 'ivoire' | 'caramel' | 'pistache' | 'bleu';

export const UI_THEMES: { id: UiThemeId; vi: string; en: string; swatch: [string, string, string] }[] = [
  { id: 'ivoire', vi: 'Ngà & cacao', en: 'Ivoire & cacao', swatch: ['#F6F1EA', '#2A1810', '#C9A84C'] },
  { id: 'caramel', vi: 'Caramel', en: 'Caramel', swatch: ['#F4ECE2', '#8A4F2A', '#B9784A'] },
  { id: 'pistache', vi: 'Pistachio', en: 'Pistache', swatch: ['#EEF1E8', '#3E5530', '#7E9A5B'] },
  { id: 'bleu', vi: 'Xanh dương', en: 'Bleu', swatch: ['#EEF3F8', '#1F4E79', '#3E7CB1'] },
];

const KEY = 'lp-ui-theme';

export function readUiTheme(): UiThemeId {
  try {
    const v = localStorage.getItem(KEY);
    return UI_THEMES.some(t => t.id === v) ? (v as UiThemeId) : 'ivoire';
  } catch { return 'ivoire'; }
}

export function applyUiTheme(id: UiThemeId, save = false) {
  const el = document.documentElement;
  Array.from(el.classList).filter(c => c.startsWith('lp-theme-')).forEach(c => el.classList.remove(c));
  if (id !== 'ivoire') el.classList.add(`lp-theme-${id}`);
  if (save) { try { localStorage.setItem(KEY, id); } catch { /* private mode: theme just won't persist */ } }
}
