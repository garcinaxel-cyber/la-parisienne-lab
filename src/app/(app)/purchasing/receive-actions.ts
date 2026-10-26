'use server';
// PO receiving — purchasing space (Axel, 2026-10-26). Hiền and Miss Flavor (purchasing access) count
// what arrived; validating writes Odoo through lib/odoo-po-receive.ts, then updates the chefs' request
// lines and pushes the requester. Live Odoo reads each time the screen opens; nothing is cached.
// Until PO_RECEIVING_OPEN=1 the screen is admin-only (test on a real PO first).
import { rawService, rawActor, isPurchasing, purchasingUserIds } from '@/lib/raw-materials-db';
import { sendUsersPush, awaitPush } from '@/lib/push-notify';
import { listOpenReceipts, getReceipt, validateReceipt, SHORT_REASONS, type OpenReceipt, type ReceiptDetail, type ValidateLine, type ValidateResult, type ShortReason } from '@/lib/odoo-po-receive';
import type { RawPack } from '@/lib/raw-materials';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard() {
  const a = await rawActor();
  if (!isPurchasing(a)) return null;
  if (process.env.PO_RECEIVING_OPEN !== '1' && a.role !== 'admin') return null;
  const db = rawService();
  if (!db) return null;
  return { a, db };
}

export async function receivingEnabledAction(): Promise<boolean> {
  return !!(await guard());
}

export type OpenReceiptRow = OpenReceipt & { productsVi: string[]; requests: number; teams: string[] };

export async function getOpenReceiptsAction(): Promise<{ items?: OpenReceiptRow[]; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  try {
    const items = await listOpenReceipts();
    const poIds = Array.from(new Set(items.map(i => i.poId)));
    const { data: ls } = poIds.length ? await g.db.from('lab_purchase_request_lines').select('po_odoo_id, request_id').in('po_odoo_id', poIds) : { data: [] as any[] };
    const reqIds = Array.from(new Set((ls ?? []).map((l: any) => l.request_id)));
    const { data: reqs } = reqIds.length ? await g.db.from('lab_purchase_requests').select('id, team').in('id', reqIds) : { data: [] as any[] };
    const teamOf = new Map((reqs ?? []).map((r: any) => [r.id, r.team]));
    const pids = Array.from(new Set(items.flatMap(i => i.products.map(p => p.id))));
    const { data: mats } = pids.length ? await g.db.from('lab_raw_materials').select('product_id, name_vi').in('product_id', pids) : { data: [] as any[] };
    const vi = new Map((mats ?? []).filter((m: any) => m.name_vi).map((m: any) => [Number(m.product_id), String(m.name_vi)]));
    return {
      items: items.map(i => {
        const mine = (ls ?? []).filter((l: any) => Number(l.po_odoo_id) === i.poId);
        return { ...i, productsVi: i.products.map(p => vi.get(p.id) ?? p.name), requests: new Set(mine.map((l: any) => l.request_id)).size, teams: Array.from(new Set(mine.map((l: any) => teamOf.get(l.request_id)).filter(Boolean))) as string[] };
      }),
    };
  } catch (e: any) { return { error: `Odoo: ${e?.message ?? e}` }; }
}

export type ReceiptView = ReceiptDetail & { packs: Record<number, RawPack[]>; nameVi: Record<number, string> };

export async function getReceiptAction(pickingId: number): Promise<{ data?: ReceiptView; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  try {
    const d = await getReceipt(Number(pickingId));
    if (!d) return { error: 'Not found' };
    const pids = d.lines.map(l => l.productId);
    const { data: mats } = pids.length ? await g.db.from('lab_raw_materials').select('product_id, packs, name_vi').in('product_id', pids) : { data: [] as any[] };
    const packs: Record<number, RawPack[]> = {}, nameVi: Record<number, string> = {};
    for (const m of mats ?? []) { if (Array.isArray(m.packs) && m.packs.length) packs[m.product_id] = m.packs; if (m.name_vi) nameVi[m.product_id] = m.name_vi; }
    return { data: { ...d, packs, nameVi } };
  } catch (e: any) { return { error: `Odoo: ${e?.message ?? e}` }; }
}

export async function validateReceiptAction(clientId: string, pickingId: number, lines: ValidateLine[]): Promise<{ result?: ValidateResult; error?: string }> {
  const g = await guard();
  if (!g) return { error: 'Forbidden' };
  if (!UUID.test(String(clientId ?? ''))) return { error: 'Bad id' };
  // A resend (double tap, network cut) never validates twice.
  const { data: done } = await g.db.from('lab_po_receipts').select('id, status').eq('id', clientId).maybeSingle();
  if (done?.status === 'done') return { result: { ok: true, alreadyDone: true, lowered: [], bill: { id: null, action: 'none' }, received: [], log: [] } };
  const by = g.a.name || 'lab-app';
  let res: ValidateResult;
  try {
    res = await validateReceipt(Number(pickingId), (lines ?? []).slice(0, 200), by);
  } catch (e: any) {
    res = { ok: false, error: `Odoo: ${e?.message ?? e}`, lowered: [], bill: { id: null, action: 'none' }, received: [], log: [] };
  }
  const poId = res.poId ?? 0, poName = res.poName ?? '', vendor = res.vendor ?? '';
  const logRow = {
    id: clientId, po_odoo_id: poId, po_name: poName, vendor_name: vendor, picking_odoo_id: Number(pickingId), picking_name: res.pickingName ?? null,
    backorder_name: res.backorderName ?? null, lines: res.received, bill_odoo_id: res.bill.id, bill_action: res.bill.action,
    status: res.ok ? 'done' : 'error', error: res.error ?? null,
    odoo_log: { log: res.log, lowered: res.lowered, gaps: res.bill.gaps ?? [] }, received_by: g.a.userId, received_by_name: by,
  };
  await g.db.from('lab_po_receipts').upsert(logRow);
  if (!res.ok || res.alreadyDone) return { result: res };

  // Chefs' request lines on this PO: received quantity allocated per product, oldest request first.
  const notify = new Map<string, string[]>(); // requester user id -> lines of text
  const { data: rls } = poId ? await g.db.from('lab_purchase_request_lines')
    .select('id, request_id, tmpl_id, name, uom, qty, received_qty, status').eq('po_odoo_id', poId).in('status', ['pending', 'ordered']).order('created_at') : { data: [] as any[] };
  if (rls?.length) {
    const tmplIds = Array.from(new Set(rls.map((l: any) => l.tmpl_id).filter(Boolean)));
    const { data: mats } = await g.db.from('lab_raw_materials').select('tmpl_id, product_id, name_vi').in('tmpl_id', tmplIds);
    const pidOf = new Map((mats ?? []).map((m: any) => [m.tmpl_id, m.product_id]));
    const viOf = new Map((mats ?? []).map((m: any) => [m.tmpl_id, m.name_vi]));
    const reqIds = Array.from(new Set(rls.map((l: any) => l.request_id)));
    const { data: reqs } = await g.db.from('lab_purchase_requests').select('id, no, created_by').in('id', reqIds);
    const reqOf = new Map((reqs ?? []).map((r: any) => [r.id, r]));
    const left = new Map(res.received.map(r => [r.productId, r.received]));
    const now = new Date().toISOString();
    for (const l of rls) {
      const pid = pidOf.get(l.tmpl_id);
      const r = res.received.find(x => x.productId === pid);
      if (!r) continue;
      const need = Math.max(0, Number(l.qty) - Number(l.received_qty ?? 0));
      const give = Math.min(need, left.get(pid) ?? 0);
      left.set(pid, (left.get(pid) ?? 0) - give);
      const got = Math.round((Number(l.received_qty ?? 0) + give) * 1000) / 1000;
      const full = got >= Number(l.qty) - 1e-9 || r.reason === 'no_more';
      await g.db.from('lab_purchase_request_lines').update({
        received_qty: got, shortfall_reason: full && r.reason !== 'no_more' ? null : r.reason, shortfall_note: full && r.reason !== 'no_more' ? null : r.note,
        ...(full ? { status: 'received', received_at: now, received_by_name: by } : {}),
      }).eq('id', l.id);
      const req: any = reqOf.get(l.request_id);
      if (!req?.created_by) continue;
      const name = viOf.get(l.tmpl_id) || l.name;
      const txt = got > 0
        ? `${name}: ${got}/${Number(l.qty)} ${l.uom}${!full && r.reason ? ` · ${SHORT_REASONS[r.reason as ShortReason].vi}` : r.reason === 'no_more' && got < Number(l.qty) ? ` · ${SHORT_REASONS.no_more.vi}` : ''} (#${req.no})`
        : `${name}: chưa về${r.reason ? ` · ${SHORT_REASONS[r.reason as ShortReason].vi}` : ''} (#${req.no})`;
      notify.set(req.created_by, [...(notify.get(req.created_by) ?? []), txt]);
    }
  }
  for (const [uid, txts] of Array.from(notify.entries())) {
    const p = { title: `📦 Hàng đã về · ${poName}`, body: txts.join('\n').slice(0, 400), url: '/station/me', tag: `po-recv-${poId}` };
    await awaitPush(sendUsersPush(g.db, [uid], p, { ...p, title: `📦 Goods arrived · ${poName}` }));
  }
  // Wrong product / supplier mistake: purchasing is told so the replacement gets arranged.
  const issues = res.received.filter(r => r.reason === 'wrong_product' || r.reason === 'supplier_error');
  if (issues.length) {
    const ids = (await purchasingUserIds(g.db)).filter(id => id !== g.a.userId);
    const body = issues.map(r => `${r.name}: ${SHORT_REASONS[r.reason as ShortReason].vi}${r.note ? ` — ${r.note}` : ''}`).join('\n');
    if (ids.length) await awaitPush(sendUsersPush(g.db, ids, { title: `⚠️ ${poName} · ${vendor}`, body: body.slice(0, 400), url: '/purchasing?tab=receive', tag: `po-issue-${poId}` }));
  }
  return { result: res };
}
