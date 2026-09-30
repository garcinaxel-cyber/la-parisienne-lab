'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Factory, Loader2, RefreshCw, Plus, X, Check } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import { buildBatches, dOr, type PlanRow } from '@/components/oem/plan';
import { MM_CLIENT, type Item } from '@/components/oem/model';

// Station side of the OEM Orders tracker (Axel, 2026-09-25: "Hung devrait avoir accès qu'à ça").
// Team Hung only needs one thing: per product, kg baked vs kg to bake. Packaging, deliveries and
// inventories and tracking stay on the office page (/oem-orders, admin + assistants).
type Row = { key: string; name: string; group: string; target: number; remake: number; pending: number; baked: number; sort: number; skus: string[]; weights: number[]; kgUnit: boolean };
type Entry = { id: string; group_key: string; weight_kg: number; created_at: string; created_by_name: string | null; status: string; received_kg: number | null };
const GREEN = '#1A4731';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
// Real product name without the pack size ("Bánh quy socola nho khô 80g" → "Bánh quy socola nho khô"),
// so the 80 g / 100 g formats that share one bulk read as one product with both SKUs.
const baseName = (n: string) => n.replace(/\s*\(kg\)\s*$/i, '').replace(/\s+\d+\s*g$/i, '').trim();

export default function StationOemView({ role, userId, userName }: { role: string; userId: string | null; userName: string | null }) {
  const { lang, setLang } = useI18n();
  const vi = lang === 'vi';
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [allItems, setAllItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [delivered, setDelivered] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [today, setToday] = useState<Entry[]>([]);
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
    const [it, pl, pk, dp, dl] = await Promise.all([
      supabase.from('lab_mm_order_items').select('sku, product_name, group_key, group_name, unit, unit_weight_g, qty_ordered, sort_order, client_name').eq('is_active', true).order('sort_order'),
      supabase.from('lab_mm_production_log').select('id, group_key, weight_kg, prod_date, created_at, created_by_name, status, received_kg').order('created_at', { ascending: false }),
      supabase.from('lab_mm_packaging_log').select('kind, sku, group_key, qty').in('kind', ['scrap_bulk', 'scrap_finished']),
      supabase.from('lab_mm_delivery_plan').select('id, client_name, seq, delivery_date, pct, label, qty').order('seq'),
      supabase.rpc('lab_mm_deliveries'),
    ]);
    const dq: Record<string, number> = {};
    for (const x of (dl.data ?? []) as any[]) if (x.order_status === 'validated' && !x.not_delivered && x.qty_checked != null) dq[x.sku] = (dq[x.sku] ?? 0) + Number(x.qty_checked);
    setDelivered(dq);
    setAllItems(((it.data ?? []) as any[]).map(i => ({ ...i, unit_weight_g: Number(i.unit_weight_g), qty_ordered: Number(i.qty_ordered) })) as Item[]);
    setPlan(((dp.data ?? []) as any[]).map(r => ({ ...r, pct: Number(r.pct) })) as PlanRow[]);
    if (it.error || pl.error) setErr((it.error || pl.error)!.message);
    const m = new Map<string, Row>();
    for (const i of it.data ?? []) {
      const r: Row = m.get(i.group_key) ?? { key: i.group_key, name: baseName(i.product_name), group: i.group_name, target: 0, remake: 0, pending: 0, baked: 0, sort: i.sort_order, skus: [] as string[], weights: [] as number[], kgUnit: i.unit === 'kg' };
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
      if (l.status === 'received') r.baked += Number(l.received_kg ?? 0); else { r.baked += Number(l.weight_kg); r.pending += Number(l.weight_kg); }
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
    setToday(((pl.data ?? []) as any[]).filter(l => l.prod_date === iso).map(l => ({ ...l, weight_kg: Number(l.weight_kg), received_kg: l.received_kg == null ? null : Number(l.received_kg) })));
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
      const batches = buildBatches(items, plan.filter(p => (p.client_name || MM_CLIENT) === client));
      const sched = batches.map(b => {
        const need = Object.entries(b.cumKgByGroup).map(([g, kg]) => {
          const r = byKey[g]; const left = r ? Math.max(0, kg + r.remake - r.baked) : kg;
          return { key: g, name: r?.name ?? g, cum: kg, left };
        });
        const left = need.reduce((s, x) => s + x.left, 0);
        const shipped = items.every(i => (delivered[i.sku] ?? 0) >= (b.cumQty[i.sku] ?? 0) - 0.0005);
        return { b, need, left, done: left < 0.05, shipped };
      });
      const kgUnits = items.every(i => i.unit === 'kg');
      const total = items.reduce((s, i) => s + i.qty_ordered, 0);
      const done = items.reduce((s, i) => s + Math.min(i.qty_ordered, delivered[i.sku] ?? 0), 0);
      return { client, items, sched, nextIdx: sched.findIndex(x => !x.done), kgUnits, total, done };
    }).filter(p => p.sched.length);
  }, [allItems, plan, rows, delivered]);
  // the chef can open any delivery (tap on the timeline); default = the next one not baked yet
  const [pick, setPick] = useState<Record<string, number>>({});
  const shownOf = (p: { client: string; sched: unknown[]; nextIdx: number }) => (pick[p.client] != null && pick[p.client] < p.sched.length ? pick[p.client] : p.nextIdx);
  const daysTo = (iso: string) => Math.round((Date.parse(iso) - Date.parse(isoToday)) / 86400000);
  const Lx = (v: string, e: string) => (vi ? v : e);
  // hint under each product row: the delivery shown in its client's plan
  const nextByGroup = useMemo(() => {
    const m: Record<string, { left: number; seq: number; by: string | null }> = {};
    for (const p of plans) { const k = shownOf(p); const x = k >= 0 ? p.sched[k] : null; if (x) for (const n of x.need) m[n.key] = { left: n.left, seq: x.b.row.seq, by: x.b.produceBy }; }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, pick]);

  // same rule as the station: workers/viewers are read-only
  const canLog = ['admin', 'lab_manager', 'assistant', 'chef'].includes(role);
  const sel = rows.find(r => r.key === gk);
  const kgNum = Number(kg.replace(',', '.')) || 0;

  async function saveProd() {
    if (!sel || !(kgNum > 0) || kgNum > 2000) return;
    setSaving(true); setErr(null);
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    const { error } = await supabase.from('lab_mm_production_log').insert({
      prod_date: d.toISOString().slice(0, 10), group_key: sel.key, sku: sel.skus[0] ?? null,
      weight_kg: Math.round(kgNum * 1000) / 1000, created_by: userId, created_by_name: userName,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setSheet(false); setKg(''); setGk('');
    setFlash(`+${kgNum} kg · ${sel.name}`); setTimeout(() => setFlash(null), 3500);
    await load();
  }

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
            {today.map(t => (
              <div key={t.id} className="flex items-center justify-between px-4 py-2.5 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
                <span className="font-semibold">{rows.find(r => r.key === t.group_key)?.name ?? t.group_key}</span>
                <span className="text-right">
                  <b>{t.weight_kg} kg</b> <span className="text-xs" style={{ color: '#9CA3AF' }}>· {new Date(t.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="block text-[11px] font-semibold" style={{ color: t.status === 'received' ? '#047857' : '#B45309' }}>
                    {t.status === 'received' ? `${vi ? 'Đã nhận' : 'Received'} ${t.received_kg} kg` : (vi ? 'Chờ trợ lý nhận' : 'Waiting for reception')}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {plans.map(p => {
          const shownIdx = shownOf(p); const next = shownIdx >= 0 ? p.sched[shownIdx] : null;
          const u = p.kgUnits ? 'kg' : (vi ? 'gói' : 'bags');
          return (
          <div key={p.client} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            <div className="px-4 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{vi ? 'Kế hoạch nướng' : 'Baking plan'} · {p.client.replace('CÔNG TY CỔ PHẦN ', '')}</div>
            {next ? (() => {
              const dl = next.b.produceBy ? daysTo(next.b.produceBy) : null; const late = dl != null && dl < 0 && !next.done;
              return (
                <div className="px-4 pb-3 space-y-2">
                  <div className="rounded-xl px-3 py-2.5" style={{ backgroundColor: next.done ? '#ECFDF5' : late ? '#FEF2F2' : dl != null && dl <= 7 ? '#FFF7E6' : '#F7F5F0' }}>
                    <div className="text-[15px] font-bold" style={{ color: next.done ? '#047857' : late ? '#B91C1C' : '#111827' }}>
                      {next.done
                        ? (vi ? `Đợt ${next.b.row.seq}: đã nướng đủ ✓` : `Delivery ${next.b.row.seq}: fully baked ✓`)
                        : next.b.produceBy
                          ? (vi ? `Đợt ${next.b.row.seq}: nướng xong trước ${dOr(next.b.produceBy, Lx)}` : `Delivery ${next.b.row.seq}: bake by ${dOr(next.b.produceBy, Lx)}`)
                          : (vi ? `Đợt ${next.b.row.seq}: chưa có ngày giao` : `Delivery ${next.b.row.seq}: date not given yet`)}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                      {vi ? `Giao ${dOr(next.b.row.delivery_date, Lx)} · ${fmt(next.b.cumPct)}% đơn hàng (cộng dồn)` : `Ship ${dOr(next.b.row.delivery_date, Lx)} · ${fmt(next.b.cumPct)}% of the order (cumulative)`}
                      {!next.done && <>{' · '}<b>{fmt1(next.left)} kg</b> {vi ? 'còn thiếu' : 'left'}{dl != null && <>{' · '}{late ? (vi ? `trễ ${-dl} ngày` : `${-dl} days late`) : (vi ? `còn ${dl} ngày` : `${dl} days left`)}</>}</>}
                    </div>
                  </div>
                  {next.need.map(x => (
                    <div key={x.key} className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-semibold min-w-0 truncate">{x.name}</span>
                      <span className="whitespace-nowrap">
                        {x.left > 0.05 ? <b>{vi ? 'còn' : 'left'} {fmt1(x.left)} kg</b> : <b style={{ color: '#047857' }}>✓</b>}
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
            <div className="px-4 pb-3 flex gap-1.5 overflow-x-auto">
              {p.sched.map((x, k) => (
                <button key={x.b.row.id} onClick={() => setPick(s => ({ ...s, [p.client]: k }))} className="shrink-0 rounded-lg px-2.5 py-1.5 text-center active:scale-95 transition"
                  style={{ minWidth: 84, backgroundColor: x.done ? '#ECFDF5' : k === p.nextIdx ? '#FFF7E6' : '#F9FAFB', border: k === shownIdx ? `2px solid ${GREEN}` : `1px solid ${x.done ? '#A7F3D0' : k === p.nextIdx ? '#F3E3C0' : '#EFE9DC'}` }}>
                  <div className="text-[11px] font-bold" style={{ color: k === shownIdx ? GREEN : '#6B7280' }}>{vi ? 'Đợt' : 'Delivery'} {x.b.row.seq} · {fmt(x.b.kg)} kg</div>
                  <div className="text-[11px] font-bold" style={{ color: x.done ? '#047857' : '#111827' }}>{x.done ? (vi ? '✓ đã nướng' : '✓ baked') : x.b.produceBy ? `${vi ? 'Nướng trước' : 'Bake by'} ${dOr(x.b.produceBy, Lx)}` : (vi ? 'Chưa có ngày' : 'Date TBC')}</div>
                  <div className="text-[10px] font-semibold" style={{ color: x.shipped ? '#047857' : '#9CA3AF' }}>{x.shipped ? (vi ? '✓ đã giao' : '✓ shipped') : `${vi ? 'Giao' : 'Ship'} ${dOr(x.b.row.delivery_date, Lx)}`}</div>
                </button>
              ))}
            </div>
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
                  {(nextByGroup[r.key]?.left ?? 0) > 0.05 && <span className="block font-semibold" style={{ color: '#8A6A2F' }}>{vi ? `Đợt ${nextByGroup[r.key].seq}: cần ${fmt1(nextByGroup[r.key].left)} kg${nextByGroup[r.key].by ? ` trước ${dOr(nextByGroup[r.key].by, Lx)}` : ''}` : `Delivery ${nextByGroup[r.key].seq}: ${fmt1(nextByGroup[r.key].left)} kg needed${nextByGroup[r.key].by ? ` by ${dOr(nextByGroup[r.key].by, Lx)}` : ''}`}</span>}
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
                  <button key={r.key} onClick={() => setGk(r.key)}
                    className="rounded-xl px-3 py-3 text-sm font-semibold text-left leading-tight"
                    style={gk === r.key ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#F7F5F0', color: '#111827', border: '1px solid #EFE9DC' }}>
                    {r.name}
                    <span className="block text-[10px] font-normal mt-1" style={{ opacity: 0.65 }}>{r.skus.join(' · ')}</span>
                  </button>
                ))}
              </div>
            </div>
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
            <button onClick={saveProd} disabled={saving || !sel || !(kgNum > 0) || kgNum > 2000}
              className="w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-base font-bold text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}{vi ? 'Lưu' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
