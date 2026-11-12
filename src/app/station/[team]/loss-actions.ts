'use server';
// Chef losses (Axel, 2026-11-12) — pilot Team Hung. Anyone in the team declares; the team lead
// validates and the loss goes to Odoo (lib/chef-losses.ts). Not validated by the end of the lab
// day → pushed anyway by the nightly cron. Chefs never see values in VND.
import { waitUntil } from '@vercel/functions';
import { rawService, rawActor, canActForTeam, canApproveForTeam, teamLeads } from '@/lib/raw-materials-db';
import { mapLoss, pushChefLoss } from '@/lib/chef-losses';
import { CHEF_RD_TEAMS, REASONS_FINISHED, REASONS_STOCK, type ChefLoss, type LossKind } from '@/lib/chef-rd';
import { vnTodayStr } from '@/lib/odoo';

export type LossItem = { kind: 'fin' | 'raw' | 'pack'; key: string; sku: string | null; tmplId: number | null; productId: number | null; name: string; nameVi: string | null; uom: string; photo: string | null; rank: number; category: string | null };
export type LossMonth = {
  month: string; day: number;
  finPcs: number; finPrevPcs: number; produced: number;
  rawKg: number; rawReports: number; testTrials: number;
  reasons: { reason: string; n: number }[];
  top: { name: string; sku: string | null; n: number; produced: number; mainReason: string | null }[];
};
export type LossData = {
  today: string; me: string; canValidate: boolean; leads: string[];
  items: LossItem[]; losses: ChefLoss[]; month: LossMonth;
};

function guard(team: string) { return CHEF_RD_TEAMS.includes(team); }

export async function getLossDataAction(team: string): Promise<{ data?: LossData; error?: string }> {
  if (!guard(team)) return { error: 'Not available for this team yet' };
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const today = vnTodayStr();
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const prevMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const day = Number(today.slice(8, 10));
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();

  const [fichesQ, rawQ, lossesQ, histQ, wdQ, madeQ, leads] = await Promise.all([
    db.from('lab_fiche_meta').select('id, name_en, name_vi, category, image_url, lab_fiche_variants(sku, label, image_url, is_active)')
      .contains('teams', [team]).eq('is_active', true).limit(500),
    db.from('lab_raw_materials').select('tmpl_id, product_id, sku, name, name_vi, uom, kind').eq('active', true).eq('visible', true).limit(3000),
    db.from('lab_chef_losses').select('*').eq('team', team).neq('status', 'deleted')
      .or(`lab_day.eq.${today},status.eq.pending`).order('declared_at', { ascending: false }).limit(300),
    db.from('lab_chef_losses').select('kind, sku, tmpl_id, product_name, qty, reason_tag_name, lab_day, trial_id')
      .eq('team', team).neq('status', 'deleted').gte('lab_day', `${prevMonth}-01`).limit(5000),
    db.from('lab_raw_withdrawal_lines').select('tmpl_id, lab_raw_withdrawals!inner(team, created_at)')
      .eq('lab_raw_withdrawals.team', team).gte('lab_raw_withdrawals.created_at', since30).limit(3000),
    db.from('lab_analytics_daily').select('sku, made, day').eq('team', team).gte('day', `${prevMonth}-01`).limit(10000),
    teamLeads(db, team),
  ]);

  // Ranking: what the team loses most, then what it uses / makes most.
  const lossCount = new Map<string, number>();
  for (const h of histQ.data ?? []) {
    const k = h.kind === 'fin' ? `fin:${h.sku}` : `tmpl:${h.tmpl_id}`;
    lossCount.set(k, (lossCount.get(k) ?? 0) + 1);
  }
  const useCount = new Map<number, number>();
  for (const w of wdQ.data ?? []) if (w.tmpl_id) useCount.set(Number(w.tmpl_id), (useCount.get(Number(w.tmpl_id)) ?? 0) + 1);
  const madeBySku = new Map<string, number>();
  const madeMonthBySku = new Map<string, number>();
  let produced = 0;
  for (const r of madeQ.data ?? []) {
    madeBySku.set(r.sku, (madeBySku.get(r.sku) ?? 0) + Number(r.made || 0));
    if (String(r.day).startsWith(month)) { produced += Number(r.made || 0); madeMonthBySku.set(r.sku, (madeMonthBySku.get(r.sku) ?? 0) + Number(r.made || 0)); }
  }

  const items: LossItem[] = [];
  for (const f of fichesQ.data ?? []) {
    for (const v of (f as any).lab_fiche_variants ?? []) {
      if (!v.sku || v.is_active === false) continue;
      const label = v.label && !/^default$/i.test(v.label) ? ` · ${v.label}` : '';
      items.push({
        kind: 'fin', key: `fin:${v.sku}`, sku: v.sku, tmplId: null, productId: null,
        name: `${f.name_en || f.name_vi}${label}`, nameVi: f.name_vi ? `${f.name_vi}${label}` : null, uom: 'pcs',
        photo: v.image_url || f.image_url || null, category: f.category ?? null,
        rank: (lossCount.get(`fin:${v.sku}`) ?? 0) * 1000 + (madeBySku.get(v.sku) ?? 0),
      });
    }
  }
  for (const r of rawQ.data ?? []) {
    if (!r.product_id || r.kind === 'tools') continue;
    items.push({
      kind: r.kind === 'packaging' ? 'pack' : 'raw', key: `tmpl:${r.tmpl_id}`, sku: r.sku ?? null, tmplId: r.tmpl_id, productId: r.product_id,
      name: r.name, nameVi: r.name_vi ?? null, uom: r.uom || 'kg', photo: null, category: null,
      rank: (lossCount.get(`tmpl:${r.tmpl_id}`) ?? 0) * 1000 + (useCount.get(Number(r.tmpl_id)) ?? 0),
    });
  }
  items.sort((x, y) => y.rank - x.rank || x.name.localeCompare(y.name));

  // Month (units only — never VND).
  const cur = (histQ.data ?? []).filter(h => String(h.lab_day).startsWith(month));
  const prevSame = (histQ.data ?? []).filter(h => String(h.lab_day).startsWith(prevMonth) && Number(String(h.lab_day).slice(8, 10)) <= day);
  const finCur = cur.filter(h => h.kind === 'fin');
  const reasons = new Map<string, number>();
  const byProd = new Map<string, { name: string; sku: string | null; n: number; reasons: Map<string, number> }>();
  for (const h of finCur) {
    reasons.set(h.reason_tag_name, (reasons.get(h.reason_tag_name) ?? 0) + Number(h.qty));
    const p = byProd.get(h.sku) ?? { name: h.product_name, sku: h.sku, n: 0, reasons: new Map() };
    p.n += Number(h.qty); p.reasons.set(h.reason_tag_name, (p.reasons.get(h.reason_tag_name) ?? 0) + Number(h.qty));
    byProd.set(h.sku, p);
  }
  const rawCur = cur.filter(h => h.kind === 'raw' || h.kind === 'pack');
  const monthData: LossMonth = {
    month, day,
    finPcs: finCur.reduce((s, h) => s + Number(h.qty), 0),
    finPrevPcs: prevSame.filter(h => h.kind === 'fin').reduce((s, h) => s + Number(h.qty), 0),
    produced,
    rawKg: Math.round(rawCur.reduce((s, h) => s + Number(h.qty), 0) * 100) / 100,
    rawReports: rawCur.length,
    testTrials: new Set(cur.filter(h => h.kind === 'test' && h.trial_id).map(h => h.trial_id)).size,
    reasons: Array.from(reasons.entries()).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 6),
    top: Array.from(byProd.values()).sort((a, b) => b.n - a.n).slice(0, 5).map(p => ({
      name: p.name, sku: p.sku, n: p.n, produced: p.sku ? (madeMonthBySku.get(p.sku) ?? 0) : 0,
      mainReason: Array.from(p.reasons.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    })),
  };

  return { data: {
    today, me: a.name, canValidate: canApproveForTeam(a, team), leads: leads.map(l => l.name).filter(Boolean),
    items, losses: (lossesQ.data ?? []).map(mapLoss), month: monthData,
  } };
}

export type DeclareInput = {
  kind: LossKind; sku?: string | null; tmplId?: number | null; productId?: number | null; name: string; uom: string;
  qty: number; beforeStock?: boolean; reasonId: number; note?: string | null; photoUrl?: string | null;
};

function reasonName(kind: LossKind, id: number): string | null {
  const list = kind === 'fin' ? REASONS_FINISHED : REASONS_STOCK;
  return list.find(r => r.id === id)?.vi ?? null;
}

export async function declareLossAction(team: string, input: DeclareInput): Promise<{ ok?: boolean; error?: string }> {
  if (!guard(team)) return { error: 'Not available for this team yet' };
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  if (!['fin', 'raw', 'pack'].includes(input.kind)) return { error: 'Bad kind' };
  const qty = Math.round(Number(input.qty) * 1000) / 1000;
  if (!(qty > 0)) return { error: 'Số lượng > 0 / Quantity must be > 0' };
  const reason = reasonName(input.kind, input.reasonId);
  if (!reason) return { error: 'Chọn lý do / Choose a reason' };
  if (input.kind === 'fin' && !input.sku) return { error: 'Missing product' };
  if (input.kind !== 'fin' && !input.productId) return { error: 'Missing product' };
  const { error } = await db.from('lab_chef_losses').insert({
    team, kind: input.kind, sku: input.sku ?? null, tmpl_id: input.tmplId ?? null, product_id: input.productId ?? null,
    product_name: String(input.name).slice(0, 200), uom: input.uom, qty, before_stock: input.kind === 'fin' && !!input.beforeStock,
    reason_tag_id: input.reasonId, reason_tag_name: reason, note: input.note?.trim() || null, photo_url: input.photoUrl || null,
    lab_day: vnTodayStr(), declared_by_id: a.userId, declared_by_name: a.name || null,
  });
  if (error) return { error: error.message };
  return { ok: true };
}

async function loadPending(db: any, team: string, id: string) {
  const { data } = await db.from('lab_chef_losses').select('*').eq('id', id).eq('team', team).maybeSingle();
  return data;
}

export async function updateLossAction(team: string, id: string, patch: { qty?: number; reasonId?: number; beforeStock?: boolean; note?: string | null; photoUrl?: string | null }): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const row = await loadPending(db, team, id);
  if (!row) return { error: 'Not found' };
  if (row.status !== 'pending') return { error: 'Đã duyệt — không sửa được / Already validated' };
  if (row.kind === 'test') return { error: 'Test trial lines are edited from the test' };
  if (row.declared_by_id !== a.userId && !canApproveForTeam(a, team)) return { error: 'Chỉ người khai báo hoặc trưởng nhóm / Only the person who declared it or the lead' };
  const upd: any = { updated_at: new Date().toISOString() };
  if (patch.qty !== undefined) { const q = Math.round(Number(patch.qty) * 1000) / 1000; if (!(q > 0)) return { error: 'Quantity must be > 0' }; upd.qty = q; }
  if (patch.reasonId !== undefined) { const r = reasonName(row.kind, patch.reasonId); if (!r) return { error: 'Bad reason' }; upd.reason_tag_id = patch.reasonId; upd.reason_tag_name = r; }
  if (patch.beforeStock !== undefined && row.kind === 'fin') upd.before_stock = !!patch.beforeStock;
  if (patch.note !== undefined) upd.note = patch.note?.trim() || null;
  if (patch.photoUrl !== undefined) upd.photo_url = patch.photoUrl || null;
  const { error } = await db.from('lab_chef_losses').update(upd).eq('id', id).eq('status', 'pending');
  if (error) return { error: error.message };
  return { ok: true };
}

export async function deleteLossAction(team: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canActForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const row = await loadPending(db, team, id);
  if (!row) return { error: 'Not found' };
  if (row.status !== 'pending') return { error: 'Đã duyệt — không xoá được / Already validated' };
  if (row.declared_by_id !== a.userId && !canApproveForTeam(a, team)) return { error: 'Chỉ người khai báo hoặc trưởng nhóm / Only the person who declared it or the lead' };
  const { error } = await db.from('lab_chef_losses').update({ status: 'deleted', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending');
  if (error) return { error: error.message };
  return { ok: true };
}

export async function validateLossesAction(team: string, ids: string[]): Promise<{ ok?: boolean; n?: number; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canApproveForTeam(a, team)) return { error: 'Chỉ trưởng nhóm mới duyệt được / Only the team lead validates' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  if (!ids.length) return { ok: true, n: 0 };
  const { data, error } = await db.from('lab_chef_losses')
    .update({ status: 'validated', validated_by_id: a.userId, validated_by_name: a.name || null, validated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('team', team).eq('status', 'pending').in('id', ids).select('id');
  if (error) return { error: error.message };
  const done = (data ?? []).map((r: any) => r.id as string);
  const p = (async () => { for (const id of done) await pushChefLoss(db, id).catch(() => null); })();
  try { waitUntil(p); } catch { await p; }
  return { ok: true, n: done.length };
}

/** Retry a loss whose Odoo push failed (lead / admin). */
export async function retryLossAction(team: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  if (!canApproveForTeam(a, team)) return { error: 'Forbidden' };
  const db = rawService();
  if (!db) return { error: 'Server not configured' };
  const r = await pushChefLoss(db, id);
  return r.ok ? { ok: true } : { error: r.error };
}
