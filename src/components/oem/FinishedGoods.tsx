'use client';
import { useMemo, useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { Card, Title, Banner, Chip, Btn, inputCls, inputStyle } from './ui';
import { fmt, dmy, unitLabel, localToday, MUTED, FAINT, GREEN, type Client, type Derived, type FgCount, type Item, type LFn } from './model';

// Inventory → Finished goods. Theoretical stock = packed − delivered − faulty bags. Weekly count in
// bags (kg for cashews); the gap vs theoretical is flagged. Nothing here changes operations.
export default function FinishedGoods({ clients, items, d, counts, canCount, userId, userName, reload, L }: {
  clients: Client[]; items: Item[]; d: Derived; counts: FgCount[]; canCount: boolean; userId: string | null; userName: string | null;
  reload: () => Promise<void>; L: LFn;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [date, setDate] = useState(localToday());
  const [val, setVal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const last: Record<string, FgCount> = {};
  for (const c of counts) if (!last[c.sku] || c.count_date > last[c.sku].count_date || (c.count_date === last[c.sku].count_date && c.created_at > last[c.sku].created_at)) last[c.sku] = c;
  const dates = Array.from(new Set(counts.map(c => c.count_date))).sort().reverse().slice(0, 6);
  const filled = Object.entries(val).filter(([, v]) => v.trim() !== '' && !isNaN(Number(v.replace(',', '.'))));

  async function save() {
    setBusy(true); setMsg(null);
    // one count per product per day — a re-count the same day replaces it
    const skus = filled.map(([s]) => s);
    await supabase.from('lab_mm_fg_counts').delete().eq('count_date', date).in('sku', skus);
    const { error } = await supabase.from('lab_mm_fg_counts').insert(filled.map(([sku, v]) => ({
      count_date: date, sku, qty_counted: Number(v.replace(',', '.')), qty_theoretical: Math.round((d.fgTheo[sku] ?? 0) * 1000) / 1000,
      created_by: userId, created_by_name: userName,
    })));
    setBusy(false);
    if (error) { setMsg({ ok: false, t: error.message }); return; }
    setVal({}); setMsg({ ok: true, t: L('Đã lưu kiểm kê.', 'Count saved.') }); await reload();
  }

  return (
    <div className="space-y-4">
      <Banner>{L('Kiểm kê — đếm hàng thực tế mỗi tuần. App so sánh với tồn lý thuyết và báo chênh lệch. Không ảnh hưởng sản xuất hay đóng gói.',
        'Inventory — count what is physically there, once a week. The app compares with the theoretical stock and flags gaps. Nothing here changes production or packaging.')}</Banner>

      <Card className="overflow-hidden">
        <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-2" style={{ backgroundColor: '#FCFBF8' }}>
          <Title>{L('Tồn thành phẩm', 'Finished-goods stock')}</Title>
          {canCount && (
            <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
              {L('Ngày kiểm', 'Count date')} <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
          )}
        </div>
        <div className="hidden sm:grid grid-cols-12 text-[10px] font-bold uppercase px-3 py-1.5" style={{ color: FAINT, borderTop: '1px solid #F3F4F6' }}>
          <span className="col-span-4">{L('Sản phẩm', 'Product')}</span>
          <span className="col-span-1 text-right">{L('Đã gói', 'Packed')}</span>
          <span className="col-span-1 text-right">{L('Đã giao', 'Deliv.')}</span>
          <span className="col-span-1 text-right">{L('Lỗi', 'Faulty')}</span>
          <span className="col-span-2 text-right">{L('Tồn lý thuyết', 'Theoretical')}</span>
          <span className="col-span-3 text-right">{canCount ? L('Đếm được', 'Counted') : L('Lần kiểm gần nhất', 'Last count')}</span>
        </div>
        {clients.map(c => (
          <div key={c.name}>
            <div className="px-3 py-1 text-[11px] font-bold" style={{ color: GREEN, borderTop: '1px solid #F3F4F6', backgroundColor: '#FAFAF9' }}>{c.name}</div>
            {c.groups.flatMap(g => g.items).map(i => {
              const theo = d.fgTheo[i.sku] ?? 0; const lc = last[i.sku];
              const gap = lc ? Number(lc.qty_counted) - Number(lc.qty_theoretical ?? 0) : 0;
              const dec = i.unit === 'kg' ? 1 : 0;
              return (
                <div key={i.sku} className="grid grid-cols-12 items-center gap-y-1 px-3 py-1.5 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
                  <span className="col-span-12 sm:col-span-4 truncate font-semibold">{i.product_name} <span className="font-normal" style={{ color: FAINT }}>· {unitLabel(i, L)}</span></span>
                  <span className="col-span-3 sm:col-span-1 sm:text-right" style={{ color: MUTED }}>{fmt(d.packedQty[i.sku] ?? 0, dec)}</span>
                  <span className="col-span-3 sm:col-span-1 sm:text-right" style={{ color: MUTED }}>{fmt(d.deliveredQty[i.sku] ?? 0, dec)}</span>
                  <span className="col-span-2 sm:col-span-1 sm:text-right" style={{ color: MUTED }}>{fmt(d.scrapFinished[i.sku] ?? 0, dec)}</span>
                  <span className="col-span-4 sm:col-span-2 text-right font-bold">{fmt(theo, dec)}</span>
                  <span className="col-span-12 sm:col-span-3 flex items-center justify-end gap-1.5">
                    {lc && (
                      <span className="text-[10px]" style={{ color: FAINT }}>
                        {dmy(lc.count_date)}: {fmt(Number(lc.qty_counted), dec)}{' '}
                        {Math.abs(gap) > 0.0005 ? <Chip tone={gap < 0 ? 'red' : 'amber'}>{gap > 0 ? '+' : ''}{fmt(gap, dec)}</Chip> : <Chip tone="green">OK</Chip>}
                      </span>
                    )}
                    {canCount && (
                      <input inputMode="decimal" placeholder="—" value={val[i.sku] ?? ''} onChange={e => setVal(v => ({ ...v, [i.sku]: e.target.value.replace(/[^0-9.,]/g, '') }))}
                        className="w-20 rounded-lg px-2 py-1 text-sm font-bold text-right" style={inputStyle} />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {canCount && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
            <Btn primary onClick={save} disabled={busy || !filled.length}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu kiểm kê', 'Save count')} {filled.length ? `(${filled.length})` : ''}</Btn>
            <span className="text-[11px]" style={{ color: FAINT }}>{L('Đếm số gói (kg với hạt điều). Tồn lý thuyết = đã gói − đã giao − gói lỗi.', 'Count bags (kg for cashews). Theoretical = packed − delivered − faulty bags.')}</span>
            {msg && <span className="text-xs font-semibold" style={{ color: msg.ok ? '#059669' : '#DC2626' }}>{msg.t}</span>}
          </div>
        )}
      </Card>

      {dates.length > 0 && (
        <div className="space-y-1.5">
          <Title>{L('Các lần kiểm gần đây', 'Recent counts')}</Title>
          <Card className="overflow-hidden">
            {dates.map(dt => {
              const rows = counts.filter(c => c.count_date === dt);
              const gaps = rows.filter(r => Math.abs(Number(r.qty_counted) - Number(r.qty_theoretical ?? 0)) > 0.0005).length;
              return (
                <div key={dt} className="flex items-center gap-3 px-3 py-2 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
                  <span className="w-[70px]" style={{ color: MUTED }}>{dmy(dt)}</span>
                  <span className="flex-1">{rows.length} {L('sản phẩm', 'products')} · {Array.from(new Set(rows.map(r => r.created_by_name).filter(Boolean))).join(', ')}</span>
                  {gaps ? <Chip tone="amber">{gaps} {L('chênh lệch', 'gap(s)')}</Chip> : <Chip tone="green">OK</Chip>}
                </div>
              );
            })}
          </Card>
        </div>
      )}
    </div>
  );
}
