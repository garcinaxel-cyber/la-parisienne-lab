'use client';
// Production tab for teams that only make storable products (Axel, 2026-10-23 — Team Hung first).
// Same EXTRA production as the "+ Extra" pop-up (one done card per entry, sent to stock the usual
// way, same Odoo MO) — only the screen changes: low-stock list, one category at a time, product
// cards with photo + live Lab stock, and a number pad for the batch size (big batches).
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpDown, Loader2, Package, Plus, RotateCcw, Search, X } from 'lucide-react';
import type { StockProduct } from './actions';

const CACAO = '#2A1810', BROWN = '#572C1A', GOLD = '#C9A84C', GOLD_INK = '#8A6418', BORDER = '#E6DCCF', IVORY = '#F6F1EA', MUTED = '#6B5A4C', RED = '#B42318', AMBER = '#B7791F';
const GREEN = CACAO;
type Sort = 'default' | 'low' | 'az';

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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('default'); // default = the order chefs already know
  const [lowOnly, setLowOnly] = useState(false);

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
  const name = (p: StockProduct) => (lang === 'vi' ? p.nameVi : p.nameEn || p.nameVi);
  const isLowP = (p: StockProduct) => p.stock != null && p.threshold != null && p.stock < p.threshold;
  const ratio = (p: StockProduct) => (p.stock != null && p.threshold ? p.stock / p.threshold : 99);
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const q = norm(query.trim());
  // A search looks in every category; otherwise one category at a time, as before.
  const base = (products ?? []).filter(p => q
    ? norm(`${p.nameVi} ${p.nameEn ?? ''} ${p.sku}`).includes(q)
    : lowOnly ? isLowP(p) : p.category === cat);
  const shown = sort === 'low' ? [...base].sort((a, b) => ratio(a) - ratio(b))
    : sort === 'az' ? [...base].sort((a, b) => name(a).localeCompare(name(b)))
    : lowOnly && !q ? [...base].sort((a, b) => ratio(a) - ratio(b)) : base;
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

  const Photo = ({ p, className }: { p: StockProduct; className: string }) => p.imageUrl
    ? <img src={p.imageUrl} alt="" loading="lazy" className={`${className} object-cover`} style={{ backgroundColor: '#EFE6D8' }} />
    : <div className={`${className} flex items-center justify-center`} style={{ background: 'linear-gradient(135deg,#EFE6D8,#E6DCCF)' }}>
        <span className="lp-display text-2xl font-bold" style={{ color: '#B9A58C' }}>{name(p).replace(/^(Bánh|Banh)\s+/i, '').charAt(0)}</span>
      </div>;
  const sortLabel = sort === 'default' ? L('Mặc định', 'Default') : sort === 'low' ? L('Thấp trước', 'Low first') : 'A–Z';

  return (
    <div className="space-y-4">
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: '#FBEAE8', color: RED }}>{err}</div>}

      {/* Hero — the three numbers a stock team looks at, then search */}
      <section className="rounded-3xl px-4 pt-4 pb-4 relative overflow-hidden lp-rise"
        style={{ background: `radial-gradient(120% 90% at 100% 0%, rgba(201,168,76,.22), transparent 60%), ${CACAO}`, color: '#fff' }}>
        <div className="text-[10.5px] font-bold tracking-[0.18em] uppercase" style={{ color: GOLD }}>{L('Sản xuất nhập kho', 'Stock production')}</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[
            [products ? String(products.length) : '—', L('sản phẩm', 'products'), '#fff'],
            [products ? String(low.length) : '—', L('tồn thấp', 'low stock'), low.length ? '#F3B8A8' : '#fff'],
            [String(todayTotal), L('làm hôm nay', 'made today'), '#E9D3A4'],
          ].map(([n, label, color]) => (
            <div key={label}>
              <div className="lp-display text-[30px] leading-none font-bold" style={{ color }}>{n}</div>
              <div className="text-[11px] mt-1" style={{ color: 'rgba(255,255,255,.72)' }}>{label}</div>
            </div>
          ))}
        </div>
        <label className="mt-3.5 flex items-center gap-2 rounded-2xl px-3 h-11" style={{ backgroundColor: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.16)' }}>
          <Search size={16} style={{ color: 'rgba(255,255,255,.7)' }} />
          <input value={query} onChange={e => setQuery(e.target.value)} inputMode="search" enterKeyHint="search"
            placeholder={L('Tìm sản phẩm hoặc mã…', 'Search a product or code…')}
            className="flex-1 min-w-0 bg-transparent outline-none text-[14px] text-white placeholder:text-white/50" />
          {query && <button onClick={() => setQuery('')} aria-label="clear" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ backgroundColor: 'rgba(255,255,255,.16)' }}><X size={14} /></button>}
        </label>
      </section>

      {/* Today — what was made, undo, send to stock */}
      {(extras.length > 0 || (!readOnly && sendableCount > 0)) && (
        <section className="rounded-2xl bg-white p-3 lp-rise" style={{ border: `1px solid ${BORDER}` }}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold tracking-[0.14em] uppercase" style={{ color: GOLD_INK }}>{L('Hôm nay', 'Today')} · {todayTotal}</span>
            {!readOnly && extras.length > 0 && !extras[extras.length - 1].transferred && (
              <button disabled={busy} onClick={async () => { setBusy(true); await onUndo(extras[extras.length - 1].id); setBusy(false); }}
                className="flex items-center gap-1 text-[12px] font-bold px-2 py-1 rounded-lg lp-press" style={{ color: RED }}>
                <RotateCcw size={12} /> {L('Hoàn tác', 'Undo last')}
              </button>
            )}
          </div>
          {extras.length > 0 && (
            <div className="mt-2 flex gap-1.5 overflow-x-auto no-scrollbar">
              {[...extras].reverse().map(x => (
                <span key={x.id} className="shrink-0 rounded-full pl-2.5 pr-2 py-1 text-[12px] font-semibold flex items-center gap-1.5"
                  style={{ backgroundColor: IVORY, color: CACAO, border: `1px solid ${BORDER}` }}>
                  <span className="max-w-[150px] truncate">{x.name}</span>
                  <b className="rounded-full px-1.5 text-[11px]" style={{ backgroundColor: x.transferred ? '#E3EFE6' : '#F3E7C8', color: x.transferred ? '#256A45' : GOLD_INK }}>×{x.qty}</b>
                </span>
              ))}
            </div>
          )}
          {!readOnly && sendableCount > 0 && (
            <button onClick={onSendStock} className="mt-3 w-full rounded-xl h-12 font-bold text-sm flex items-center justify-center gap-2 lp-press"
              style={{ backgroundColor: GOLD, color: CACAO, boxShadow: '0 6px 16px rgba(201,168,76,.35)' }}>
              <Package size={16} /> {L('Nhập kho', 'Send to stock')} · {sendableCount}
            </button>
          )}
        </section>
      )}

      {/* To restock — products under their safety level, tap = produce */}
      {low.length > 0 && !q && (
        <section className="lp-rise">
          <div className="flex items-center justify-between px-0.5 pb-2">
            <span className="flex items-center gap-1.5 text-[13px] font-bold" style={{ color: CACAO }}>
              <AlertTriangle size={15} style={{ color: RED }} /> {L('Cần làm thêm', 'To restock')}
              <span className="rounded-full px-2 py-0.5 text-[11px] font-black text-white" style={{ backgroundColor: RED }}>{low.length}</span>
            </span>
            <button onClick={() => setLowOnly(v => !v)} className="text-[12px] font-bold px-2.5 py-1 rounded-full lp-press"
              style={lowOnly ? { backgroundColor: CACAO, color: '#fff' } : { color: BROWN, border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
              {lowOnly ? L('Xem tất cả sản phẩm', 'Back to all') : L('Chỉ xem tồn thấp', 'Show only these')}
            </button>
          </div>
          {!lowOnly && (
            <div className="flex gap-2.5 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1 snap-x">
              {low.map(p => {
                const pct = Math.max(4, Math.min(100, (p.stock! / p.threshold!) * 100));
                return (
                  <button key={p.sku} disabled={readOnly} onClick={() => { setPad(p); setVal(''); }}
                    className="snap-start shrink-0 w-[168px] rounded-2xl bg-white p-2.5 text-left lp-press" style={{ border: `1px solid ${BORDER}` }}>
                    <div className="flex items-center gap-2.5">
                      <Photo p={p} className="w-12 h-12 rounded-xl shrink-0" />
                      <div className="min-w-0">
                        <div className="lp-display text-[20px] leading-none font-bold" style={{ color: pct < 50 ? RED : AMBER }}>
                          {Math.round(p.stock!)}<span className="text-[12px] font-semibold" style={{ color: MUTED, fontFamily: 'inherit' }}> / {Math.round(p.threshold!)}</span>
                        </div>
                        <div className="h-1.5 rounded-full mt-1.5 w-[84px]" style={{ backgroundColor: '#EFE6D8' }}>
                          <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: pct < 50 ? RED : AMBER }} />
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 text-[12.5px] font-bold leading-tight lp-clamp2 min-h-[32px]" style={{ color: CACAO }}>{name(p)}</div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Categories + sort — sticks under the header while the list scrolls */}
      <div className="sticky top-[52px] sm:top-[104px] z-10 -mx-4 px-4 py-2" style={{ backgroundColor: 'rgba(246,241,234,.94)', backdropFilter: 'blur(8px)' }}>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex gap-2 overflow-x-auto no-scrollbar">
            {q ? (
              <span className="text-[13px] font-bold py-1.5" style={{ color: CACAO }}>{shown.length} {L('kết quả', shown.length === 1 ? 'result' : 'results')}</span>
            ) : lowOnly ? (
              <span className="text-[13px] font-bold py-1.5" style={{ color: CACAO }}>{L('Tồn thấp', 'Low stock')} · {shown.length}</span>
            ) : cats.map(c => {
              const n = (products ?? []).filter(p => p.category === c).length;
              return (
                <button key={c} onClick={() => setCat(c)}
                  className="shrink-0 px-3.5 h-9 rounded-full text-[12.5px] font-bold whitespace-nowrap lp-press"
                  style={c === cat ? { backgroundColor: CACAO, color: '#fff' } : { backgroundColor: '#fff', color: CACAO, border: `1px solid ${BORDER}` }}>
                  {c} <span style={{ opacity: .6 }}>{n}</span>
                </button>
              );
            })}
          </div>
          <button onClick={() => setSort(s => (s === 'default' ? 'low' : s === 'low' ? 'az' : 'default'))}
            title={L('Sắp xếp', 'Sort')}
            className="shrink-0 h-9 px-3 rounded-full text-[12px] font-bold flex items-center gap-1.5 lp-press"
            style={sort === 'default' ? { backgroundColor: '#fff', color: BROWN, border: `1px solid ${BORDER}` } : { backgroundColor: '#F3E7C8', color: GOLD_INK, border: `1px solid ${GOLD}` }}>
            <ArrowUpDown size={14} /> {sortLabel}
          </button>
        </div>
      </div>

      {products === null ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="rounded-3xl h-[228px] animate-pulse" style={{ backgroundColor: '#EFE6D8' }} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {shown.map((p, i) => {
            const isLow = isLowP(p);
            const pct = p.stock != null && p.threshold ? Math.max(4, Math.min(100, (p.stock / (p.threshold * 2)) * 100)) : null;
            return (
              <article key={p.sku} className="rounded-3xl bg-white overflow-hidden flex flex-col lp-rise"
                style={{ border: `1px solid ${isLow ? '#E8B4A8' : BORDER}`, boxShadow: '0 1px 2px rgba(42,24,16,.04), 0 8px 20px rgba(42,24,16,.05)', animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <div className="relative">
                  <Photo p={p} className="w-full aspect-[4/3]" />
                  <span className="absolute left-2 top-2 rounded-full pl-2 pr-2.5 h-7 flex items-center gap-1.5 text-[12px] font-bold"
                    style={{ backgroundColor: isLow ? RED : 'rgba(42,24,16,.82)', color: '#fff', backdropFilter: 'blur(4px)' }}>
                    {isLow && <AlertTriangle size={12} />}
                    <span className="opacity-75 font-semibold">{L('Tồn', 'Stock')}</span>
                    {p.stock == null ? '—' : Math.round(p.stock)}
                  </span>
                </div>
                <div className="px-3 pt-2.5 pb-3 flex flex-col gap-2 flex-1">
                  <div className="text-[13.5px] font-bold leading-snug lp-clamp2 min-h-[37px]" style={{ color: CACAO }}>{name(p)}</div>
                  {pct != null && (
                    <div className="flex items-center gap-2">
                      <div className="h-1 rounded-full flex-1" style={{ backgroundColor: '#EFE6D8' }}>
                        <div className="h-1 rounded-full" style={{ width: `${pct}%`, backgroundColor: isLow ? RED : '#8FB39A' }} />
                      </div>
                      <span className="text-[10.5px] font-semibold shrink-0" style={{ color: MUTED }}>{L('an toàn', 'min')} {Math.round(p.threshold!)}</span>
                    </div>
                  )}
                  {!readOnly && (
                    <button onClick={() => { setPad(p); setVal(''); }}
                      className="mt-auto h-11 rounded-2xl flex items-center justify-center gap-1.5 text-[13.5px] font-bold text-white lp-press"
                      style={{ backgroundColor: CACAO }}>
                      <Plus size={16} style={{ color: GOLD }} /> {L('Sản xuất', 'Produce')}
                    </button>
                  )}
                  <div className="text-[11px] text-center -mt-0.5" style={{ color: MUTED }}>
                    {p.lastBatch != null ? <>{L('Mẻ trước', 'Last batch')} <b style={{ color: GOLD_INK }}>{p.lastBatch}</b></> : <span style={{ opacity: .5 }}>—</span>}
                  </div>
                </div>
              </article>
            );
          })}
          {!shown.length && (
            <div className="col-span-full text-center py-10">
              <div className="text-sm font-bold" style={{ color: CACAO }}>{L('Không tìm thấy sản phẩm', 'No product found')}</div>
              {q && <button onClick={() => setQuery('')} className="mt-2 text-[13px] font-bold underline" style={{ color: BROWN }}>{L('Xoá tìm kiếm', 'Clear search')}</button>}
            </div>
          )}
        </div>
      )}

      {/* Confirmation — floats above the tab bar so it is seen wherever the list is scrolled */}
      {msg && (
        <div className="fixed inset-x-4 bottom-[78px] sm:bottom-6 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-40 rounded-2xl px-4 py-3 text-[13.5px] font-bold text-center lp-pop"
          style={{ backgroundColor: CACAO, color: '#fff', boxShadow: '0 12px 28px rgba(42,24,16,.35)', borderBottom: `3px solid ${GOLD}` }}>{msg}</div>
      )}

      {/* Number pad — batch size */}
      {pad && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center lp-overlay" style={{ backgroundColor: 'rgba(31,18,12,.55)' }} onClick={() => !busy && setPad(null)}>
          <div className="w-full sm:max-w-sm rounded-t-[28px] sm:rounded-[28px] p-4 pb-[max(16px,env(safe-area-inset-bottom))] space-y-3 lp-sheet" style={{ backgroundColor: IVORY }} onClick={e => e.stopPropagation()}>
            <div className="mx-auto w-10 h-1 rounded-full sm:hidden" style={{ backgroundColor: '#D9CBB8' }} />
            <div className="flex items-center gap-3">
              <Photo p={pad} className="w-14 h-14 rounded-2xl shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-bold text-[15px] leading-tight lp-clamp2" style={{ color: CACAO }}>{name(pad)}</div>
                <div className="text-[12px] mt-0.5" style={{ color: MUTED }}>{L('Tồn', 'Stock')} {pad.stock == null ? '—' : Math.round(pad.stock)}{pad.threshold != null ? ` · ${L('an toàn', 'min')} ${Math.round(pad.threshold)}` : ''}</div>
              </div>
              <button onClick={() => setPad(null)} aria-label="close" className="w-10 h-10 rounded-full flex items-center justify-center bg-white" style={{ color: CACAO, border: `1px solid ${BORDER}` }}><X size={18} /></button>
            </div>
            <div className="rounded-2xl bg-white py-3 text-center" style={{ border: `1px solid ${BORDER}` }}>
              <div className="text-[11px] font-bold tracking-[0.14em] uppercase" style={{ color: GOLD_INK }}>{L('Làm được bao nhiêu?', 'How many made?')}</div>
              <div className="lp-display text-[52px] leading-none font-bold mt-1" style={{ color: val ? CACAO : '#C9BBA7' }}>{val || '0'}</div>
            </div>
            {pad.lastBatch != null && (
              <button disabled={busy} onClick={() => confirm(pad.lastBatch!)} className="w-full rounded-2xl h-12 text-[13.5px] font-bold lp-press"
                style={{ border: `1px solid ${GOLD}`, color: GOLD_INK, backgroundColor: '#FBF4E1' }}>
                {L('Giống mẻ trước', 'Same as last batch')} · {pad.lastBatch}
              </button>
            )}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0'].map(k => (
                <button key={k} onClick={() => key(k)} className="rounded-2xl h-14 text-xl font-bold flex items-center justify-center bg-white lp-press" style={{ color: CACAO, border: `1px solid ${BORDER}` }}>
                  {k}
                </button>
              ))}
              <button disabled={busy || !(Number(val) > 0)} onClick={() => confirm(Number(val))}
                className="rounded-2xl h-14 text-lg font-bold disabled:opacity-40 lp-press flex items-center justify-center" style={{ backgroundColor: CACAO, color: '#fff' }}>
                {busy ? <Loader2 size={18} className="animate-spin" /> : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
