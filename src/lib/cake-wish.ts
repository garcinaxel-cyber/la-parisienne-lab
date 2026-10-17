// Birthday-cake message ("lời chúc trên bánh") typed by the shop in its order form (Axel,
// 2026-10-17: shops wrote the message in the line note, so the station card said "Thiếu lời chúc"
// while the message sat in the note under the customer). Pure helpers, no imports.
//
// It travels inside the existing line note (Odoo REP line note / SO line description) so nothing
// changes in Odoo's structure: "🎂 <message>" first, then " | <kitchen note>" if any.
// In a saved DRAFT only, a birthday line always carries the 🎂 prefix so the form remembers it:
// "🎂 -" = "no message" ticked, "🎂 ?" = not decided yet.
export const WISH_MARK = '🎂';
export const BIRTHDAY_CATEGORY = 'Birthday cake';
/** Categories whose order line gets the message field (same gate as the assistants' cake message). */
export const WISH_CATEGORIES = ['Birthday cake', 'Bento cake'];

export type WishParts = { isBirthday: boolean; wish: string; noWish: boolean; note: string };

export function parseWishNote(raw: string | null | undefined): WishParts {
  const s = (raw ?? '').trim();
  if (!s.startsWith(WISH_MARK)) return { isBirthday: false, wish: '', noWish: false, note: s };
  const body = s.slice(WISH_MARK.length).trim();
  const i = body.indexOf(' | ');
  const head = (i >= 0 ? body.slice(0, i) : body).trim();
  const note = (i >= 0 ? body.slice(i + 3) : '').trim();
  return { isBirthday: true, wish: head === '-' || head === '?' ? '' : head, noWish: head === '-', note };
}

/** Note sent to Odoo: the message only when there is one; "no message" sends just the note. */
export function composeOrderNote(l: { wish?: string; note?: string }): string {
  const wish = (l.wish ?? '').trim(), note = (l.note ?? '').trim();
  return wish ? `${WISH_MARK} ${wish}${note ? ` | ${note}` : ''}` : note;
}

/** Note kept in a draft: birthday lines always keep the prefix so the choice survives a reload. */
export function composeDraftNote(l: { isBirthday?: boolean; wish?: string; noWish?: boolean; note?: string }): string {
  if (!l.isBirthday) return (l.note ?? '').trim();
  const wish = (l.wish ?? '').trim(), note = (l.note ?? '').trim();
  const head = wish || (l.noWish ? '-' : '?');
  return `${WISH_MARK} ${head}${note ? ` | ${note}` : ''}`;
}
