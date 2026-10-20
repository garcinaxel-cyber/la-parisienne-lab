// Room count (Axel, 2026-10-20) — inventory of each team's room. Client-safe types and constants,
// shared by the station panel, its server actions and the admin check list (Inventory tab).
// Phase 1: app only. Phase 2 (once the withdrawals move stock into the rooms in Odoo): one grouped
// Odoo adjustment per session on the room's location below.

// Odoo stock.location of each room (created 2026-10-19, siblings of LAB/Stock under the LAB view).
export const ROOM_LOCATIONS: Record<string, number> = { hung: 219, baby_mama: 220, entremet: 221, baker: 222 };

export type LeftOutReason = 'not_used' | 'other_room' | 'no_time' | 'other';
export const LEFT_OUT_REASONS: Record<LeftOutReason, { vi: string; en: string }> = {
  not_used: { vi: 'Không còn dùng', en: 'No longer used' },
  other_room: { vi: 'Để ở room khác', en: 'Kept in another room' },
  no_time: { vi: 'Chưa kịp đếm', en: 'No time to count' },
  other: { vi: 'Khác', en: 'Other' },
};

export type RoomEntry = {
  id: string; tmplId: number; qty: number; isZero: boolean;
  packLabel: string | null; packCount: number | null;
  countedBy: string | null; countedByName: string | null; createdAt: string; updatedAt: string;
};
export type RoomLine = {
  tmplId: number; sku: string | null; name: string; nameVi: string | null; uom: string;
  type: string | null; sub: string | null; source: 'taken' | 'recipe' | 'added';
  takenRecent: number | null;
  leftOutReason: LeftOutReason | null; leftOutNote: string | null;
};
export type RoomSession = {
  id: string; team: string; countDate: string; cutoffAt: string; status: 'open' | 'confirmed' | 'cancelled';
  openedByName: string | null; confirmedByName: string | null; confirmedAt: string | null;
};
export type RoomCountState = {
  session: RoomSession | null;
  lines: RoomLine[];
  entries: RoomEntry[];
  canConfirm: boolean;          // team lead of this team (or admin)
  meId: string;
};

// Total of one product from its live entries; null when nobody counted it yet.
export function lineTotal(entries: RoomEntry[], tmplId: number): { total: number; n: number; zero: boolean } | null {
  const es = entries.filter(e => e.tmplId === tmplId);
  if (!es.length) return null;
  return { total: Math.round(es.reduce((s, e) => s + e.qty, 0) * 1000) / 1000, n: es.length, zero: es.every(e => e.isZero) };
}

// Unit check (Axel: "faudra faire attention aux unités de mesure"): flag a total far above what the
// team took recently — the typical slip is a count typed in pieces / grams instead of kg.
export function unitAlert(total: number, takenRecent: number | null): boolean {
  if (!(total > 0) || takenRecent == null || !(takenRecent > 0)) return false;
  return total > takenRecent * 1.5 + 0.5;
}
