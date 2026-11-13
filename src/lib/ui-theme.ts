// Staff colour themes (Axel, 2026-11-13) — each person picks one on their own phone (Menu › Colours).
// Stored in this browser only (localStorage), never in the database. 'ivoire' = default = no class.
// The re-skin is a generated stylesheet (public/ui-themes/<id>.css, scripts/gen-ui-themes.py), loaded
// only on phones that picked a theme; alert colours never change.
export type UiThemeId = 'ivoire' | 'caramel' | 'pistache' | 'bleu';

export const UI_THEMES: { id: UiThemeId; vi: string; en: string; swatch: [string, string, string] }[] = [
  { id: 'ivoire', vi: 'Ngà & cacao', en: 'Ivoire & cacao', swatch: ['#F6F1EA', '#2A1810', '#C9A84C'] },
  { id: 'caramel', vi: 'Caramel', en: 'Caramel', swatch: ['#F7F0E9', '#2D1C0D', '#CD7C3E'] },
  { id: 'pistache', vi: 'Pistachio', en: 'Pistache', swatch: ['#EFF5EB', '#1B2911', '#83A75E'] },
  { id: 'bleu', vi: 'Xanh dương', en: 'Bleu', swatch: ['#E9F0F7', '#0E1C2C', '#4A7FAD'] },
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
  let link = document.getElementById('lp-ui-theme-css') as HTMLLinkElement | null;
  if (id === 'ivoire') { link?.remove(); }
  else {
    if (!link) { link = document.createElement('link'); link.id = 'lp-ui-theme-css'; link.rel = 'stylesheet'; document.head.appendChild(link); }
    if (link.getAttribute('href') !== `/ui-themes/${id}.css`) link.href = `/ui-themes/${id}.css`;
    el.classList.add(`lp-theme-${id}`);
  }
  if (save) { try { localStorage.setItem(KEY, id); } catch { /* private mode: theme just won't persist */ } }
}
