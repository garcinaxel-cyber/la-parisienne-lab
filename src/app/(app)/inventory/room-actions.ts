'use server';
// Room counts — admin check list in the Inventory tab (Axel, 2026-10-20: "la check list admin doit être
// dans l'onglet inventaire"). Read only. Admin / lab manager.
import { rawService, rawActor } from '@/lib/raw-materials-db';
import { lineTotal, unitAlert, type LeftOutReason, type RoomEntry } from '@/lib/room-count';

export type AdminRoomLine = {
  tmplId: number; sku: string | null; name: string; nameVi: string | null; uom: string; source: string;
  total: number | null; zero: boolean; entries: { by: string | null; qty: number; isZero: boolean; pack: string | null; at: string }[];
  takenRecent: number | null; reason: LeftOutReason | null; note: string | null; reasonBy: string | null; unitAlert: boolean;
};
export type AdminRoomSession = {
  id: string; team: string; countDate: string; cutoffAt: string; status: string;
  openedBy: string | null; confirmedBy: string | null; confirmedAt: string | null;
  counted: number; zero: number; leftOut: number; noReason: number; multi: number; alerts: number;
  lines: AdminRoomLine[];
};

export async function getRoomCountsAdminAction(days = 60): Promise<{ sessions?: AdminRoomSession[]; error?: string }> {
  const a = await rawActor();
  if (!a || !['admin', 'lab_manager'].includes(a.role)) return { error: 'Admin only' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: ss, error } = await db.from('lab_room_count_sessions').select('*').neq('status', 'cancelled').gte('count_date', since)
    .order('count_date', { ascending: false }).order('created_at', { ascending: false }).limit(60);
  if (error) return { error: error.message };
  const ids = (ss ?? []).map(s => s.id);
  if (!ids.length) return { sessions: [] };
  const [{ data: ls }, { data: es }] = await Promise.all([
    db.from('lab_room_count_lines').select('*').in('session_id', ids).limit(20000),
    db.from('lab_room_count_entries').select('*').in('session_id', ids).is('deleted_at', null).order('created_at').limit(20000),
  ]);
  return {
    sessions: (ss ?? []).map(s => {
      const ents: RoomEntry[] = (es ?? []).filter(e => e.session_id === s.id).map(e => ({ id: e.id, tmplId: e.tmpl_id, qty: Number(e.qty), isZero: !!e.is_zero,
        packLabel: e.pack_label ?? null, packCount: e.pack_count == null ? null : Number(e.pack_count), countedBy: e.counted_by, countedByName: e.counted_by_name,
        createdAt: e.created_at, updatedAt: e.updated_at }));
      const lines: AdminRoomLine[] = (ls ?? []).filter(l => l.session_id === s.id).map(l => {
        const t = lineTotal(ents, l.tmpl_id);
        const mine = ents.filter(e => e.tmplId === l.tmpl_id);
        const taken = l.taken_recent == null ? null : Number(l.taken_recent);
        return { tmplId: l.tmpl_id, sku: l.sku, name: l.name, nameVi: l.name_vi, uom: l.uom, source: l.source,
          total: t ? t.total : null, zero: !!t?.zero, takenRecent: taken,
          entries: mine.map(e => ({ by: e.countedByName, qty: e.qty, isZero: e.isZero, pack: e.packLabel ? `${e.packCount} × ${e.packLabel}` : null, at: e.createdAt })),
          reason: l.left_out_reason ?? null, note: l.left_out_note ?? null, reasonBy: l.left_out_by_name ?? null,
          unitAlert: !!t && unitAlert(t.total, taken) };
      });
      return {
        id: s.id, team: s.team, countDate: s.count_date, cutoffAt: s.cutoff_at, status: s.status,
        openedBy: s.opened_by_name, confirmedBy: s.confirmed_by_name, confirmedAt: s.confirmed_at,
        counted: lines.filter(l => l.total != null && !l.zero).length, zero: lines.filter(l => l.zero).length,
        leftOut: lines.filter(l => l.total == null).length, noReason: lines.filter(l => l.total == null && !l.reason).length,
        multi: lines.filter(l => l.entries.length > 1).length, alerts: lines.filter(l => l.unitAlert).length, lines,
      };
    }),
  };
}
