'use client';
import { useMemo, useState } from 'react';
import type { StockCategoryGroup, StockLevel } from './actions';

// Station Analytics › Lab stock, reorganised (Axel, 2026-11-11: "optimiser pour que ce soit visible
// et pratique, met pas tout à la suite"). Instead of one long list:
//   1. summary chips (to produce / OK / no threshold),
//   2. "To produce" block on top — every item under its safety threshold, all categories,
//   3. one folding card per category, items as a 2-column tile grid (qty big, gauge vs threshold),
//   4. a search box and an "alerts only" switch.
// Threshold editing is unchanged (same server action), just a small tap on the tile.

const DARK = '#2A1810', RED = '#B42318', AMBER = '#B45309', MUTED = '#6B5A4C', GOLD = '#C9A84C';

const shortName = (n: string) => n.replace(/^\s*Bánh\s+/i, '').trim();
const isLow = (s: StockLevel) => s.found && s.threshold != null && s.qty < s.threshold;

export default function LabStockPanel({ stock, lang, userName, onThresholdSaved }: {
  stock: StockCategoryGroup[]; lang: 'vi' | 'en'; userName: string | null;
  onThresholdSaved: (sku: string, threshold: number) => void;
}) {
  const vi = lang === 'vi';
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAllLow, setShowAllLow] = useState(false);

  const all = useMemo(() => stock.flatMap(g => g.items.map(i => ({ ...i, category: g.category }))), [stock]);
  const low = all.filter(isLow).sort((a, b) => (a.qty / (a.threshold || 1)) - (b.qty / (b.threshold || 1)));
  const okCount = all.filter(i => i.found && i.threshold != null && !isLow(i)).length;
  const noThreshold = all.filter(i => i.threshold == null).length;
  const q = query.trim().toLowerCase();
  const match = (s: StockLevel) => !q || s.name.toLowerCase().includes(q) || s.sku.toLowerCase().includes(q);

  async function save(sku: string) {
    const val = parseFloat(draft);
    if (!Number.isFinite(val) || val < 0) return;
    setSaving(true);
    const { setStockThresholdAction } = await import('./actions');
    const res = await setStockThresholdAction(sku, val, userName);
    setSaving(false);
    if (!res.error) { onThresholdSaved(sku, val); setEdit(null); }
  }

  const gauge = (s: StockLevel) => {
    if (s.threshold == null || !s.found) return <div className="h-1.5 rounded-full" style={{ background: '#F0E8DB' }} />;
    const max = Math.max(s.threshold * 2, s.qty, 1);
    const w = Math.max(0, Math.min(100, (s.qty / max) * 100));
    const t = Math.min(100, (s.threshold / max) * 100);
    return (
      <div className="relative h-1.5 rounded-full" style={{ background: '#F0E8DB' }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${w}%`, background: isLow(s) ? RED : '#572C1A' }} />
        <div className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded" style={{ left: `${t}%`, background: GOLD }} />
      </div>
    );
  };

  // Plain render functions (not nested components): a nested component would remount on every
  // keystroke and the threshold input would lose focus.
  const thresholdControl = (s: StockLevel) => {
    if (edit === s.sku) return (
      <span className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <input type="number" inputMode="numeric" value={draft} onChange={e => setDraft(e.target.value)} autoFocus
          className="w-14 text-center rounded-md px-1 py-0.5 text-[12px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ border: '1px solid #D9CBB8' }} />
        <button onClick={() => save(s.sku)} disabled={saving} className="text-[10px] font-bold px-2 py-0.5 rounded-full disabled:opacity-50"
          style={{ backgroundColor: DARK, color: '#F6F1EA' }}>OK</button>
      </span>
    );
    return (
      <button onClick={() => { setEdit(s.sku); setDraft(s.threshold != null ? String(s.threshold) : ''); }}
        className="text-[10px] underline decoration-dotted" style={{ color: MUTED }}>
        {s.threshold != null ? `${vi ? 'Ngưỡng' : 'Min'} ${s.threshold}` : (vi ? '+ ngưỡng' : '+ min')}
      </button>
    );
  };

  const qtyColor = (s: StockLevel) => !s.found ? AMBER : s.qty < 0 ? AMBER : isLow(s) ? RED : DARK;

  return (
    <div className="rounded-2xl bg-white p-4 space-y-3" style={{ border: '1px solid #E6DCCF' }}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-xs" style={{ color: DARK }}>{vi ? 'Tồn kho Lab' : 'Lab stock'}</div>
          <div className="text-[10px] mt-0.5" style={{ color: MUTED }}>{vi ? 'Trực tiếp từ Odoo (kho LAB)' : 'Live from Odoo (LAB warehouse)'}</div>
        </div>
        <div className="flex gap-1.5 flex-wrap justify-end">
          <span className="text-[10.5px] font-bold rounded-full px-2 py-0.5" style={{ background: low.length ? '#FBEAE8' : '#E8F2EB', color: low.length ? RED : '#572C1A' }}>
            {low.length} {vi ? 'cần SX' : 'to produce'}
          </span>
          <span className="text-[10.5px] font-bold rounded-full px-2 py-0.5" style={{ background: '#E8F2EB', color: '#572C1A' }}>{okCount} OK</span>
          {noThreshold > 0 && <span className="text-[10.5px] rounded-full px-2 py-0.5" style={{ background: '#F5F3EA', color: MUTED }}>{noThreshold} {vi ? 'chưa ngưỡng' : 'no min'}</span>}
        </div>
      </div>

      {low.length > 0 && (
        <div className="rounded-xl p-3" style={{ background: '#FEF6F5', border: '1px solid #F8D3CF' }}>
          <div className="text-[10.5px] font-extrabold tracking-wide mb-2" style={{ color: RED }}>{vi ? 'CẦN SẢN XUẤT' : 'TO PRODUCE'}</div>
          <div className="space-y-2">
            {(showAllLow ? low : low.slice(0, 6)).map(s => (
              <div key={s.sku} className="grid items-center gap-2" style={{ gridTemplateColumns: '1fr 86px' }}>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold truncate" style={{ color: DARK }}>{shortName(s.name)}</div>
                  <div className="text-[10px]" style={{ color: MUTED }}>{s.category}</div>
                </div>
                <div className="text-right">
                  <div className="text-[13px] font-extrabold" style={{ color: RED }}>{s.qty}<span className="text-[10.5px] font-semibold" style={{ color: MUTED }}> / {s.threshold}</span></div>
                  <div className="text-[10px] font-bold" style={{ color: RED }}>{vi ? `thiếu ${Math.max(0, (s.threshold ?? 0) - s.qty)}` : `need ${Math.max(0, (s.threshold ?? 0) - s.qty)}`}</div>
                </div>
              </div>
            ))}
          </div>
          {low.length > 6 && (
            <button onClick={() => setShowAllLow(v => !v)} className="mt-2 text-[11px] font-bold" style={{ color: RED }}>
              {showAllLow ? (vi ? 'Thu gọn' : 'Show less') : (vi ? `Xem tất cả (${low.length})` : `Show all (${low.length})`)}
            </button>
          )}
        </div>
      )}

      <div className="flex gap-2 items-center">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={vi ? 'Tìm sản phẩm…' : 'Search a product…'}
          className="flex-1 min-w-0 rounded-lg px-3 py-1.5 text-[12.5px]" style={{ border: '1px solid #E6DCCF', background: '#FFFCF3' }} />
        <button onClick={() => setAlertsOnly(v => !v)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-bold"
          style={alertsOnly ? { background: RED, color: '#FFFFFF' } : { background: '#FFFFFF', color: MUTED, border: '1px solid #E6DCCF' }}>
          {vi ? 'Chỉ cảnh báo' : 'Alerts only'}
        </button>
      </div>

      {stock.map(g => {
        const items = g.items.filter(match).filter(s => !alertsOnly || isLow(s) || !s.found || s.qty < 0);
        if (!items.length) return null;
        const lowN = g.items.filter(isLow).length;
        const total = g.items.reduce((sum, s) => sum + (s.found && s.qty > 0 ? s.qty : 0), 0);
        const isOpen = open[g.category] ?? (!!q || alertsOnly);
        return (
          <div key={g.category} className="rounded-xl overflow-hidden" style={{ border: '1px solid #EFE6BF' }}>
            <button onClick={() => setOpen(o => ({ ...o, [g.category]: !isOpen }))} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" style={{ background: '#FFFCF3' }}>
              <span className="flex-1 text-[12.5px] font-extrabold uppercase tracking-wide" style={{ color: '#92600A' }}>{g.category}</span>
              {lowN > 0 && <span className="text-[10.5px] font-bold rounded-full px-1.5 py-0.5" style={{ background: '#FBEAE8', color: RED }}>{lowN} ⚠</span>}
              <span className="text-[11px]" style={{ color: MUTED }}>{g.items.length} · {total.toLocaleString('en-US').replace(/,/g, ' ')} {vi ? 'cái' : 'pcs'}</span>
              <span className="text-lg font-bold inline-block transition-transform" style={{ color: GOLD, transform: `rotate(${isOpen ? 90 : 0}deg)` }}>›</span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-2 gap-2 p-2.5">
                {items.map(s => (
                  <div key={s.sku} className="rounded-lg p-2 flex flex-col gap-1.5" style={{ background: isLow(s) ? '#FEF6F5' : '#FFFFFF', border: `1px solid ${isLow(s) ? '#F8D3CF' : '#F0E8DB'}` }}>
                    <div className="text-[11.5px] font-semibold leading-tight line-clamp-2" style={{ color: DARK, minHeight: 28 }}>{shortName(s.name)}</div>
                    <div className="flex items-end justify-between">
                      <span className="text-[18px] font-black leading-none" style={{ color: qtyColor(s) }}>{s.found ? s.qty : '—'}</span>
                      {thresholdControl(s)}
                    </div>
                    {gauge(s)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
