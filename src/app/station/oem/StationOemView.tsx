'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Factory, Loader2, RefreshCw, Plus, X, Check } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

// Station side of the OEM Orders tracker (Axel, 2026-09-25: "Hung devrait avoir accès qu'à ça").
// Team Hung only needs one thing: per product, kg baked vs kg to bake. Packaging, deliveries and
// inventories and tracking stay on the office page (/oem-orders, admin + assistants).
type Row = { key: string; name: string; group: string; target: number; baked: number; sort: number; skus: string[]; weights: number[]; kgUnit: boolean };
type Entry = { id: string; group_key: string; weight_kg: number; created_at: string; created_by_name: string | null };
const GREEN = '#1A4731';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
// Real product name without the pack size ("Bánh quy socola nho khô 80g" → "Bánh quy socola nho khô"),
// so the 80 g / 100 g formats that share one bulk read as one product with both SKUs.
const baseName = (n: string) => n.replace(/\s*\(kg\)\s*$/i, '').replace(/\s+\d+\s*g$/i, '').trim();

export default function StationOemView({ role, userId, userName }: { role: string; userId: string | null; userName: string | null }) {
  const { lang, setLang } = useI18n();
  const vi = lang === 'vi';
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
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
    const [it, pl] = await Promise.all([
      supabase.from('lab_mm_order_items').select('sku, product_name, group_key, group_name, unit, unit_weight_g, qty_ordered, sort_order').eq('is_active', true),
      supabase.from('lab_mm_production_log').select('id, group_key, weight_kg, prod_date, created_at, created_by_name').order('created_at', { ascending: false }),
    ]);
    if (it.error || pl.error) setErr((it.error || pl.error)!.message);
    const m = new Map<string, Row>();
    for (const i of it.data ?? []) {
      const r: Row = m.get(i.group_key) ?? { key: i.group_key, name: baseName(i.product_name), group: i.group_name, target: 0, baked: 0, sort: i.sort_order, skus: [] as string[], weights: [] as number[], kgUnit: i.unit === 'kg' };
      r.skus.push(i.sku); if (i.unit !== 'kg') r.weights.push(Number(i.unit_weight_g));
      r.target += i.unit === 'kg' ? Number(i.qty_ordered) : (Number(i.qty_ordered) * Number(i.unit_weight_g)) / 1000;
      r.sort = Math.min(r.sort, i.sort_order);
      m.set(i.group_key, r);
    }
    for (const l of pl.data ?? []) { const r = m.get(l.group_key); if (r) r.baked += Number(l.weight_kg); }
    setRows(Array.from(m.values()).sort((a, b) => a.sort - b.sort));
    const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); const iso = d.toISOString().slice(0, 10);
    setToday(((pl.data ?? []) as any[]).filter(l => l.prod_date === iso).map(l => ({ ...l, weight_kg: Number(l.weight_kg) })));
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

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
                <span><b>{t.weight_kg} kg</b> <span className="text-xs" style={{ color: '#9CA3AF' }}>· {new Date(t.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{t.created_by_name ? ` · ${t.created_by_name}` : ''}</span></span>
              </div>
            ))}
          </div>
        )}
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          {loading && !rows.length ? (
            <div className="flex justify-center py-10"><Loader2 className="animate-spin" style={{ color: GREEN }} /></div>
          ) : rows.map(r => {
            const pct = r.target ? Math.min(100, (r.baked / r.target) * 100) : 0;
            const done = r.target > 0 && r.baked >= r.target;
            return (
              // Phone-first (the team works on phones only): name + kg on one line, full-width bar below.
              <div key={r.key} className="px-4 py-3.5 space-y-2" style={{ borderTop: '1px solid #F3F4F6' }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{r.name}</span>
                    <span className="block text-[11px] mt-0.5" style={{ color: '#9CA3AF' }}>{r.skus.join(' · ')}</span>
                  </span>
                  <span className="text-[15px] whitespace-nowrap" style={{ color: '#111827' }}>
                    <b>{fmt(r.baked)}</b><span style={{ color: '#9CA3AF' }}> / {fmt(r.target)} kg</span>
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="flex-1 h-3 rounded-full overflow-hidden" style={{ backgroundColor: '#EFE9DC' }}>
                    <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: done ? '#059669' : '#8FB3A0' }} />
                  </span>
                  <span className="w-11 text-right text-sm font-semibold" style={{ color: done ? '#059669' : '#6B7280' }}>{Math.round(pct)}%</span>
                </div>
                <div className="text-xs" style={{ color: '#9CA3AF' }}>
                  {done ? (vi ? 'Đã đủ ✓' : 'Done ✓') : `${vi ? 'Còn lại' : 'Left'}: ${fmt(Math.max(0, r.target - r.baked))} kg`}
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
