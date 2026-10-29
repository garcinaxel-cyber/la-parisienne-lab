'use server';
// Room count — chef side (Axel, 2026-10-20). See lib/room-count.ts and supabase/lab_v128_room_counts.sql.
// Phase 1: app only, nothing is written to Odoo.
import { applyRoomCountToOdoo, roomsLinkedForDay } from '@/lib/rooms-odoo';
import { rawService, rawActor, canActForTeam, canApproveForTeam } from '@/lib/raw-materials-db';
import { resolveRawMaterialsBatch } from '@/lib/mp-consumption';
import { isOemSku } from '@/lib/oem';
import { vnTodayStr } from '@/lib/odoo';
import { ROOM_LOCATIONS, LEFT_OUT_REASONS, type RoomCountState, type RoomEntry, type RoomLine, type LeftOutReason } from '@/lib/room-count';
import { TRANSFER_TEAMS } from '@/lib/raw-materials';

type Db = NonNullable<ReturnType<typeof rawService>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTeam = (t: string) => (TRANSFER_TEAMS as readonly string[]).includes(t);

const mapEntry = (e: any): RoomEntry => ({
  id: e.id, tmplId: e.tmpl_id, qty: Number(e.qty), isZero: !!e.is_zero,
  packLabel: e.pack_label ?? null, packCount: e.pack_count == null ? null : Number(e.pack_count),
  countedBy: e.counted_by ?? null, countedByName: e.counted_by_name ?? null, createdAt: e.created_at, updatedAt: e.updated_at,
});
const mapLine = (l: any): RoomLine => ({
  tmplId: l.tmpl_id, sku: l.sku ?? null, name: l.name, nameVi: l.name_vi ?? null, uom: l.uom, type: l.type ?? null, sub: l.sub ?? null,
  source: l.source, takenRecent: l.taken_recent == null ? null : Number(l.taken_recent),
  leftOutReason: l.left_out_reason ?? null, leftOutNote: l.left_out_note ?? null,
});

async function openSession(db: Db, team: string) {
  const { data } = await db.from('lab_room_count_sessions').select('*').eq('team', team).eq('status', 'open').maybeSingle();
  return data as any | null;
}

// What a team holds from the storage over a period, per raw material (base unit): its takes plus the
// transfers it received, minus what it gave to another team or back to storage. Refused slips count nothing.
async function teamNetTaken(db: Db, team: string, sinceIso: string, untilIso: string): Promise<Map<number, number>> {
  const t = /^[a-z_]+$/.test(team) ? team : '__none__';
  const { data: ws } = await db.from('lab_raw_withdrawals').select('id, team, kind, from_team, to_team, status, refused_at')
    .or(`team.eq.${t},from_team.eq.${t},to_team.eq.${t}`).gte('created_at', sinceIso).lt('created_at', untilIso).limit(5000);
  const sign = new Map<string, number>();
  for (const w of ws ?? []) {
    if (w.refused_at) continue;
    if (w.kind === 'transfer') {
      if (w.status !== 'confirmed') continue;
      if (w.to_team === team) sign.set(w.id, 1); else if (w.from_team === team) sign.set(w.id, -1);
    } else if (w.team === team) sign.set(w.id, 1);
  }
  const out = new Map<number, number>();
  const ids = Array.from(sign.keys());
  for (let i = 0; i < ids.length; i += 200) {
    const { data: ls } = await db.from('lab_raw_withdrawal_lines').select('withdrawal_id, tmpl_id, qty, corrected_qty').in('withdrawal_id', ids.slice(i, i + 200));
    for (const l of ls ?? []) {
      if (l.tmpl_id == null) continue;
      out.set(l.tmpl_id, (out.get(l.tmpl_id) ?? 0) + (sign.get(l.withdrawal_id) ?? 0) * Number(l.corrected_qty ?? l.qty));
    }
  }
  return out;
}

async function loadState(db: Db, team: string, a: { userId: string }, canConfirm: boolean): Promise<RoomCountState> {
  const s = await openSession(db, team);
  if (!s) return { session: null, lines: [], entries: [], canConfirm, meId: a.userId };
  const [{ data: ls }, { data: es }] = await Promise.all([
    db.from('lab_room_count_lines').select('*').eq('session_id', s.id).limit(3000),
    db.from('lab_room_count_entries').select('*').eq('session_id', s.id).is('deleted_at', null).order('created_at').limit(5000),
  ]);
  return {
    session: { id: s.id, team: s.team, countDate: s.count_date, cutoffAt: s.cutoff_at, status: s.status, openedByName: s.opened_by_name, confirmedByName: s.confirmed_by_name, confirmedAt: s.confirmed_at },
    lines: (ls ?? []).map(mapLine), entries: (es ?? []).map(mapEntry), canConfirm, meId: a.userId,
  };
}

export async function getRoomCountAction(team: string): Promise<{ state?: RoomCountState; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  return { state: await loadState(db, team, a, canApproveForTeam(a, team)) };
}

// Opens the room's count: freezes the cut-off now and builds the list to count (raw materials the team
// took in the last 60 days + those in the recipes it produced in the last 60 days). Any team member can
// open it; a second opener simply joins the open session (one open count per room, unique index).
export async function openRoomCountAction(team: string): Promise<{ state?: RoomCountState; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const canConfirm = canApproveForTeam(a, team);
  if (await openSession(db, team)) return { state: await loadState(db, team, a, canConfirm) };

  const now = new Date();
  const { data: s, error } = await db.from('lab_room_count_sessions').insert({
    team, room_location_id: ROOM_LOCATIONS[team] ?? null, count_date: vnTodayStr(), cutoff_at: now.toISOString(),
    opened_by: a.userId, opened_by_name: a.name || null,
  }).select('id').single();
  if (error || !s) {
    // lost the race against a teammate: join theirs
    if (await openSession(db, team)) return { state: await loadState(db, team, a, canConfirm) };
    return { error: error?.message ?? 'Insert failed' };
  }

  const day = 24 * 3600 * 1000;
  const taken60 = await teamNetTaken(db, team, new Date(now.getTime() - 60 * day).toISOString(), now.toISOString());
  const taken14 = await teamNetTaken(db, team, new Date(now.getTime() - 14 * day).toISOString(), now.toISOString());
  const ids = new Map<number, 'taken' | 'recipe'>();
  for (const [id, q] of Array.from(taken60.entries())) if (q !== 0) ids.set(id, 'taken');

  // Recipes: the team's production of the last 60 days, exploded down to raw materials (best effort —
  // the list still opens on the taken items if Odoo is slow).
  try {
    const since = new Date(now.getTime() - 60 * day).toISOString().slice(0, 10);
    const skus = new Set<string>();
    for (let off = 0; ; off += 1000) {
      const { data: st } = await db.from('lab_daily_stats').select('sku').eq('team', team).gte('day', since).gt('qty_produced', 0).range(off, off + 999);
      for (const r of st ?? []) if (r.sku && !isOemSku(r.sku)) skus.add(r.sku);
      if (!st || st.length < 1000) break;
    }
    if (team === 'hung') {
      const { data: oem } = await db.from('lab_mm_packaging_log').select('sku').eq('kind', 'packed').gte('pack_date', since).limit(2000);
      for (const r of oem ?? []) if (r.sku) skus.add(r.sku);
    }
    if (skus.size) {
      const { bySku } = await resolveRawMaterialsBatch(Array.from(skus));
      const codes = new Set<string>();
      for (const ls of Array.from(bySku.values())) for (const l of ls ?? []) if (l.code) codes.add(l.code);
      const codeList = Array.from(codes);
      for (let i = 0; i < codeList.length; i += 200) {
        const { data: ms } = await db.from('lab_raw_materials').select('tmpl_id').in('sku', codeList.slice(i, i + 200)).eq('active', true);
        for (const m of ms ?? []) if (!ids.has(m.tmpl_id)) ids.set(m.tmpl_id, 'recipe');
      }
    }
  } catch (e) { console.error('[room-count] recipe list failed', team, String((e as any)?.message ?? e)); }

  const idList = Array.from(ids.keys());
  const rows: any[] = [];
  for (let i = 0; i < idList.length; i += 200) {
    const { data: ms } = await db.from('lab_raw_materials').select('tmpl_id, sku, name, name_vi, uom, type, sub').in('tmpl_id', idList.slice(i, i + 200));
    for (const m of ms ?? []) rows.push({
      session_id: s.id, tmpl_id: m.tmpl_id, sku: m.sku, name: m.name, name_vi: m.name_vi ?? null, uom: m.uom, type: m.type, sub: m.sub,
      source: ids.get(m.tmpl_id), taken_recent: Math.round((taken14.get(m.tmpl_id) ?? 0) * 1000) / 1000,
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error: lErr } = await db.from('lab_room_count_lines').insert(rows.slice(i, i + 500));
    if (lErr) { await db.from('lab_room_count_sessions').delete().eq('id', s.id); return { error: lErr.message }; }
  }
  return { state: await loadState(db, team, a, canConfirm) };
}

export type EntryInput = {
  id: string; tmplId: number; qty: number; isZero?: boolean; packLabel?: string | null; packCount?: number | null;
  mode?: 'add' | 'correct';   // correct = replace MY latest entry on this product
  force?: boolean;            // saved anyway after the "duplicate?" question
};
export type SaveResult = { ok?: boolean; duplicate?: boolean; error?: string; state?: RoomCountState };

export async function saveRoomEntryAction(team: string, sessionId: string, input: EntryInput): Promise<SaveResult> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const { data: s } = await db.from('lab_room_count_sessions').select('id, team, status').eq('id', sessionId).maybeSingle();
  if (!s || s.team !== team) return { error: 'Not found' };
  if (s.status !== 'open') return { error: 'Phiên kiểm kê đã đóng / This count is closed' };
  if (!UUID.test(String(input.id ?? ''))) return { error: 'Bad id' };
  const isZero = !!input.isZero;
  const qty = isZero ? 0 : Math.round(Number(input.qty) * 1000) / 1000;
  if (!isZero && !(qty > 0)) return { error: 'Số lượng phải > 0 / Quantity must be > 0' };
  const canConfirm = canApproveForTeam(a, team);

  // Same id already saved (double tap, resend after a network cut): never a second row.
  const { data: same } = await db.from('lab_room_count_entries').select('id, counted_by').eq('id', input.id).maybeSingle();
  if (same) return { ok: true, state: await loadState(db, team, a, canConfirm) };

  // The product must be known; added to the list when counted from "other product".
  const { data: line } = await db.from('lab_room_count_lines').select('tmpl_id').eq('session_id', sessionId).eq('tmpl_id', input.tmplId).maybeSingle();
  if (!line) {
    const { data: m } = await db.from('lab_raw_materials').select('tmpl_id, sku, name, name_vi, uom, type, sub').eq('tmpl_id', input.tmplId).maybeSingle();
    if (!m) return { error: 'Unknown raw material' };
    await db.from('lab_room_count_lines').upsert({ session_id: sessionId, tmpl_id: m.tmpl_id, sku: m.sku, name: m.name, name_vi: m.name_vi ?? null,
      uom: m.uom, type: m.type, sub: m.sub, source: 'added' }, { onConflict: 'session_id,tmpl_id', ignoreDuplicates: true });
  }
  const vals = { qty, is_zero: isZero, pack_label: input.packLabel ? String(input.packLabel).slice(0, 40) : null,
    pack_count: input.packCount == null ? null : Number(input.packCount) };

  if (input.mode === 'correct') {
    const { data: mine } = await db.from('lab_room_count_entries').select('id').eq('session_id', sessionId).eq('tmpl_id', input.tmplId)
      .eq('counted_by', a.userId).is('deleted_at', null).order('created_at', { ascending: false }).limit(1);
    if (mine?.length) {
      const { error } = await db.from('lab_room_count_entries').update({ ...vals, updated_at: new Date().toISOString() }).eq('id', mine[0].id);
      if (error) return { error: error.message };
      return { ok: true, state: await loadState(db, team, a, canConfirm) };
    }
  }

  // Same person, same product, same quantity within 2 minutes: ask before saving (Axel: "j'ai peur des doublons").
  if (!input.force) {
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recent } = await db.from('lab_room_count_entries').select('id').eq('session_id', sessionId).eq('tmpl_id', input.tmplId)
      .eq('counted_by', a.userId).eq('qty', qty).eq('is_zero', isZero).is('deleted_at', null).gte('created_at', since).limit(1);
    if (recent?.length) return { duplicate: true };
  }

  const { error } = await db.from('lab_room_count_entries').insert({ id: input.id, session_id: sessionId, tmpl_id: input.tmplId, ...vals,
    counted_by: a.userId, counted_by_name: a.name || null });
  if (error && !/duplicate key/i.test(error.message)) return { error: error.message };
  // a counted product no longer needs a "left out" reason
  await db.from('lab_room_count_lines').update({ left_out_reason: null, left_out_note: null, left_out_by_name: null }).eq('session_id', sessionId).eq('tmpl_id', input.tmplId);
  return { ok: true, state: await loadState(db, team, a, canConfirm) };
}

// Delete an entry: your own, or any entry for the team lead (duplicate clean-up from the summary).
export async function deleteRoomEntryAction(team: string, sessionId: string, entryId: string): Promise<SaveResult> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const canConfirm = canApproveForTeam(a, team);
  const { data: s } = await db.from('lab_room_count_sessions').select('team, status').eq('id', sessionId).maybeSingle();
  if (!s || s.team !== team) return { error: 'Not found' };
  if (s.status !== 'open') return { error: 'Phiên kiểm kê đã đóng / This count is closed' };
  const { data: e } = await db.from('lab_room_count_entries').select('id, counted_by, session_id').eq('id', entryId).maybeSingle();
  if (!e || e.session_id !== sessionId) return { error: 'Not found' };
  if (e.counted_by !== a.userId && !canConfirm) return { error: 'Chỉ xoá được lượt của bạn / You can only delete your own entries' };
  const { error } = await db.from('lab_room_count_entries').update({ deleted_at: new Date().toISOString(), deleted_by_name: a.name || null }).eq('id', entryId);
  if (error) return { error: error.message };
  return { ok: true, state: await loadState(db, team, a, canConfirm) };
}

// Why a listed product was not counted (team lead, summary screen). null clears it.
export async function setLeftOutReasonAction(team: string, sessionId: string, tmplId: number, reason: LeftOutReason | null, note?: string | null): Promise<SaveResult> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canActForTeam(a, team)) return { error: 'Forbidden' };
  if (reason != null && !(reason in LEFT_OUT_REASONS)) return { error: 'Bad reason' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const { data: s } = await db.from('lab_room_count_sessions').select('team, status').eq('id', sessionId).maybeSingle();
  if (!s || s.team !== team || s.status !== 'open') return { error: 'Not found' };
  const { error } = await db.from('lab_room_count_lines').update({ left_out_reason: reason, left_out_note: String(note ?? '').trim().slice(0, 200) || null,
    left_out_by_name: reason ? a.name || null : null }).eq('session_id', sessionId).eq('tmpl_id', tmplId);
  if (error) return { error: error.message };
  return { ok: true, state: await loadState(db, team, a, canApproveForTeam(a, team)) };
}

// Team lead confirms the count. Every listed product is either counted (a quantity or "= 0") or has a reason.
export async function confirmRoomCountAction(team: string, sessionId: string): Promise<SaveResult> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!isTeam(team) || !canApproveForTeam(a, team)) return { error: 'Chỉ trưởng nhóm xác nhận / Only the team lead confirms' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const st = await loadState(db, team, a, true);
  if (!st.session || st.session.id !== sessionId) return { error: 'Not found' };
  const counted = new Set(st.entries.map(e => e.tmplId));
  const missing = st.lines.filter(l => !counted.has(l.tmplId) && !l.leftOutReason);
  if (missing.length) return { error: `Còn ${missing.length} nguyên liệu chưa đếm và chưa có lý do / ${missing.length} items neither counted nor explained` };
  const { error } = await db.from('lab_room_count_sessions').update({ status: 'confirmed', confirmed_by: a.userId, confirmed_by_name: a.name || null,
    confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', sessionId).eq('status', 'open');
  if (error) return { error: error.message };
  // Rooms linked to Odoo (2026-10-29): the confirmed count is applied to the room right away.
  // Best-effort: a failure is saved on the session and retried by the 15-min cron.
  if (roomsLinkedForDay(st.session.countDate)) { try { await applyRoomCountToOdoo(db, sessionId); } catch { /* retried by cron */ } }
  return { ok: true, state: await loadState(db, team, a, true) };
}
