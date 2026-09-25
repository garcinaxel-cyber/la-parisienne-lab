'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Factory, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

// Station side of the OEM Orders tracker (Axel, 2026-09-25: "Hung devrait avoir accès qu'à ça").
// Team Hung only needs one thing: per product, kg baked vs kg to bake. Packaging, deliveries and
// inventories stay on the office page (/oem-orders) — staff opening the station get a link there.
type Row = { key: string; name: string; target: number; baked: number; sort: number };
const GREEN = '#1A4731';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export default function StationOemView({ role }: { role: string; userId: string | null; userName: string | null }) {
  const { lang, setLang } = useI18n();
  const vi = lang === 'vi';
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // back to the station the user came from (?team=hung from the QR, or 'me' for the chef)
  const [back, setBack] = useState('/station/me');
  useEffect(() => { const t = new URLSearchParams(window.location.search).get('team'); if (t && /^[a-z_]+$/.test(t)) setBack(`/station/${t}`); }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const [it, pl] = await Promise.all([
      supabase.from('lab_mm_order_items').select('group_key, group_name, unit, unit_weight_g, qty_ordered, sort_order').eq('is_active', true),
      supabase.from('lab_mm_production_log').select('group_key, weight_kg'),
    ]);
    if (it.error || pl.error) setErr((it.error || pl.error)!.message);
    const m = new Map<string, Row>();
    for (const i of it.data ?? []) {
      const r = m.get(i.group_key) ?? { key: i.group_key, name: i.group_name, target: 0, baked: 0, sort: i.sort_order };
      r.target += i.unit === 'kg' ? Number(i.qty_ordered) : (Number(i.qty_ordered) * Number(i.unit_weight_g)) / 1000;
      r.sort = Math.min(r.sort, i.sort_order);
      m.set(i.group_key, r);
    }
    for (const l of pl.data ?? []) { const r = m.get(l.group_key); if (r) r.baked += Number(l.weight_kg); }
    setRows(Array.from(m.values()).sort((a, b) => a.sort - b.sort));
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const staff = ['admin', 'lab_manager', 'assistant'].includes(role);

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
                  <span className="text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{r.name}</span>
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
        <div className="text-[11px] sm:text-xs" style={{ color: '#9CA3AF' }}>
          {vi ? 'Nhập sản lượng bằng nút "Sản xuất thêm" (kg) như thường lệ.' : 'Enter what you bake with the usual "Extra production" button (kg).'}
        </div>
        {staff && (
          <Link href="/oem-orders" className="inline-flex items-center gap-1 text-xs font-bold underline" style={{ color: GREEN }}>
            {vi ? 'Mở trang theo dõi đầy đủ' : 'Open the full tracker'} <ExternalLink size={11} />
          </Link>
        )}
      </div>
    </div>
  );
}
