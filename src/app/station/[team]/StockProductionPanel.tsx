'use client';
// Production tab for teams that only make storable products (Axel, 2026-10-23 — Team Hung first).
// Same EXTRA production as the "+ Extra" pop-up (one done card per entry, sent to stock the usual
// way, same Odoo MO) — only the screen changes: low-stock list, one category at a time, product
// cards with photo + live Lab stock, and a number pad for the batch size (big batches).
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Package, Plus, RotateCcw, X } from 'lucide-react';
import type { StockProduct } from './actions';

const GREEN = '#1A4731', GOLD = '#92600A', BORDER = '#E0D49A', RED = '#DC2626', AMBER = '#D97706';

export type TodayExtra = { id: string; name: string; qty: number; transferred: boolean };

export default function StockProductionPanel({
  team, lang, readOnly, extras, onRecord, onUndo, onSendStock, sendableCount,
}: {
  team: string;
  lang: 'vi' | 'en';
  readOnly: boolean;
  extras: TodayExtra[];
  onRecord: (p: StockProduct, qty: number) => Promise<boolean>;
  onUndo: (id: string) => Promise<boolean>;
  onSendStock: () => void;
  sendableCount: number;
}) {
  const L = (vi: string, en: string) => (lang === 'vi' ? vi : en);
  const [products, setProducts] = useState<StockProduct[] | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [cat, setCat] = useState<string>('Macaron');
  const [err, setErr] = useState<string | null>(null);
  const [pad, setPad] = useState<StockProduct | null>(null);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const { getStockProductionCatalogAction } = await import('./actions');
      const r = await getStockProductionCatalogAction(team);
      if (r.error) { setErr(r.error); return; }
      setProducts(r.products ?? []);
      const c = r.categories ?? [];
      setCats(c);
      setCat(prev => (c.includes(prev) ? prev : c[0] ?? prev));
      setErr(null);
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }
  useEffect(() => { load(); }, [team]); // eslint-disable-line react-hooks/exhaustive-deps

  const low = useMemo(() => (products ?? []).filter(p => p.stock != null && p.threshold != null && p.stock < p.threshold)
    .sort((a, b) => (a.stock! / a.threshold!) - (b.stock! / b.threshold!)), [products]);
  const shown = (products ?? []).filter(p => p.category === cat);
  const name = (p: StockProduct) => (lang === 'vi' ? p.nameVi : p.nameEn || p.nameVi);
  const todayTotal = extras.reduce((s, x) => s + x.qty, 0);

  async function confirm(qty: number) {
    if (!pad || !(qty > 0) || busy) return;
    setBusy(true);
    const ok = await onRecord(pad, qty);
    setBusy(false);
    if (ok) {
      setMsg(L(`Đã ghi: ${name(pad)} ×${qty}`, `Recorded: ${name(pad)} ×${qty}`));
      setProducts(ps => ps ? ps.map(p => p.variantId === pad.variantId ? { ...p, lastBatch: qty } : p) : ps);
      setPad(null); setVal('');
      setTimeout(() => setMsg(null), 3000);
    } else setMsg(L('Lỗi khi ghi — thử lại', 'Could not record — try again'));
  }
  const key = (k: string) => setVal(v => (k === '⌫' ? v.slice(0, -1) : (v + k).replace(/^0+/, '').slice(0, 5)));

  return (
    <div className="space-y-3">
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: '#FBEAE8', color: RED }}>{err}</div>}

      {/* Low stock — only products under their safety level */}
      {low.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#FEF3C7', border: '1px solid #F0C96A' }}>
          <div className="flex items-center justify-between px-3 py-2.5 text-sm font-bold" style={{ color: GOLD }}>
            <span className="flex items-center gap-1.5"><AlertTriangle size={15} /> {L('Tồn kho thấp', 'Low stock')}</span>
            <span className="text-[11px]">{low.length} · {L('dưới mức an toàn', 'under safety level')}</span>
          </div>
          {low.map(p => {
            const pct = Math.max(4, Math.min(100, (p.stock! / p.threshold!) * 100));
            return (
              <div key={p.sku} className="px-3 py-2" style={{ borderTop: '1px solid #F0EAD0' }}>
                <div className="flex justify-between text-[13px] font-bold" style={{ color: GREEN }}>
                  <span className="truncate pr-2">{name(p)}</span>
                  <span className="shrink-0 text-[12px]" style={{ color: '#6B6455' }}>{Math.round(p.stock!)} / {L('an toàn', 'safety')} {Math.round(p.threshold!)}</span>
                </div>
                <div className="h-1.5 rounded-full mt-1.5" style={{ backgroundColor: '#F0EAD0' }}>
                  <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: pct < 50 ? RED : AMBER }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* One category at a time — Macaron by default */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        {cats.map(c => {
          const n = (products ?? []).filter(p => p.category === c).length;
          return (
            <button key={c} onClick={() => setCat(c)}
              className="shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap"
              style={c === cat ? { backgroundColor: GOLD, color: '#fff', border: `1px solid ${GOLD}` } : { backgroundColor: '#fff', color: GREEN, border: `1px solid ${BORDER}` }}>
              {c} · {n}
            </button>
          );
        })}
      </div>

      {products === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm" style={{ color: '#6B6455' }}><Loader2 size={16} className="animate-spin" /> {L('Đang tải…', 'Loading…')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {shown.map(p => {
            const isLow = p.stock != null && p.threshold != null && p.stock < p.threshold;
            return (
              <div key={p.sku} className="rounded-2xl bg-white p-2 flex flex-col gap-1" style={{ border: `1px solid ${BORDER}` }}>
                {p.imageUrl
                  ? <img src={p.imageUrl} alt="" loading="lazy" className="w-full h-20 rounded-xl object-cover" style={{ backgroundColor: '#FFF4CC' }} />
                  : <div className="w-full h-20 rounded-xl flex items-center justify-center text-2xl" style={{ backgroundColor: '#FFF4CC' }}>🍪</div>}
                <div className="text-[12.5px] font-bold leading-tight" style={{ color: GREEN }}>{name(p)}</div>
                <div className="text-[11px] font-semibold" style={{ color: isLow ? RED : '#6B6455' }}>
                  {L('Tồn', 'Stock')} {p.stock == null ? '—' : Math.round(p.stock)}{isLow ? ` · ${L('thấp', 'low')}` : ''}
                </div>
                {!readOnly && (
                  <button onClick={() => { setPad(p); setVal(''); }}
                    className="mt-auto flex items-center justify-center gap-1 rounded-xl py-2 text-[12.5px] font-bold text-white active:scale-95 transition-all"
                    style={{ backgroundColor: GREEN }}>
                    <Plus size={14} /> {L('Sản xuất', 'Produce')}
                  </button>
                )}
                {p.lastBatch != null && <div className="text-[10.5px] text-center" style={{ color: GOLD }}>{L('Mẻ trước', 'Last batch')} {p.lastBatch}</div>}
              </div>
            );
          })}
          {!shown.length && <div className="col-span-full text-center text-sm py-6" style={{ color: '#6B6455' }}>{L('Không có sản phẩm', 'No product')}</div>}
        </div>
      )}

      {/* Today's extra production + undo + send to stock */}
      {extras.length > 0 && (
        <div className="rounded-xl bg-white px-3 py-2 text-[12.5px]" style={{ border: `1px solid ${BORDER}`, color: GREEN }}>
          <div className="flex items-start justify-between gap-2">
            <span>{L('Sản xuất thêm hôm nay', "Today's extra production")}: {extras.slice(-4).map((x, i) => <b key={x.id} style={{ fontWeight: i === extras.slice(-4).length - 1 ? 800 : 600 }}>{i ? ' · ' : ' '}{x.name} ×{x.qty}</b>)}{extras.length > 4 ? ` +${extras.length - 4}` : ''}</span>
            {!readOnly && !extras[extras.length - 1].transferred && (
              <button disabled={busy} onClick={async () => { setBusy(true); await onUndo(extras[extras.length - 1].id); setBusy(false); }}
                className="shrink-0 flex items-center gap-1 text-[12px] font-bold" style={{ color: '#B91C1C' }}>
                <RotateCcw size={12} /> {L('Hoàn tác', 'Undo last')}
              </button>
            )}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: '#6B6455' }}>{L('Tổng', 'Total')} {todayTotal}</div>
        </div>
      )}
      {!readOnly && sendableCount > 0 && (
        <button onClick={onSendStock} className="w-full rounded-2xl py-3 text-white font-bold text-sm flex items-center justify-center gap-2" style={{ backgroundColor: GREEN }}>
          <Package size={16} /> {L('Nhập kho', 'Send to stock')} · {sendableCount}
        </button>
      )}
      {msg && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold text-center" style={{ backgroundColor: '#E7F3EA', color: GREEN }}>{msg}</div>}

      {/* Number pad — batch size */}
      {pad && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,.35)' }} onClick={() => !busy && setPad(null)}>
          <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div className="font-bold text-[15px]" style={{ color: GREEN }}>{name(pad)} · {L('làm được bao nhiêu?', 'how many made?')}</div>
              <button onClick={() => setPad(null)} aria-label="close" style={{ color: '#9CA3AF' }}><X size={18} /></button>
            </div>
            <div className="text-center text-4xl font-black py-1" style={{ color: GREEN }}>{val || '0'}</div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0'].map(k => (
                <button key={k} onClick={() => key(k)} className="rounded-xl py-3 text-lg font-bold flex items-center justify-center active:scale-95" style={{ backgroundColor: '#FFF4CC', color: GREEN }}>
                  {k}
                </button>
              ))}
              <button disabled={busy || !(Number(val) > 0)} onClick={() => confirm(Number(val))}
                className="rounded-xl py-3 text-lg font-bold text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
                {busy ? '…' : 'OK'}
              </button>
            </div>
            {pad.lastBatch != null && (
              <button disabled={busy} onClick={() => confirm(pad.lastBatch!)} className="w-full rounded-xl py-2.5 text-sm font-bold" style={{ border: `1px solid ${BORDER}`, color: GREEN }}>
                {L('Giống mẻ trước', 'Same as last batch')} ({pad.lastBatch})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
