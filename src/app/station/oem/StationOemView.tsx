'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Factory, Loader2, RefreshCw, Plus, X, Check, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import { allocateBaked, buildBatches, dOr, NOTE_KEY, noteText, PLAN_COLS, planKg, splitPlan, type PlanRow } from '@/components/oem/plan';
import { setProductionOrderAction, fixProductionAction } from '@/lib/oem-actions';
import { MM_CLIENT, type Item } from '@/components/oem/model';

// Station side of the OEM Orders tracker (Axel, 2026-09-25: "Hung devrait avoir accès qu'à ça").
// Team Hung only needs one thing: per product, kg baked vs kg to bake. Packaging, deliveries and
// inventories and tracking stay on the office page (/oem-orders, admin + assistants).
type Row = { key: string; name: string; group: string; target: number; remake: number; pending: number; baked: number; bySeq: Record<number, number>; sort: number; skus: string[]; weights: number[]; kgUnit: boolean };
type Entry = { id: string; group_key: string; weight_kg: number; prod_date: string; created_at: string; created_by_name: string | null; status: string; received_kg: number | null; plan_seq: number | null };
const GREEN = '#1A4731';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
// Real product name without the pack size ("Bánh quy socola nho khô 80g" → "Bánh quy socola nho khô"),
// so the 80 g / 100 g formats that share one bulk read as one product with both SKUs.
const baseName = (n: string) => n.replace(/\s*\(kg\)\s*$/i, '').replace(/\s+\d+\s*g$/i, '').trim();

export default function StationOemView({ role, userId, userName, canFix = false }: { role: string; userId: string | null; userName: string | null; canFix?: boolean }) {
  const { lang, setLang } = useI18n();
  const vi = lang === 'vi';
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [cancelledPlan, setCancelledPlan] = useState<PlanRow[]>([]); // orders the client cancelled: shown, never counted
  const [delivered, setDelivered] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [today, setToday] = useState<Entry[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({}); // contract requirements per client
  const [ord, setOrd] = useState<number | null>(null); // order chosen in the entry sheet
  const [tagging, setTagging] = useState<string | null>(null);
  // team lead only (canFix): edit the kg of a batch or cancel it while it waits for reception
  const [fix, setFix] = useState<{ id: string; mode: 'edit' | 'cancel' } | null>(null);
  const [fixKg, setFixKg] = useState('');
  const [fixWhy, setFixWhy] = useState('');
  const [fixing, setFixing] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [gk, setGk] = useState('');
  const [kg, setKg] = useState('');
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // back to the station the user came from (?team=hung from the QR, or 'me' for the chef)
  const [back, setBack] = useState('/station/me');
  useEffect(() => { const t = new URLSearchParams(window.location.search).get('team'); if (t && /^[a-z_]+$/.test(t)) setBack(`/station/${t}`); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const [it, pl, pk, dp, dl, nt] = await Promise.all([
      supabase.from('lab_mm_order_items').select('sku, product_name, group_key, group_name, unit, unit_weight_g, qty_ordered, sort_order, client_name').eq('is_active', true).order('sort_order'),
      supabase.from('lab_mm_production_log').select('id, group_key, weight_kg, prod_date, created_at, created_by_name, status, received_kg, plan_seq').order('created_at', { ascending: false }),
      supabase.from('lab_mm_packaging_log').select('kind, sku, group_key, qty').in('kind', ['scrap_bulk', 'scrap_finished']),
      supabase.from('lab_mm_delivery_plan').select(PLAN_COLS).order('seq'),
      supabase.rpc('lab_mm_deliveries'),
      supabase.from('lab_mm_settings').select('key, value').like('key', `${NOTE_KEY}%`),
    ]);
    setNotes(Object.fromEntries(((nt.data ?? []) as any[]).map(r => [String(r.key).slice(NOTE_KEY.length), r.value ?? ''])));
    const dq: Record<string, number> = {};
    for (const x of (dl.data ?? []) as any[]) if (x.order_status === 'validated' && !x.not_delivered && x.qty_checked != null) dq[x.sku] = (dq[x.sku] ?? 0) + Number(x.qty_checked);
    setDelivered(dq);
    setAllItems(((it.data ?? []) as any[]).map(i => ({ ...i, unit_weight_g: Number(i.unit_weight_g), qty_ordered: Number(i.qty_ordered) })) as Item[]);
    const sp = splitPlan(dp.data); setPlan(sp.active); setCancelledPlan(sp.cancelled);
    if (it.error || pl.error) setErr((it.error || pl.error)!.message);
    const m = new Map<string, Row>();
    for (const i of it.data ?? []) {
      const r: Row = m.get(i.group_key) ?? { key: i.group_key, name: baseName(i.product_name), group: i.group_name, target: 0, remake: 0, pending: 0, baked: 0, bySeq: {}, sort: i.sort_order, skus: [] as string[], weights: [] as number[], kgUnit: i.unit === 'kg' };
      r.skus.push(i.sku); if (i.unit !== 'kg') r.weights.push(Number(i.unit_weight_g));
      r.target += i.unit === 'kg' ? Number(i.qty_ordered) : (Number(i.qty_ordered) * Number(i.unit_weight_g)) / 1000;
      r.sort = Math.min(r.sort, i.sort_order);
      m.set(i.group_key, r);
    }
    // progress = declared kg (received kg once received); batches not yet received are flagged apart;
    // losses after reception (broken bulk, faulty/missing bags) are added back to the target.
    for (const l of pl.data ?? []) {
      const r = m.get(l.group_key); if (!r) continue;
      // Axel 2026-09-30: Hưng sees his progress as soon as he declares; it only changes if the
      // assistants receive a different quantity (received_kg replaces the declared kg).
      const k = l.status === 'received' ? Number(l.received_kg ?? 0) : Number(l.weight_kg);
      r.baked += k; if (l.status !== 'received') r.pending += k;
      // kg per order/delivery chosen by the chef (0 = not chosen → automatic, in delivery order)
      r.bySeq[l.plan_seq ?? 0] = (r.bySeq[l.plan_seq ?? 0] ?? 0) + k;
    }
    const w: Record<string, { unit: string; g: number }> = {};
    for (const i of it.data ?? []) w[i.sku] = { unit: i.unit, g: Number(i.unit_weight_g) };
    for (const p of pk.data ?? []) {
      const r = m.get(p.group_key); if (!r) continue;
      if (p.kind === 'scrap_bulk') r.remake += Number(p.qty);
      else if (w[p.sku]) r.remake += w[p.sku].unit === 'kg' ? Number(p.qty) : (Number(p.qty) * w[p.sku].g) / 1000;
    }
    setRows(Array.from(m.values()).sort((a, b) => a.sort - b.sort));
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); const iso = d.toISOString().slice(0, 10);
    const all = ((pl.data ?? []) as any[]).map(l => ({ ...l, weight_kg: Number(l.weight_kg), received_kg: l.received_kg == null ? null : Number(l.received_kg) })) as Entry[];
    setEntries(all);
    setToday(all.filter(l => l.prod_date === iso));
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  // Delivery schedules (Axel 2026-09-30): one baking plan per client that has one (Maison Mooncake,
  // Tianhe Food…). Per product group: cumulative kg of the delivery + re-make for losses − kg baked.
  const isoToday = useMemo(() => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }, []);
  const plans = useMemo(() => {
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    const clients = Array.from(new Set(plan.map(p => p.client_name || MM_CLIENT)));
    return clients.map(client => {
      const items = allItems.filter(i => (i.client_name || MM_CLIENT) === client);
      const rowsOfClient = plan.filter(p => (p.client_name || MM_CLIENT) === client);
      const batches = buildBatches(items, rowsOfClient);
      // Separate orders (explicit kg per order — Tianhe): each one is followed on its own and, when there
      // are several, the chef says which one he bakes for. A % schedule (Maison Mooncake) stays cumulative.
      const perOrder = rowsOfClient.some(r => r.qty);
      const seqs = batches.map(b => b.row.seq);
      const groups = Object.keys(batches[0]?.cumKgByGroup ?? {});
      const own = (g: string, k: number) => (batches[k].cumKgByGroup[g] ?? 0) - (k ? batches[k - 1].cumKgByGroup[g] ?? 0 : 0);
      const alloc = Object.fromEntries(groups.map(g => [g, allocateBaked(batches.map((_, k) => own(g, k)), seqs, byKey[g]?.bySeq ?? {}, byKey[g]?.remake ?? 0)]));
      const sched = batches.map((b, k) => {
        const need = groups.map(g => {
          const a = alloc[g]; const name = byKey[g]?.name ?? g;
          // re-make for losses goes to the first order / delivery still open (the last one if all are baked)
          const open = a.ownLeft.findIndex(x => x > 0.0005); const ro = open < 0 ? batches.length - 1 : open;
          // Axel 2026-10-09: a delivery shows its OWN kg (the chef read the cumulative 91 kg as one batch);
          // what earlier deliveries still miss is shown apart (prev), never added into this one.
          const prev = a.ownLeft.slice(0, k).reduce((s, x) => s + x, 0) + (ro < k ? a.remakeLeft : 0);
          return { key: g, name, cum: own(g, k), baked: Math.max(0, own(g, k) - a.ownLeft[k]), left: a.ownLeft[k] + (k === ro ? a.remakeLeft : 0), prev };
        });
        const left = need.reduce((s, x) => s + x.left, 0);
        const prevLeft = need.reduce((s, x) => s + x.prev, 0);
        const shipped = items.every(i => (delivered[i.sku] ?? 0) >= (b.cumQty[i.sku] ?? 0) - 0.0005);
        return { b, need, left, prevLeft, done: left < 0.05, shipped };
      });
      const kgUnits = items.every(i => i.unit === 'kg');
      const total = items.reduce((s, i) => s + i.qty_ordered, 0);
      const done = items.reduce((s, i) => s + Math.min(i.qty_ordered, delivered[i.sku] ?? 0), 0);
      // kg declared with no order chosen (entered from the main station screen): counted in order, flagged
      const untagged = perOrder && batches.length > 1 ? groups.reduce((s, g) => s + (byKey[g]?.bySeq[0] ?? 0), 0) : 0;
      const whole = groups.map(g => ({ key: g, name: byKey[g]?.name ?? g, baked: byKey[g]?.baked ?? 0, T: (byKey[g]?.target ?? 0) + (byKey[g]?.remake ?? 0) }));
      const lastBy = [...batches].reverse().find(b => b.produceBy)?.produceBy ?? null;
      return { client, items, sched, whole, lastBy, groups, nextIdx: sched.findIndex(x => !x.done), kgUnits, total, done, perOrder, untagged };
    }).filter(p => p.sched.length);
  }, [allItems, plan, rows, delivered]);
  // the chef can open any delivery (tap on the timeline); default = the next one not baked yet
  const [pick, setPick] = useState<Record<string, number>>({});
  // per client: 'd' = per delivery (default), 't' = whole order, like the 17h report (Axel 2026-10-09)
  const [view, setView] = useState<Record<string, 'd' | 't'>>({});
  const shownOf = (p: { client: string; sched: unknown[]; nextIdx: number }) => (pick[p.client] != null && pick[p.client] < p.sched.length ? pick[p.client] : p.nextIdx);
  const daysTo = (iso: string) => Math.round((Date.parse(iso) - Date.parse(isoToday)) / 86400000);
  const Lx = (v: string, e: string) => (vi ? v : e);
  // hint under each product row: the delivery shown in its client's plan
  const nextByGroup = useMemo(() => {
    const m: Record<string, { left: number; seq: number; by: string | null; po: boolean }> = {};
    for (const p of plans) { const k = shownOf(p); const x = k >= 0 ? p.sched[k] : null; if (x) for (const n of x.need) m[n.key] = { left: n.left, seq: x.b.row.seq, by: x.b.produceBy, po: p.perOrder }; }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, pick]);

  const ordersByGroup = useMemo(() => {
    const m: Record<string, { seq: number; baked: number; cum: number }[]> = {};
    for (const p of plans) if (p.perOrder) for (const x of p.sched) for (const n of x.need) (m[n.key] ??= []).push({ seq: x.b.row.seq, baked: n.baked, cum: n.cum });
    return m;
  }, [plans]);

  // same rule as the station: workers/viewers are read-only
  const canLog = ['admin', 'lab_manager', 'assistant', 'chef'].includes(role);
  const sel = rows.find(r => r.key === gk);
  const kgNum = Number(kg.replace(',', '.')) || 0;
  // the product's client has separate orders → the chef must say which one this batch is for
  const selPlan = sel ? plans.find(p => p.perOrder && p.items.some(i => i.group_key === sel.key)) ?? null : null;
  // one order only → nothing to choose, the batch is for that order
  const ordEff = selPlan && selPlan.sched.length === 1 ? selPlan.sched[0].b.row.seq : ord;
  // contract requirements of the selected product's client, repeated in the entry sheet
  const selNote = sel ? noteText(notes[allItems.find(i => i.group_key === sel.key)?.client_name || MM_CLIENT], vi) : '';
  const W = (po: boolean) => (po ? (vi ? 'Đơn' : 'Order') : (vi ? 'Đợt' : 'Delivery'));

  async function saveProd() {
    if (!sel || !(kgNum > 0) || kgNum > 2000 || (selPlan && ordEff == null)) return;
    setSaving(true); setErr(null);
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const { error } = await supabase.from('lab_mm_production_log').insert({
      prod_date: d.toISOString().slice(0, 10), group_key: sel.key, sku: sel.skus[0] ?? null,
      weight_kg: Math.round(kgNum * 1000) / 1000, created_by: userId, created_by_name: userName,
      ...(selPlan ? { plan_seq: ordEff } : {}),
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setSheet(false); setKg(''); setGk(''); setOrd(null);
    setFlash(`+${kgNum} kg · ${sel.name}${selPlan ? ` · ${W(true)} ${ordEff}` : ''}`); setTimeout(() => setFlash(null), 3500);
    await load();
  }
  // change the order of a batch already declared (also batches entered from the main station screen)
  async function tag(id: string, seq: number) {
    setTagging(id); setErr(null);
    const r = await setProductionOrderAction(id, seq);
    if (r.error) setErr(r.error);
    await load(); setTagging(null);
  }

  // ── team lead corrections (canFix) ──
  const FIX_ERR: Record<string, [string, string]> = {
    'already-received': ['Mẻ này đã được trợ lý nhận — không sửa được nữa.', 'Already received by an assistant — it can no longer be changed.'],
    'Forbidden': ['Bạn không có quyền sửa mẻ nướng.', 'You are not allowed to change baked batches.'],
    'not-your-team': ['Mẻ này không thuộc nhóm của bạn.', 'This batch is not from your team.'],
    'bad-kg': ['Số kg không hợp lệ.', 'Invalid kg.'],
    'Batch not found': ['Không tìm thấy mẻ này (có thể đã bị huỷ).', 'Batch not found (it may already be cancelled).'],
  };
  const fixNum = Number(fixKg.replace(',', '.')) || 0;
  async function doFix() {
    if (!fix || (fix.mode === 'edit' && !(fixNum > 0))) return;
    setFixing(true); setErr(null);
    const r = await fixProductionAction(fix.id, fix.mode === 'edit' ? fixNum : null, fixWhy.trim() || null);
    setFixing(false);
    if (r.error) { const m = FIX_ERR[r.error]; setErr(m ? (vi ? m[0] : m[1]) : r.error); }
    else { setFlash(fix.mode === 'edit' ? (vi ? `Đã sửa thành ${fixNum} kg` : `Changed to ${fixNum} kg`) : (vi ? 'Đã huỷ mẻ' : 'Batch cancelled')); setTimeout(() => setFlash(null), 3500); }
    setFix(null); setFixKg(''); setFixWhy('');
    await load();
  }
  // batches of earlier days still waiting for reception: listed for the team lead only, so he can fix them too
  const olderPending = canFix ? entries.filter(e => e.status !== 'received' && !today.some(t => t.id === e.id)) : [];
  const entryRow = (t: Entry, withDate: boolean) => {
    const open = fix?.id === t.id;
    const fixable = canFix && t.status !== 'received';
    return (
      <div key={t.id} style={{ borderTop: '1px solid #F3F4F6' }}>
        <div className="flex items-center justify-between px-4 py-2.5 text-sm">
          <span className="min-w-0">
            <span className="block font-semibold">{rows.find(r => r.key === t.group_key)?.name ?? t.group_key}</span>
            {canFix && t.created_by_name && <span className="block text-[11px]" style={{ color: '#9CA3AF' }}>{t.created_by_name}</span>}
          </span>
          <span className="text-right">
            <b>{t.weight_kg} kg</b> <span className="text-xs" style={{ color: '#9CA3AF' }}>· {withDate ? `${t.prod_date.slice(8, 10)}/${t.prod_date.slice(5, 7)} ` : ''}{new Date(t.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{t.plan_seq != null ? ` · ${W(plans.some(p => p.perOrder && p.items.some(i => i.group_key === t.group_key)))} ${t.plan_seq}` : ''}</span>
            <span className="block text-[11px] font-semibold" style={{ color: t.status === 'received' ? '#047857' : '#B45309' }}>
              {t.status === 'received' ? `${vi ? 'Đã nhận' : 'Received'} ${t.received_kg} kg` : (vi ? 'Chờ trợ lý nhận' : 'Waiting for reception')}
            </span>
            {fixable && !open && (
              <span className="flex justify-end gap-1.5 mt-1.5">
                <button onClick={() => { setFix({ id: t.id, mode: 'edit' }); setFixKg(String(t.weight_kg)); setFixWhy(''); setErr(null); }}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold active:scale-95 transition" style={{ backgroundColor: '#F7F5F0', color: '#4B5563', border: '1px solid #EFE9DC' }}>
                  <Pencil size={12} />{vi ? 'Sửa' : 'Edit'}
                </button>
                <button onClick={() => { setFix({ id: t.id, mode: 'cancel' }); setFixKg(''); setFixWhy(''); setErr(null); }}
                  className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-bold active:scale-95 transition" style={{ backgroundColor: '#FEF2F2', color: '#B91C1C', border: '1px solid #FBD5D5' }}>
                  <Trash2 size={12} />{vi ? 'Huỷ' : 'Cancel'}
                </button>
              </span>
            )}
          </span>
        </div>
        {open && fix && (
          <div className="mx-4 mb-3 rounded-xl px-3 py-2.5 space-y-2" style={fix.mode === 'cancel' ? { backgroundColor: '#FEF2F2', border: '1px solid #FBD5D5' } : { backgroundColor: '#F7F5F0', border: '1px solid #EFE9DC' }}>
            <div className="text-xs font-bold" style={{ color: fix.mode === 'cancel' ? '#B91C1C' : '#374151' }}>
              {fix.mode === 'cancel' ? (vi ? `Huỷ mẻ ${t.weight_kg} kg này?` : `Cancel this ${t.weight_kg} kg batch?`) : (vi ? 'Số kg đúng' : 'Correct weight (kg)')}
            </div>
            {fix.mode === 'edit' && (
              <input inputMode="decimal" autoFocus value={fixKg} onChange={e => setFixKg(e.target.value)}
                className="w-full rounded-lg px-3 py-2 text-base font-bold bg-white" style={{ border: '1px solid #D1D5DB' }} />
            )}
            <input value={fixWhy} onChange={e => setFixWhy(e.target.value)} maxLength={300} placeholder={vi ? 'Lý do (không bắt buộc)' : 'Reason (optional)'}
              className="w-full rounded-lg px-3 py-2 text-sm bg-white" style={{ border: '1px solid #D1D5DB' }} />
            <div className="flex gap-2">
              <button disabled={fixing || (fix.mode === 'edit' && !(fixNum > 0))} onClick={doFix}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: fix.mode === 'cancel' ? '#DC2626' : GREEN }}>
                {fixing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}{fix.mode === 'cancel' ? (vi ? 'Xác nhận huỷ' : 'Confirm cancel') : (vi ? 'Lưu' : 'Save')}
              </button>
              <button disabled={fixing} onClick={() => setFix(null)} className="rounded-lg px-3 py-2 text-sm font-semibold bg-white" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>{vi ? 'Đóng' : 'Close'}</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const pctTxt = (x: number) => (x > 0 && x < 10 ? fmt1(x) : String(Math.round(x)));
  const wholeView = (p: (typeof plans)[number]) => {
    const T = p.whole.reduce((s, x) => s + x.T, 0); const B = p.whole.reduce((s, x) => s + Math.min(x.baked, x.T), 0);
    const pc = T ? Math.min(100, (B / T) * 100) : 0; const left = Math.max(0, T - B);
    // pace: needed = kg left / days (Sundays included) until the last bake-by date; actual = last 7 days, per production day
    const since = new Date(Date.parse(isoToday) - 6 * 86400000).toISOString().slice(0, 10);
    const recent = entries.filter(e => p.groups.includes(e.group_key) && e.prod_date >= since && e.prod_date <= isoToday);
    const kg7 = recent.reduce((s, e) => s + (e.status === 'received' ? e.received_kg ?? 0 : e.weight_kg), 0);
    const days7 = new Set(recent.map(e => e.prod_date)).size; const actual = days7 ? kg7 / days7 : 0;
    const wd = p.lastBy ? Math.max(0, daysTo(p.lastBy) + 1) : 0; // the lab bakes 7 days a week (Axel 2026-10-09)
    const need = wd ? left / wd : null; const ok = need != null && actual >= need;
    const notStarted = p.whole.filter(x => x.baked < 0.05).length;
    return (
      <div className="px-4 pb-3 space-y-3">
        <div className="flex items-end justify-between gap-3 pt-1">
          <div><div className="text-4xl font-extrabold leading-none" style={{ color: '#2B1D12' }}>{pctTxt(pc)}%</div>
            <div className="text-xs mt-1" style={{ color: '#7A6A5A' }}>{vi ? 'toàn bộ đơn hàng đã nướng' : 'of the whole order baked'}</div></div>
          <div className="text-right text-sm" style={{ color: '#4A3A2C' }}><b className="text-[15px]" style={{ color: '#2B1D12' }}>{fmt1(B)} / {fmt1(T)} kg</b><br />{vi ? 'còn lại' : 'left'} {fmt1(left)} kg</div>
        </div>
        <span className="block h-3.5 rounded-full overflow-hidden" style={{ backgroundColor: '#F1E4D0' }}><span className="block h-full rounded-full" style={{ width: `${pc}%`, backgroundColor: '#9C5F2A' }} /></span>
        <div className="space-y-2.5 pt-1">
          {p.whole.map(x => { const q = x.T ? Math.min(100, (x.baked / x.T) * 100) : 0; return (
            <div key={x.key}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-semibold min-w-0 truncate">{x.name}</span>
                <span className="whitespace-nowrap" style={{ color: '#4A3A2C' }}><b>{pctTxt(q)}%</b> · {fmt1(x.baked)} / {fmt1(x.T)} kg</span>
              </div>
              <span className="block h-2 mt-1 rounded-full overflow-hidden" style={{ backgroundColor: '#F1E4D0' }}><span className="block h-full rounded-full" style={{ width: `${q}%`, backgroundColor: '#9C5F2A' }} /></span>
            </div>); })}
        </div>
        <div className="text-xs leading-relaxed pt-2" style={{ color: '#4A3A2C', borderTop: '1px solid #EFE9DC' }}>
          <b>{vi ? 'Tốc độ' : 'Pace'}:</b>{' '}
          {need != null ? (vi ? `cần khoảng ${fmt1(need)} kg/ngày đến ${dOr(p.lastBy, Lx)}` : `about ${fmt1(need)} kg/day needed until ${dOr(p.lastBy, Lx)}`) : (vi ? 'chưa có ngày giao cuối' : 'no final date yet')}
          {days7 > 0 && <>{' · '}{vi ? `thực tế ~${fmt1(actual)} kg/ngày (${days7} ngày gần đây)` : `actual ~${fmt1(actual)} kg/day (last ${days7} days)`}</>}
          {need != null && days7 > 0 && <b style={{ color: ok ? '#047857' : '#B91C1C' }}> {ok ? (vi ? '✓ kịp tiến độ' : '✓ on track') : (vi ? '⚠ chậm hơn cần thiết' : '⚠ behind pace')}</b>}
          <br /><b>{vi ? 'Chưa bắt đầu' : 'Not started'}:</b> {notStarted} / {p.whole.length} {vi ? 'sản phẩm' : 'products'}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2.5 text-white" style={{ backgroundColor: GREEN }}>
        <Link href={back} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }} aria-label="back">
          <ArrowLeft size={16} />
        </Link>
        <Factory size={18} />
        <div className="font-bold text-sm sm:text-base flex-1">{vi ? 'Đơn hàng OEM' : 'OEM Orders'}</div>
        <button onClick={load} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }} aria-label="refresh">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button onClick={() => setLang(vi ? 'en' : 'vi')} className="text-xs font-bold rounded-lg px-2 py-1.5" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
          {vi ? 'EN' : 'VI'}
        </button>
      </div>

      <div className="p-3 sm:p-5 max-w-3xl mx-auto space-y-3">
        {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{err}</div>}
        {flash && <div className="text-sm font-bold rounded-xl px-3 py-2.5" style={{ backgroundColor: '#ECFDF5', color: '#047857' }}>✓ {flash}</div>}

        {canLog && (
          <button onClick={() => { setSheet(true); setErr(null); }}
            className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-bold text-white active:scale-[0.98] transition"
            style={{ backgroundColor: GREEN }}>
            <Plus size={20} />{vi ? 'Sản xuất thêm (kg)' : 'Extra production (kg)'}
          </button>
        )}

        {today.length > 0 && (
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{vi ? 'Hôm nay' : 'Today'}</div>
            {today.map(t => entryRow(t, false))}
          </div>
        )}
        {olderPending.length > 0 && (
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            <div className="px-4 py-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{vi ? 'Chờ nhận — các ngày trước' : 'Waiting for reception — earlier days'}</div>
            {olderPending.map(t => entryRow(t, true))}
          </div>
        )}
        {plans.map(p => {
          const shownIdx = shownOf(p); const next = shownIdx >= 0 ? p.sched[shownIdx] : null;
          const u = p.kgUnits ? 'kg' : (vi ? 'gói' : 'bags');
          return (
          <div key={p.client} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            <div className="px-4 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{vi ? 'Kế hoạch nướng' : 'Baking plan'} · {p.client.replace('CÔNG TY CỔ PHẦN ', '')}</div>
            {noteText(notes[p.client], vi) && (
              <div className="mx-4 mt-1 mb-2 rounded-xl px-3 py-2.5" style={{ backgroundColor: '#FFF7E6', border: '1px solid #F3E3C0' }}>
                <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: '#8A6A2F' }}>{vi ? 'Yêu cầu của hợp đồng' : 'Contract requirements'}</div>
                <div className="text-sm font-semibold mt-1 whitespace-pre-line leading-snug" style={{ color: '#5B4520' }}>{noteText(notes[p.client], vi)}</div>
              </div>
            )}
            {!p.perOrder && (
              <div className="mx-4 mb-3 grid grid-cols-2 gap-1 rounded-xl p-1" style={{ backgroundColor: '#F1EEE6' }}>
                {(['d', 't'] as const).map(v => { const on = (view[p.client] ?? 'd') === v; return (
                  <button key={v} onClick={() => setView(s => ({ ...s, [p.client]: v }))} className="rounded-lg py-2 text-sm font-bold transition"
                    style={on ? { backgroundColor: GREEN, color: '#fff' } : { color: '#6B7280' }}>
                    {v === 'd' ? (vi ? 'Theo đợt giao' : 'Per delivery') : (vi ? 'Toàn bộ đơn hàng' : 'Whole order')}
                  </button>); })}
              </div>
            )}
            {p.perOrder ? (
              <div className="px-4 pb-3 pt-1 space-y-2.5">
                {p.sched.map(x => {
                  const tot = x.need.reduce((s, n) => s + n.cum, 0); const bk = x.need.reduce((s, n) => s + n.baked, 0);
                  const pc = tot ? Math.min(100, (bk / tot) * 100) : 0;
                  const dl = x.b.produceBy ? daysTo(x.b.produceBy) : null; const late = dl != null && dl < 0 && !x.done;
                  return (
                    <div key={x.b.row.id} className="rounded-xl px-3 py-3 space-y-2" style={{ backgroundColor: '#F7F5F0', border: `1px solid ${x.done ? '#A7F3D0' : '#EFE9DC'}` }}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[15px] font-bold" style={{ color: GREEN }}>{W(true)} {x.b.row.seq} · {fmt(x.b.kg)} kg</span>
                        <span className="text-[15px] whitespace-nowrap" style={{ color: '#111827' }}><b>{fmt1(bk)}</b><span style={{ color: '#9CA3AF' }}> / {fmt1(tot)} kg</span></span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="flex-1 h-3 rounded-full overflow-hidden" style={{ backgroundColor: '#E7DFCF' }}>
                          <span className="block h-full rounded-full" style={{ width: `${pc}%`, backgroundColor: x.done ? '#059669' : GREEN }} />
                        </span>
                        <span className="w-11 text-right text-sm font-bold" style={{ color: x.done ? '#059669' : GREEN }}>{Math.round(pc)}%</span>
                      </div>
                      <div className="text-xs" style={{ color: late ? '#B91C1C' : '#6B7280' }}>
                        {x.done ? (vi ? 'Đã nướng đủ ✓' : 'Fully baked ✓') : <><b>{vi ? 'Còn' : 'Left'} {fmt1(x.left)} kg</b>{x.b.produceBy && <>{' · '}{vi ? 'nướng trước' : 'bake by'} {dOr(x.b.produceBy, Lx)}{dl != null && (late ? (vi ? ` (trễ ${-dl} ngày)` : ` (${-dl} days late)`) : (vi ? ` (còn ${dl} ngày)` : ` (${dl} days left)`))}</>}</>}
                        {' · '}{x.shipped ? (vi ? '✓ đã giao' : '✓ shipped') : `${vi ? 'Giao' : 'Ship'} ${dOr(x.b.row.delivery_date, Lx)}`}
                      </div>
                      <div className="space-y-1.5 pt-1" style={{ borderTop: '1px solid #EFE9DC' }}>
                        {x.need.map(n => (
                          <div key={n.key} className="pt-1">
                            <div className="flex items-baseline justify-between gap-3 text-sm">
                              <span className="font-semibold min-w-0 truncate">{n.name}</span>
                              <span className="whitespace-nowrap">{n.cum > 0 && n.baked >= n.cum - 0.05 && <b style={{ color: '#047857' }}>✓ </b>}<b>{fmt1(n.baked)}</b><span className="text-xs" style={{ color: '#9CA3AF' }}> / {fmt1(n.cum)} kg</span></span>
                            </div>
                            <span className="block h-1.5 mt-1 rounded-full overflow-hidden" style={{ backgroundColor: '#E7DFCF' }}>
                              <span className="block h-full rounded-full" style={{ width: `${n.cum ? Math.min(100, (n.baked / n.cum) * 100) : 0}%`, backgroundColor: n.baked >= n.cum - 0.05 ? '#059669' : '#8FB3A0' }} />
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                {cancelledPlan.filter(r => (r.client_name || MM_CLIENT) === p.client).map(r => (
                  <div key={r.id} className="flex items-baseline justify-between gap-3 rounded-xl px-3 py-2 text-sm" style={{ backgroundColor: '#F9FAFB', border: '1px dashed #E5E7EB', color: '#9CA3AF' }}>
                    <span className="font-bold line-through">{W(true)} {r.seq}{r.qty ? ` · ${fmt(planKg(r))} kg` : ''}</span>
                    <span className="text-[11px] font-semibold text-right">{vi ? 'Khách đã huỷ — không nướng nữa' : 'Cancelled by the client — do not bake'}</span>
                  </div>
                ))}
                {p.untagged > 0.0005 && (
                  <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FFF7E6', color: '#B45309' }}>
                    {vi ? `${fmt1(p.untagged)} kg chưa chọn đơn — tạm tính theo thứ tự (${W(true)} ${p.sched[0].b.row.seq} trước). Chọn đơn ở danh sách bên dưới.` : `${fmt1(p.untagged)} kg with no order chosen — counted in order for now (${W(true)} ${p.sched[0].b.row.seq} first). Choose the order in the list below.`}
                  </div>
                )}
              </div>
            ) : (view[p.client] ?? 'd') === 't' ? wholeView(p) : next ? (() => {
              const dl = next.b.produceBy ? daysTo(next.b.produceBy) : null; const late = dl != null && dl < 0 && !next.done;
              return (
                <div className="px-4 pb-3 space-y-2">
                  <div className="rounded-xl px-3 py-2.5" style={{ backgroundColor: next.done ? '#ECFDF5' : late ? '#FEF2F2' : dl != null && dl <= 7 ? '#FFF7E6' : '#F7F5F0' }}>
                    <div className="text-[15px] font-bold" style={{ color: next.done ? '#047857' : late ? '#B91C1C' : '#111827' }}>
                      {next.done
                        ? `${W(p.perOrder)} ${next.b.row.seq}: ${vi ? 'đã nướng đủ ✓' : 'fully baked ✓'}`
                        : next.b.produceBy
                          ? `${W(p.perOrder)} ${next.b.row.seq}: ${vi ? 'nướng xong trước' : 'bake by'} ${dOr(next.b.produceBy, Lx)}`
                          : `${W(p.perOrder)} ${next.b.row.seq}: ${vi ? 'chưa có ngày giao' : 'date not given yet'}`}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                      {p.perOrder
                        ? `${vi ? 'Giao' : 'Ship'} ${dOr(next.b.row.delivery_date, Lx)} · ${fmt(next.b.kg)} kg`
                        : vi ? `Giao ${dOr(next.b.row.delivery_date, Lx)} · ${fmt1(Number(next.b.row.pct))}% đơn hàng · ${fmt1(next.b.kg)} kg` : `Ship ${dOr(next.b.row.delivery_date, Lx)} · ${fmt1(Number(next.b.row.pct))}% of the order · ${fmt1(next.b.kg)} kg`}
                      {!next.done && <>{' · '}<b>{fmt1(next.left)} kg</b> {vi ? 'còn thiếu' : 'left'}{dl != null && <>{' · '}{late ? (vi ? `trễ ${-dl} ngày` : `${-dl} days late`) : (vi ? `còn ${dl} ngày` : `${dl} days left`)}</>}</>}
                    </div>
                  </div>
                  {next.prevLeft > 0.05 && (
                    <div className="rounded-xl px-3 py-2 text-xs font-semibold" style={{ backgroundColor: '#FEF2F2', color: '#B91C1C', border: '1px solid #FBD5D5' }}>
                      {vi ? `Các đợt trước còn thiếu ${fmt1(next.prevLeft)} kg — nướng bù trước.` : `Earlier deliveries still miss ${fmt1(next.prevLeft)} kg — bake those first.`}
                    </div>
                  )}
                  {next.need.map(x => (
                    <div key={x.key} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-semibold min-w-0 truncate">{x.name}</span>
                      <span className="whitespace-nowrap">
                        {x.left > 0.05 ? <b>{vi ? 'còn' : 'left'} {fmt1(x.left)} kg</b> : <b style={{ color: '#047857' }}>✓ {vi ? 'đủ' : 'done'}</b>}
                        <span className="text-xs" style={{ color: '#9CA3AF' }}> / {fmt1(x.cum)} kg</span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })() : (
              <div className="px-4 pb-3 text-sm font-bold" style={{ color: '#059669' }}>{vi ? 'Đã nướng đủ cho tất cả các đợt ✓' : 'Baked enough for every delivery ✓'}</div>
            )}
            <div className="px-4 pb-2 space-y-1">
              <div className="flex items-baseline justify-between text-xs" style={{ color: '#6B7280' }}>
                <span className="font-bold uppercase tracking-wide text-[11px]" style={{ color: '#9CA3AF' }}>{vi ? 'Đã giao cho khách' : 'Delivered to the client'}</span>
                <span><b style={{ color: '#111827' }}>{fmt(p.done)}</b> / {fmt(p.total)} {u} · {p.total ? Math.round((p.done / p.total) * 100) : 0}%</span>
              </div>
              <span className="block h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#EFE9DC' }}>
                <span className="block h-full rounded-full" style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%`, backgroundColor: '#B8893B' }} />
              </span>
            </div>
            {!p.perOrder && (view[p.client] ?? 'd') === 'd' && <div className="px-4 pb-3 flex gap-1.5 overflow-x-auto">
              {p.sched.map((x, k) => (
                <button key={x.b.row.id} onClick={() => setPick(s => ({ ...s, [p.client]: k }))} className="shrink-0 rounded-lg px-2.5 py-1.5 text-center active:scale-95 transition"
                  style={{ minWidth: 84, backgroundColor: x.done ? '#ECFDF5' : k === p.nextIdx ? '#FFF7E6' : '#F9FAFB', border: k === shownIdx ? `2px solid ${GREEN}` : `1px solid ${x.done ? '#A7F3D0' : k === p.nextIdx ? '#F3E3C0' : '#EFE9DC'}` }}>
                  <div className="text-[11px] font-bold" style={{ color: k === shownIdx ? GREEN : '#6B7280' }}>{W(p.perOrder)} {x.b.row.seq} · {fmt(x.b.kg)} kg</div>
                  <div className="text-[11px] font-bold" style={{ color: x.done ? '#047857' : '#111827' }}>{x.done ? (vi ? '✓ đã nướng' : '✓ baked') : x.b.produceBy ? `${vi ? 'Nướng trước' : 'Bake by'} ${dOr(x.b.produceBy, Lx)}` : (vi ? 'Chưa có ngày' : 'Date TBC')}</div>
                  <div className="text-[10px] font-semibold" style={{ color: x.shipped ? '#047857' : '#9CA3AF' }}>{x.shipped ? (vi ? '✓ đã giao' : '✓ shipped') : `${vi ? 'Giao' : 'Ship'} ${dOr(x.b.row.delivery_date, Lx)}`}</div>
                  {!x.done && <div className="text-[10px] font-bold" style={{ color: '#B45309' }}>{vi ? 'còn' : 'left'} {fmt1(x.left)} kg</div>}
                </button>
              ))}
            </div>}
            {p.perOrder && p.sched.length > 1 && (() => {
              // batches baked for this client: those with no order chosen first, then the latest ones
              const mine = entries.filter(e => p.items.some(i => i.group_key === e.group_key));
              const list = [...mine.filter(e => e.plan_seq == null), ...mine.filter(e => e.plan_seq != null).slice(0, 6)];
              if (!list.length) return null;
              return (
                <div className="px-4 pb-3 space-y-1.5" style={{ borderTop: '1px solid #F3F4F6' }}>
                  <div className="pt-2.5 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{vi ? 'Mẻ đã nướng — cho đơn nào?' : 'Baked batches — for which order?'}</div>
                  {list.map(e => (
                    <div key={e.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        <span className="block font-semibold truncate">{rows.find(r => r.key === e.group_key)?.name ?? e.group_key}</span>
                        <span className="block text-[11px]" style={{ color: e.plan_seq == null ? '#B45309' : '#9CA3AF' }}>
                          {fmt1(e.status === 'received' ? e.received_kg ?? 0 : e.weight_kg)} kg · {dOr(e.prod_date, Lx)}{e.plan_seq == null ? ` · ${vi ? 'chưa chọn đơn' : 'no order chosen'}` : ''}
                        </span>
                      </span>
                      <span className="flex gap-1 shrink-0">
                        {p.sched.map(x => {
                          const on = e.plan_seq === x.b.row.seq;
                          return (
                            <button key={x.b.row.id} disabled={!canLog || on || tagging === e.id} onClick={() => tag(e.id, x.b.row.seq)}
                              className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold active:scale-95 transition"
                              style={on ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#F7F5F0', color: '#6B7280', border: '1px solid #EFE9DC', opacity: canLog ? 1 : 0.5 }}>
                              {tagging === e.id && !on ? '…' : `${W(true)} ${x.b.row.seq}`}
                            </button>
                          );
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
          );
        })}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          {loading && !rows.length ? (
            <div className="flex justify-center py-10"><Loader2 className="animate-spin" style={{ color: GREEN }} /></div>
          ) : rows.map(r => {
            const T = r.target + r.remake;
            const pct = T ? Math.min(100, (r.baked / T) * 100) : 0;
            const done = T > 0 && r.baked >= T;
            return (
              // Phone-first (the team works on phones only): name + kg on one line, full-width bar below.
              <div key={r.key} className="px-4 py-3.5 space-y-2" style={{ borderTop: '1px solid #F3F4F6' }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{r.name}</span>
                    <span className="block text-[11px] mt-0.5" style={{ color: '#9CA3AF' }}>{r.skus.join(' · ')}</span>
                  </span>
                  <span className="text-[15px] whitespace-nowrap" style={{ color: '#111827' }}>
                    <b>{fmt1(r.baked)}</b><span style={{ color: '#9CA3AF' }}> / {fmt1(T)} kg</span>
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="flex-1 h-3 rounded-full overflow-hidden" style={{ backgroundColor: '#EFE9DC' }}>
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: done ? '#059669' : '#8FB3A0' }} />
                  </span>
                  <span className="w-11 text-right text-sm font-semibold" style={{ color: done ? '#059669' : '#6B7280' }}>{Math.round(pct)}%</span>
                </div>
                <div className="text-xs" style={{ color: '#9CA3AF' }}>
                  {done ? (vi ? 'Đã đủ ✓' : 'Done ✓') : `${vi ? 'Còn lại' : 'Left'}: ${fmt1(Math.max(0, T - r.baked))} kg`}
                  {r.remake > 0.0005 && <span style={{ color: '#B91C1C' }}> · {vi ? 'Mục tiêu' : 'Target'} {fmt1(r.target)} + {fmt1(r.remake)} kg {vi ? 'làm lại' : 're-make'}</span>}
                  {r.pending > 0.0005 && <span style={{ color: '#B45309' }}> · {vi ? 'trong đó chờ trợ lý nhận' : 'of which waiting for reception'} {fmt1(r.pending)} kg</span>}
                  {ordersByGroup[r.key] && <span className="block font-semibold" style={{ color: '#8A6A2F' }}>{ordersByGroup[r.key].map(o => `${W(true)} ${o.seq}: ${fmt1(o.baked)} / ${fmt1(o.cum)} kg`).join(' · ')}</span>}
                  {!ordersByGroup[r.key] && (nextByGroup[r.key]?.left ?? 0) > 0.05 && <span className="block font-semibold" style={{ color: '#8A6A2F' }}>{vi ? `${W(nextByGroup[r.key].po)} ${nextByGroup[r.key].seq}: cần ${fmt1(nextByGroup[r.key].left)} kg${nextByGroup[r.key].by ? ` trước ${dOr(nextByGroup[r.key].by, Lx)}` : ''}` : `${W(nextByGroup[r.key].po)} ${nextByGroup[r.key].seq}: ${fmt1(nextByGroup[r.key].left)} kg needed${nextByGroup[r.key].by ? ` by ${dOr(nextByGroup[r.key].by, Lx)}` : ''}`}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {sheet && (
        // Bottom sheet — phone-first, big targets.
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }} onClick={() => !saving && setSheet(false)}>
          <div className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-4 pb-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="text-base font-bold">{vi ? 'Sản xuất thêm — OEM' : 'Extra production — OEM'}</div>
              <button onClick={() => setSheet(false)} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ backgroundColor: '#F3F4F6' }}><X size={18} /></button>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-bold" style={{ color: '#6B7280' }}>{vi ? 'Sản phẩm' : 'Product'}</div>
              <div className="grid grid-cols-2 gap-2">
                {rows.map(r => (
                  <button key={r.key} onClick={() => { setGk(r.key); setOrd(null); }}
                    className="rounded-xl px-3 py-3 text-sm font-semibold text-left leading-tight"
                    style={gk === r.key ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#F7F5F0', color: '#111827', border: '1px solid #EFE9DC' }}>
                    {r.name}
                    <span className="block text-[10px] font-normal mt-1" style={{ opacity: 0.65 }}>{r.skus.join(' · ')}</span>
                  </button>
                ))}
              </div>
            </div>
            {selNote && (
              <div className="rounded-xl px-3 py-2 text-xs font-semibold whitespace-pre-line leading-snug" style={{ backgroundColor: '#FFF7E6', border: '1px solid #F3E3C0', color: '#5B4520' }}>{selNote}</div>
            )}
            {selPlan && sel && selPlan.sched.length > 1 && (
              <div className="space-y-1.5">
                <div className="text-xs font-bold" style={{ color: '#6B7280' }}>{vi ? 'Nướng cho đơn nào?' : 'Baked for which order?'}</div>
                <div className="grid grid-cols-2 gap-2">
                  {selPlan.sched.map(x => {
                    const n = x.need.find(y => y.key === sel.key);
                    return (
                      <button key={x.b.row.id} onClick={() => setOrd(x.b.row.seq)}
                        className="rounded-xl px-3 py-3 text-sm font-bold text-left leading-tight"
                        style={ord === x.b.row.seq ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#F7F5F0', color: '#111827', border: '1px solid #EFE9DC' }}>
                        {W(true)} {x.b.row.seq} · {fmt(x.b.kg)} kg
                        <span className="block text-[11px] font-normal mt-1" style={{ opacity: 0.75 }}>
                          {n && n.left > 0.05 ? `${vi ? 'còn' : 'left'} ${fmt1(n.left)} / ${fmt1(n.cum)} kg` : (vi ? 'đã nướng đủ ✓' : 'fully baked ✓')}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <div className="text-xs font-bold" style={{ color: '#6B7280' }}>{vi ? 'Khối lượng đã nướng (kg)' : 'Weight produced (kg)'}</div>
              <div className="flex items-center gap-2">
                <input inputMode="decimal" autoFocus value={kg} onChange={e => setKg(e.target.value.replace(/[^0-9.,]/g, ''))} placeholder="0"
                  className="flex-1 rounded-xl px-4 py-3 text-2xl font-bold text-right" style={{ border: '2px solid #D1D5DB' }} />
                <span className="text-lg font-bold" style={{ color: '#6B7280' }}>kg</span>
              </div>
              {sel && kgNum > 0 && sel.weights.length > 0 && (
                <div className="text-xs" style={{ color: '#6B7280' }}>
                  ≈ {sel.weights.map(w => `${Math.floor((kgNum * 1000) / w).toLocaleString('en-US')} × ${w} g`).join(vi ? ' hoặc ' : ' or ')}
                  {sel.weights.length > 1 ? (vi ? ' (chọn khi đóng gói)' : ' (chosen at packaging)') : ''}
                </div>
              )}
            </div>
            <button onClick={saveProd} disabled={saving || !sel || !(kgNum > 0) || kgNum > 2000 || (!!selPlan && ordEff == null)}
              className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-bold text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}{vi ? 'Lưu' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
