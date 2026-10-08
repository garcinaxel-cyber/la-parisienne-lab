'use server';
// Raw materials — chef side (Axel, 2026-10-08). Phase 1: storage withdrawals and purchase requests
// are recorded in the app only; nothing goes to Odoo. Test phase: team Hưng only (see RAW_TEAMS).
import { rawService, rawActor, canActForTeam, canApproveForTeam, teamLeads, mapMaterial, loadLines, loadWithdrawals, type RawActor } from '@/lib/raw-materials-db';
import { sendUsersPush, awaitPush } from '@/lib/push-notify';
import type { RawMaterial, PurchaseLine, Withdrawal } from '@/lib/raw-materials';
import { labDayUtcRange, vnTodayStr } from '@/lib/odoo';

export async function getRawCatalogForChefAction(): Promise<{ items?: RawMaterial[]; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const { data, error } = await db.from('lab_raw_materials').select('*').eq('active', true).eq('visible', true).order('name').limit(2000);
  if (error) return { error: error.message };
  return { items: (data ?? []).map(mapMaterial) };
}

export type WithdrawalInput = { tmplId: number; qty: number; packLabel?: string | null; packCount?: number | null };

export async function recordWithdrawalAction(team: string, takenBy: string, lines: WithdrawalInput[]): Promise<{ ok?: boolean; no?: number; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const clean = (lines ?? []).map(l => ({ ...l, qty: Math.round(Number(l.qty) * 1000) / 1000 })).filter(l => l.tmplId && l.qty > 0).slice(0, 80);
  if (!clean.length) return { error: 'Empty' };
  // Names and units are re-read server-side, never trusted from the phone.
  const { data: mats } = await db.from('lab_raw_materials').select('tmpl_id, sku, name, uom').in('tmpl_id', clean.map(l => l.tmplId));
  const byId = new Map((mats ?? []).map(m => [m.tmpl_id, m]));
  if (clean.some(l => !byId.has(l.tmplId))) return { error: 'Unknown raw material' };
  const { data: w, error } = await db.from('lab_raw_withdrawals')
    .insert({ team, taken_by: String(takenBy ?? '').trim().slice(0, 80) || a.name || null, created_by: a.userId }).select('id, no').single();
  if (error || !w) return { error: error?.message ?? 'Insert failed' };
  const rows = clean.map(l => {
    const m = byId.get(l.tmplId)!;
    return { withdrawal_id: w.id, tmpl_id: l.tmplId, sku: m.sku, name: m.name, uom: m.uom, qty: l.qty,
      pack_label: l.packLabel ? String(l.packLabel).slice(0, 40) : null, pack_count: l.packCount ?? null };
  });
  const { error: lErr } = await db.from('lab_raw_withdrawal_lines').insert(rows);
  if (lErr) { await db.from('lab_raw_withdrawals').delete().eq('id', w.id); return { error: lErr.message }; }
  return { ok: true, no: Number(w.no) };
}

export async function getTeamWithdrawalsTodayAction(team: string): Promise<{ items?: Withdrawal[]; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const { start, end } = labDayUtcRange(vnTodayStr());
  try {
    const items = await loadWithdrawals(db, q => q.eq('team', team).gte('created_at', start).lt('created_at', end).order('created_at', { ascending: false }));
    return { items };
  } catch (e: any) { return { error: e.message }; }
}

export type RequestLineInput = { tmplId: number; qty: number; brand?: string | null; brandStrict?: boolean; note?: string | null };
export type NewProductInput = { name: string; qty: number; uom: string; note?: string | null; photoUrl?: string | null };

// A member's request waits for the team lead when the team has one; the lead's own requests and
// admin / lab manager ones go straight to purchasing.
function needsApproval(a: RawActor, team: string, leads: { id: string }[]): boolean {
  if (!leads.length || a.role === 'admin' || a.role === 'lab_manager') return false;
  return !leads.some(l => l.id === a.userId);
}

export async function submitPurchaseRequestAction(team: string, requestedBy: string, lines: RequestLineInput[], newItems: NewProductInput[] = []): Promise<{ ok?: boolean; no?: number; needsApproval?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const clean = (lines ?? []).filter(l => l.tmplId && Number(l.qty) > 0).slice(0, 80);
  const news = (newItems ?? []).filter(n => String(n.name ?? '').trim() && Number(n.qty) > 0).slice(0, 10);
  if (!clean.length && !news.length) return { error: 'Empty' };
  const { data: mats } = clean.length
    ? await db.from('lab_raw_materials').select('tmpl_id, sku, name, uom, vendor_id, vendor_name').in('tmpl_id', clean.map(l => l.tmplId))
    : { data: [] as any[] };
  const byId = new Map((mats ?? []).map((m: any) => [m.tmpl_id, m]));
  if (clean.some(l => !byId.has(l.tmplId))) return { error: 'Unknown raw material' };
  const leads = await teamLeads(db, team);
  const wait = needsApproval(a, team, leads);
  const status = wait ? 'to_approve' : 'pending';
  const { data: r, error } = await db.from('lab_purchase_requests')
    .insert({ team, requested_by: String(requestedBy ?? '').trim().slice(0, 80) || a.name || null, created_by: a.userId }).select('id, no').single();
  if (error || !r) return { error: error?.message ?? 'Insert failed' };
  const txt = (v: unknown, n: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, n) : null; };
  const rows = [
    ...clean.map(l => {
      const m: any = byId.get(l.tmplId);
      return { request_id: r.id, tmpl_id: l.tmplId, sku: m.sku, name: m.name, uom: m.uom, qty: Math.round(Number(l.qty) * 1000) / 1000,
        brand: txt(l.brand, 80), brand_strict: !!l.brandStrict && !!txt(l.brand, 80), note: txt(l.note, 300),
        vendor_id: m.vendor_id ?? null, vendor_name: m.vendor_name ?? null, status };
    }),
    ...news.map(n => ({ request_id: r.id, tmpl_id: null, sku: null, name: txt(n.name, 120)!, uom: ['kg', 'L', 'Unit'].includes(n.uom) ? n.uom : 'kg',
      qty: Math.round(Number(n.qty) * 1000) / 1000, note: txt(n.note, 300), is_new: true, new_state: 'open',
      photo_url: typeof n.photoUrl === 'string' && n.photoUrl.startsWith('https://') ? n.photoUrl : null, status })),
  ];
  const { error: lErr } = await db.from('lab_purchase_request_lines').insert(rows);
  if (lErr) { await db.from('lab_purchase_requests').delete().eq('id', r.id); return { error: lErr.message }; }
  if (wait) {
    const who = String(requestedBy ?? '').trim() || a.name || '';
    await awaitPush(sendUsersPush(db, leads.map(l => l.id),
      { title: 'La Parisienne Lab', body: `🛒 Yêu cầu mua #${r.no} chờ bạn duyệt · ${who} · ${rows.length} dòng`, url: `/station/${team}`, tag: 'raw-approve' },
      { title: 'La Parisienne Lab', body: `🛒 Purchase request #${r.no} waits for your approval · ${who} · ${rows.length} lines`, url: `/station/${team}`, tag: 'raw-approve' }));
  }
  return { ok: true, no: Number(r.no), needsApproval: wait };
}

// The chef's own team's requests, newest first, over the last `days` days.
export type TeamRequestsMeta = { canApprove: boolean; needsApproval: boolean; leadName: string | null };
export async function getTeamRequestsAction(team: string, days = 30): Promise<{ items?: PurchaseLine[]; meta?: TeamRequestsMeta; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const leads = await teamLeads(db, team);
  const meta: TeamRequestsMeta = { canApprove: leads.length > 0 && canApproveForTeam(a, team), needsApproval: needsApproval(a, team, leads), leadName: leads[0]?.name || null };
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 400) * 86400000).toISOString();
  const { data: reqs } = await db.from('lab_purchase_requests').select('id').eq('team', team).gte('created_at', since).limit(2000);
  const ids = (reqs ?? []).map(r => r.id);
  if (!ids.length) return { items: [], meta };
  try {
    const items = await loadLines(db, q => q.in('request_id', ids).order('created_at', { ascending: false }));
    return { items, meta };
  } catch (e: any) { return { error: e.message }; }
}

// Lines of `team` with the given ids (team checked through the request, never trusted from the phone).
async function teamLines(db: NonNullable<ReturnType<typeof rawService>>, team: string, ids: string[]) {
  const { data } = await db.from('lab_purchase_request_lines').select('id, request_id, qty, status, approved_at, requested_qty, rejected_by_lead').in('id', ids.slice(0, 100));
  const reqIds = Array.from(new Set((data ?? []).map(l => l.request_id)));
  const { data: reqs } = reqIds.length ? await db.from('lab_purchase_requests').select('id, team').in('id', reqIds) : { data: [] as any[] };
  const ok = new Set((reqs ?? []).filter((r: any) => r.team === team).map((r: any) => r.id));
  return (data ?? []).filter(l => ok.has(l.request_id));
}

// The team lead approves (with optional quantity changes) and/or turns down lines waiting for him.
// Approved lines become 'pending', i.e. they appear in the purchasing queue.
export async function decideRequestLinesAction(team: string, approve: { id: string; qty: number }[], reject: string[], reason?: string | null): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canApproveForTeam(a, team)) return { error: L_FORBIDDEN };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const lines = await teamLines(db, team, [...(approve ?? []).map(x => x.id), ...(reject ?? [])]);
  const byId = new Map(lines.filter(l => l.status === 'to_approve').map(l => [l.id, l]));
  const now = new Date().toISOString();
  for (const x of approve ?? []) {
    const l = byId.get(x.id); if (!l) continue;
    const q = Math.round(Number(x.qty) * 1000) / 1000;
    if (!(q > 0)) return { error: 'Invalid quantity' };
    const changed = q !== Number(l.qty);
    const { error } = await db.from('lab_purchase_request_lines').update({
      status: 'pending', approved_at: now, approved_by_name: a.name || null, qty: q,
      ...(changed ? { requested_qty: l.requested_qty ?? l.qty } : {}),
    }).eq('id', l.id).eq('status', 'to_approve');
    if (error) return { error: error.message };
  }
  const rej = (reject ?? []).filter(id => byId.has(id));
  if (rej.length) {
    const why = String(reason ?? '').trim().slice(0, 200) || null;
    const { error } = await db.from('lab_purchase_request_lines').update({
      status: 'cancelled', cancelled_at: now, cancelled_by_name: a.name || null, rejected_by_lead: true, reject_reason: why,
    }).in('id', rej).eq('status', 'to_approve');
    if (error) return { error: error.message };
  }
  return { ok: true };
}

// Undo a wrong tap by the lead: a line he turned down, or approved but not yet ordered, goes back to
// "waiting for approval" (original quantity restored).
export async function reopenForApprovalAction(team: string, lineId: string): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canApproveForTeam(a, team)) return { error: L_FORBIDDEN };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const [l] = await teamLines(db, team, [lineId]);
  if (!l) return { error: 'Not found' };
  const patch = l.status === 'cancelled' && l.rejected_by_lead
    ? { status: 'to_approve', cancelled_at: null, cancelled_by_name: null, rejected_by_lead: false, reject_reason: null }
    : l.status === 'pending' && l.approved_at
    ? { status: 'to_approve', approved_at: null, approved_by_name: null, ...(l.requested_qty != null ? { qty: l.requested_qty, requested_qty: null } : {}) }
    : null;
  if (!patch) return { error: 'Đã đặt hàng rồi — không thể hoàn tác.' };
  const { error } = await db.from('lab_purchase_request_lines').update(patch).eq('id', l.id).eq('status', l.status);
  if (error) return { error: error.message };
  return { ok: true };
}

const L_FORBIDDEN = 'Chỉ trưởng nhóm mới duyệt được.';

export async function uploadRawPhotoAction(formData: FormData): Promise<{ url?: string; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images are allowed' };
  if (file.size > 5 * 1024 * 1024) return { error: 'Image too large — max 5MB' };
  const path = `raw-requests/${vnTodayStr()}/${crypto.randomUUID()}.jpg`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error } = await db.storage.from('lab-design-photos').upload(path, buf, { contentType: file.type, upsert: false });
  if (error) return { error: error.message };
  return { url: db.storage.from('lab-design-photos').getPublicUrl(path).data.publicUrl };
}
