'use client';
// Production tab for teams that only make storable products (Axel, 2026-10-23 — Team Hung first).
// Same EXTRA production as the "+ Extra" pop-up (one done card per entry, sent to stock the usual
// way, same Odoo MO) — only the screen changes: low-stock list, one category at a time, product
// cards with photo + live Lab stock, and a number pad for the batch size (big batches).
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpDown, Loader2, Package, Plus, RotateCcw, Search, X } from 'lucide-react';
import type { StockProduct } from './actions';

const CACAO = '#2A1810', BROWN = '#572C1A', GOLD = '#C9A84C', GOLD_INK = '#8A6418', BORDER = '#E6DCCF', IVORY = '#F6F1EA', MUTED = '#6B5A4C', RED = '#B42318', AMBER = '#B7791F';
const GREEN = CACAO;
type Sort = 'default' | 'low' | 'az';

export type TodayExtra = { id: string; name: string; qty: number; transferred: boolean; by?: string | null; at?: string | null; imageUrl?: string | null };

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
  const [allBatches, setAllBatches] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

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

  const hhmm = (iso?: string | null) => { try { return iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }) : ''; } catch { return ''; } };
  const batches = [...extras].reverse();
  const onRack = extras.filter(x => !x.transferred).length;
  const shownBatches = allBatches ? batches : batches.slice(0, 3);

  return (
    <div className="space-y-3">
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: '#FBEAE8', color: RED }}>{err}</div>}

      {/* Made today — the day's batches live here (what the Done tab used to hold for a stock team) */}
      <section className="rounded-[26px] px-4 pt-4 pb-2 lp-rise" style={{ backgroundColor: CACAO, color: '#fff' }}>
        <div className="text-[10.5px] font-bold tracking-[0.18em] uppercase" style={{ color: '#D9B36A' }}>{L('Làm hôm nay', 'Made today')}</div>
        <div className="mt-1 flex items-end justify-between gap-3">
          <div className="lp-display text-[46px] leading-none font-bold">{todayTotal}</div>
          <div className="text-[12.5px] pb-1.5 text-right" style={{ color: 'rgba(255,255,255,.72)' }}>
            {extras.length} {L('mẻ', extras.length === 1 ? 'batch' : 'batches')} · {onRack} {L('chờ nhập kho', 'on the rack')}
          </div>
        </div>
        {batches.length === 0 ? (
          <div className="mt-3 pb-3 text-[12.5px]" style={{ color: 'rgba(255,255,255,.6)', borderTop: '1px solid rgba(255,255,255,.12)', paddingTop: 12 }}>
            {L('Chưa có mẻ nào hôm nay. Chạm + bên dưới để ghi.', 'No batch yet today. Tap + on a product below.')}
          </div>
        ) : (
          <div className="mt-3">
            {shownBatches.map((x, i) => (
              <div key={x.id} className="flex items-center gap-3 py-2.5" style={{ borderTop: '1px solid rgba(255,255,255,.12)' }}>
                {x.imageUrl
                  ? <img src={x.imageUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" style={{ backgroundColor: '#3A251A' }} />
                  : <div className="w-10 h-10 rounded-full shrink-0" style={{ backgroundColor: '#3A251A' }} />}
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-bold truncate">{x.name}</div>
                  <div className="text-[10px] font-bold tracking-[0.06em] uppercase truncate" style={{ color: x.transferred ? '#8FD3A4' : '#E9C46A' }}>
                    {x.transferred ? L('Đã nhập kho Lab', 'In Lab stock') : L('Trên kệ', 'On the rack')}{x.by ? ` · ${x.by}` : ''}{x.at ? ` · ${hhmm(x.at)}` : ''}
                  </div>
                </div>
                <div className="lp-display text-[19px] font-bold shrink-0">×{x.qty}</div>
                {!readOnly && i === 0 && !allBatches && !x.transferred && (
                  <button disabled={busy} onClick={async () => { setBusy(true); await onUndo(x.id); setBusy(false); }}
                    title={L('Hoàn tác', 'Undo last')} aria-label={L('Hoàn tác', 'Undo last')}
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 lp-press" style={{ backgroundColor: 'rgba(255,255,255,.1)', color: '#F3B8A8' }}>
                    <RotateCcw size={15} />
                  </button>
                )}
              </div>
            ))}
            {batches.length > 3 && (
              <button onClick={() => setAllBatches(v => !v)} className="w-full py-2.5 text-[12px] font-bold" style={{ color: '#D9B36A', borderTop: '1px solid rgba(255,255,255,.12)' }}>
                {allBatches ? L('Thu gọn', 'Show less') : L(`Xem cả ${batches.length} mẻ`, `See all ${batches.length} batches`)}
              </button>
            )}
          </div>
        )}
        {!readOnly && sendableCount > 0 && (
          <button onClick={onSendStock} className="mb-2 mt-1 w-full rounded-2xl h-12 font-bold text-sm flex items-center justify-center gap-2 lp-press"
            style={{ backgroundColor: GOLD, color: CACAO }}>
            <Package size={16} /> {L('Nhập kho', 'Send to stock')} · {sendableCount}
          </button>
        )}
      </section>

      {/* One line for low stock — tap to see only those, every family together */}
      {low.length > 0 && (
        <button onClick={() => { setLowOnly(v => !v); setQuery(''); }} className="w-full rounded-2xl px-4 h-[58px] flex items-center gap-3 text-left lp-press lp-rise"
          style={lowOnly ? { backgroundColor: CACAO, color: '#fff' } : { backgroundColor: '#F4E3DC', border: '1px solid #EBCFC5', color: CACAO }}>
          <span className="lp-display text-[24px] font-bold leading-none" style={{ color: lowOnly ? '#F3B8A8' : RED }}>{low.length}</span>
          <span className="flex-1 min-w-0">
            <span className="block text-[13.5px] font-bold leading-tight">{L('sản phẩm dưới mức tối thiểu', 'products under their minimum')}</span>
            <span className="block text-[11.5px] mt-0.5" style={{ opacity: .7 }}>{lowOnly ? L('Chạm để xem lại tất cả', 'Tap to go back to all products') : L('Chạm để chỉ xem các sản phẩm này', 'Tap to see only these, all families together')}</span>
          </span>
          {lowOnly && <X size={16} />}
        </button>
      )}

      {/* Families + search — sticks under the header while the list scrolls */}
      <div className="sticky top-[52px] sm:top-[100px] z-10 -mx-4 px-4 py-2" style={{ backgroundColor: 'rgba(246,241,234,.95)', backdropFilter: 'blur(8px)' }}>
        {searchOpen ? (
          <label className="flex items-center gap-2 rounded-full px-3.5 h-10 bg-white" style={{ border: `1px solid ${BORDER}` }}>
            <Search size={16} style={{ color: MUTED }} />
            <input autoFocus value={query} onChange={e => setQuery(e.target.value)} inputMode="search" enterKeyHint="search"
              placeholder={L('Tìm sản phẩm hoặc mã…', 'Search a product or code…')}
              className="flex-1 min-w-0 bg-transparent outline-none text-[14px]" style={{ color: CACAO }} />
            <button onClick={() => { setQuery(''); setSearchOpen(false); }} aria-label="close" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ backgroundColor: IVORY, color: CACAO }}><X size={14} /></button>
          </label>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 flex gap-2 overflow-x-auto no-scrollbar">
              {lowOnly ? (
                <span className="text-[13px] font-bold h-10 flex items-center" style={{ color: CACAO }}>{L('Dưới mức tối thiểu', 'Under minimum')} · {shown.length}</span>
              ) : cats.map(c => {
                const n = (products ?? []).filter(p => p.category === c).length;
                return (
                  <button key={c} onClick={() => setCat(c)}
                    className="shrink-0 px-4 h-10 rounded-full text-[13px] font-bold whitespace-nowrap lp-press"
                    style={c === cat ? { backgroundColor: CACAO, color: '#fff' } : { backgroundColor: '#fff', color: CACAO, border: `1px solid ${BORDER}` }}>
                    {c} · {n}
                  </button>
                );
              })}
            </div>
            <button onClick={() => setSort(s => (s === 'default' ? 'low' : s === 'low' ? 'az' : 'default'))} title={L('Sắp xếp', 'Sort') + ' · ' + sortLabel} aria-label={L('Sắp xếp', 'Sort')}
              className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center lp-press"
              style={sort === 'default' ? { backgroundColor: '#fff', color: BROWN, border: `1px solid ${BORDER}` } : { backgroundColor: '#F3E7C8', color: GOLD_INK, border: `1px solid ${GOLD}` }}>
              <ArrowUpDown size={16} />
            </button>
            <button onClick={() => setSearchOpen(true)} aria-label={L('Tìm', 'Search')} className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-white lp-press" style={{ color: BROWN, border: `1px solid ${BORDER}` }}>
              <Search size={16} />
            </button>
          </div>
        )}
        {sort !== 'default' && !searchOpen && <div className="text-[11px] font-semibold mt-1.5" style={{ color: GOLD_INK }}>{L('Sắp xếp', 'Sorted')}: {sortLabel}</div>}
      </div>

      {/* Product rows — stock number, gauge with the minimum marked, last batch, one + button */}
      {products === null ? (
        <div className="rounded-[26px] bg-white overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[72px] animate-pulse" style={{ borderTop: i ? `1px solid #F0E8DB` : undefined, backgroundColor: i % 2 ? '#FBF7F0' : '#fff' }} />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-10">
          <div className="text-sm font-bold" style={{ color: CACAO }}>{L('Không tìm thấy sản phẩm', 'No product found')}</div>
          {q && <button onClick={() => setQuery('')} className="mt-2 text-[13px] font-bold underline" style={{ color: BROWN }}>{L('Xoá tìm kiếm', 'Clear search')}</button>}
        </div>
      ) : (
        <div className="rounded-[26px] bg-white overflow-hidden lp-rise" style={{ border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(42,24,16,.05)' }}>
          {shown.map((p, i) => {
            const isLow = isLowP(p);
            const hasMin = p.stock != null && p.threshold != null && p.threshold > 0;
            const scale = hasMin ? Math.max(p.stock!, p.threshold!) * 1.3 : 1;
            const fill = hasMin ? Math.max(0, Math.min(100, (p.stock! / scale) * 100)) : 0;
            const mark = hasMin ? Math.min(100, (p.threshold! / scale) * 100) : 0;
            return (
              <div key={p.sku} className="flex items-center gap-3 pl-3 pr-3 py-3" style={{ borderTop: i ? '1px solid #F0E8DB' : undefined }}>
                <Photo p={p} className="w-[52px] h-[52px] rounded-2xl shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[14.5px] font-bold leading-tight truncate" style={{ color: CACAO }}>{name(p)}</span>
                    <span className="lp-display text-[19px] leading-none font-bold shrink-0" style={{ color: isLow ? RED : GOLD_INK }}>{p.stock == null ? '—' : Math.round(p.stock)}</span>
                  </div>
                  {hasMin && (
                    <div className="relative h-[5px] rounded-full mt-2" style={{ backgroundColor: '#EDE4D6' }}>
                      <div className="h-[5px] rounded-full" style={{ width: `${fill}%`, backgroundColor: isLow ? '#B4572A' : '#8A6418' }} />
                      <span className="absolute -top-[3px] w-[2px] h-[11px] rounded-full" style={{ left: `${mark}%`, backgroundColor: CACAO }} />
                    </div>
                  )}
                  <div className="text-[11.5px] mt-1.5 truncate" style={{ color: MUTED }}>
                    {p.threshold != null ? (isLow ? L(`dưới mức tối thiểu ${Math.round(p.threshold)}`, `under minimum ${Math.round(p.threshold)}`) : L(`tối thiểu ${Math.round(p.threshold)}`, `minimum ${Math.round(p.threshold)}`)) : L('chưa đặt mức tối thiểu', 'no minimum set')}
                    {p.lastBatch != null ? ` · ${L('mẻ trước', 'last batch')} ${p.lastBatch}` : ''}
                  </div>
                </div>
                {!readOnly && (
                  <button onClick={() => { setPad(p); setVal(''); }} aria-label={L('Sản xuất', 'Produce')}
                    className="w-12 h-12 rounded-full flex items-center justify-center shrink-0 lp-press" style={{ backgroundColor: BROWN, color: '#fff', boxShadow: '0 4px 10px rgba(87,44,26,.25)' }}>
                    <Plus size={20} />
                  </button>
                )}
              </div>
            );
          })}
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
