'use client';
// Orders screen, UI v2 (Axel, 2026-11-14) — replaces the old "Theo dõi" card list.
// Same data and the same server actions as before (getMyOnlineOrdersAction, setShopDeliveredAction,
// setPaymentStatusAction, uploadPaymentProofAction, refundOnlineOrderAction, updateDeliveryFeeAction,
// setCustomerReturningOverrideAction, replaceOnlineOrderLinesAction via ReconstructPanel); only the
// layout changes. Stages are derived, never stored:
//   lab  = lab order whose Odoo delivery is not validated yet
//   sent = Odoo delivery validated (lab sent it), or a shop-stock sale
// Axel, 2026-11-14: the "handed to customer" tick is not used by the team, so it is no longer
// shown (the field and its action stay untouched for the payment alert and history).
// Payment is shown beside the stage and never blocks it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, X, CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { thumb } from '@/lib/img-thumb';
import * as actions from './actions';
import type { OnlineOrderSummary } from './actions';
import { compressImage, ReconstructPanel } from './order-widgets';
import { swr, prefetch, invalidate } from './client-cache';
import { fmtVnd, fmtCompactVnd, fmtDayLabel, useL } from './shared';

// Neutral colours are taken from the staff-theme palette (scripts/gen-ui-themes.py) so the
// Caramel / Pistache / Bleu themes re-tint this screen too. Status colours never change.
const BG = '#F6F1EA', LINE = '#E6DCCF', CARD = '#FFFFFF', PANEL = '#F7F1E8';
const DARK = '#2A1810', INK = '#2E1B12', MUTED = '#6B5A4C', LIGHT = '#8A7A66', GOLD = '#C9A84C', SOFT = '#D9CBB8';
const ST = {
  red: { bg: '#F5E1DC', fg: '#9A3324' },
  amber: { bg: '#F1E3C4', fg: '#5F4A10' },
  blue: { bg: '#E5EEF4', fg: '#24425A' },
  green: { bg: '#E2EEE5', fg: '#1F5235' },
  orange: { bg: '#FBEBD3', fg: '#9A5B12' },
  violet: { bg: '#EDE9F5', fg: '#5B4A8A' },
};

type Stage = 'lab' | 'sent';
type View = { kind: 'day'; date: string };
type Filter = 'all' | 'atLab' | 'unpaid' | 'latePay';

function stageOf(o: OnlineOrderSummary): Stage {
  if (o.source === 'lab' && !o.labDelivered && !o.shopDelivered) return 'lab';
  return 'sent';
}
const isLatePay = (o: OnlineOrderSummary) => o.paymentStatus !== 'paid' && (o.labDelivered || o.shopDelivered) && Date.now() - new Date(o.createdAt).getTime() > 24 * 3600 * 1000;
const noOdoo = (o: OnlineOrderSummary) => o.source === 'lab' && !o.orderRef && !o.cancelled;
const isoDay = (offset: number) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
const grand = (o: OnlineOrderSummary) => o.total + o.deliveryFee;

export default function OrdersTab({ readOnly, onNewOrder }: { readOnly: boolean; onNewOrder?: () => void }) {
  const { tr, lang } = useL();
  const today = isoDay(0);
  const [view, setView] = useState<View>({ kind: 'day', date: today });
  const viewRef = useRef(today);
  viewRef.current = view.date;
  const [orders, setOrders] = useState<OnlineOrderSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [showExport, setShowExport] = useState(false);
  const [exportFrom, setExportFrom] = useState(isoDay(-6));
  const [exportTo, setExportTo] = useState(today);

  // Cached per day: a day already seen shows instantly and refreshes quietly; the next days are
  // prefetched so tapping them is instant too.
  const dayFetcher = (d: string) => () => actions.getMyOnlineOrdersAction({ deliveryDate: d }).then(r => r.orders ?? []);
  async function load(v: View = view, force = false) {
    if (force) invalidate(`orders:${v.date}`);
    setLoading(true);
    await swr(`orders:${v.date}`, dayFetcher(v.date), (list) => { if (viewRef.current === v.date) setOrders(list); }, 20_000);
    if (viewRef.current === v.date) setLoading(false);
  }
  async function loadCounts(force = false) {
    if (force) invalidate('orders:counts');
    await swr('orders:counts', () => actions.getOnlineOrderDayCountsAction(isoDay(-1), isoDay(7)), res => { if (res.counts) setCounts(res.counts); }, 60_000);
  }
  useEffect(() => {
    setOrders(null);
    load(view); setSelectedId(null);
    const base = new Date(view.date + 'T00:00:00Z').getTime();
    const t = setTimeout(() => {
      for (const n of [1, -1, 2]) { const d = new Date(base + n * 86400000).toISOString().slice(0, 10); prefetch(`orders:${d}`, dayFetcher(d), 20_000); }
    }, 600);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [view]);
  useEffect(() => { loadCounts(); }, []);
  const refresh = () => { load(view, true); loadCounts(true); };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    return (orders ?? []).filter(o => {
      if (filter === 'atLab' && stageOf(o) !== 'lab') return false;
      if (filter === 'unpaid' && o.paymentStatus === 'paid') return false;
      if (filter === 'latePay' && !isLatePay(o)) return false;
      if (!needle) return true;
      const hay = `${o.customerName ?? ''} ${o.orderRef ?? ''} ${o.channel ?? ''} ${o.shopName} ${o.items.map(i => i.nameVi).join(' ')}`.toLowerCase();
      if (hay.includes(needle)) return true;
      return digits.length >= 3 && (o.customerPhone ?? '').replace(/\D/g, '').includes(digits);
    }).sort((a, b) => (a.deliveryDate || '').localeCompare(b.deliveryDate || '') || (a.readyTime || '99').localeCompare(b.readyTime || '99') || a.createdAt.localeCompare(b.createdAt));
  }, [orders, filter, q]);

  const selected = (orders ?? []).find(o => o.orderBatchId === selectedId) ?? null;

  const latePayN = (orders ?? []).filter(isLatePay).length;
  const noOdooN = (orders ?? []).filter(noOdoo).length;
  const watch: string[] = [];
  if (latePayN) watch.push(`${latePayN} ${tr('watchUnpaid')}`);
  if (noOdooN) watch.push(`${noOdooN} ${tr('watchNoOdoo')}`);

  const days = [-1, 0, 1, 2, 3, 4, 5, 6].map(i => isoDay(i));
  const dayLabel = (d: string) => d === today ? tr('today') : d === isoDay(1) ? tr('tomorrow') : fmtDayLabel(d, lang).split(/[ ,]/)[0];
  const dayNum = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const curDate = view.date;
  const shiftDay = (n: number) => { const base = curDate ?? today; const d = new Date(base + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); setView({ kind: 'day', date: d.toISOString().slice(0, 10) }); };

  const chip = (active: boolean, red = false): React.CSSProperties => ({
    flex: 'none', fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: '7px 12px', whiteSpace: 'nowrap',
    backgroundColor: active ? DARK : CARD, color: active ? '#FBF7F0' : red ? ST.red.fg : INK, border: active ? `1px solid ${DARK}` : `1px solid ${LINE}`,
  });
  const dayBtn = (active: boolean, red = false): React.CSSProperties => ({
    flex: 'none', minWidth: 62, height: 48, borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
    fontSize: 13, fontWeight: 700, padding: '0 8px',
    backgroundColor: active ? DARK : CARD, color: active ? '#FBF7F0' : red ? ST.red.fg : INK, border: `1px solid ${active ? DARK : red ? '#EBC3BA' : LINE}`,
  });

  return (
    <div className="flex flex-col lg:flex-row lg:h-full lg:min-h-0" style={{ backgroundColor: BG }}>
      <div className="flex-1 min-w-0 flex flex-col lg:min-h-0">
        {/* ── Header: search, export, day strip, filters, alerts ── */}
        <div className="px-3.5 lg:px-6 pt-3 lg:pt-5 pb-2 flex flex-col gap-2.5">
          <div className="hidden lg:flex items-center justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <h1 style={{ margin: 0, fontFamily: "'Playfair Display', Georgia, serif", fontSize: 28, fontWeight: 700, color: DARK }}>{tr('navOrders')}</h1>
            </div>
            <div className="flex items-center gap-2">
              <SearchBox q={q} setQ={setQ} />
              <button onClick={() => setShowExport(v => !v)} style={{ minHeight: 40, borderRadius: 10, border: `1px solid ${LINE}`, backgroundColor: showExport ? DARK : CARD, color: showExport ? '#FBF7F0' : INK, fontSize: 13, fontWeight: 600, padding: '0 14px' }}>📤 {tr('exportBtn')}</button>
              {!readOnly && onNewOrder && (
                <button onClick={onNewOrder} className="flex items-center gap-1.5" style={{ minHeight: 40, borderRadius: 10, backgroundColor: DARK, color: '#FBF7F0', fontSize: 13.5, fontWeight: 700, padding: '0 16px' }}><Plus size={15} />{tr('navNew')}</button>
              )}
            </div>
          </div>
          <div className="flex lg:hidden items-center gap-2">
            <div className="flex-1 min-w-0"><SearchBox q={q} setQ={setQ} /></div>
            <button onClick={() => setShowExport(v => !v)} aria-label={tr('exportBtn')} style={{ width: 42, height: 42, borderRadius: 12, border: `1px solid ${LINE}`, backgroundColor: showExport ? DARK : CARD, color: showExport ? '#FBF7F0' : INK, fontSize: 15 }}>📤</button>
          </div>
          {showExport && (
            <div className="flex items-center gap-2 flex-wrap rounded-xl px-3 py-2" style={{ border: `1px solid ${LINE}`, backgroundColor: CARD, fontSize: 12 }}>
              <label className="flex items-center gap-1.5" style={{ color: MUTED }}>{tr('exportFrom')}
                <input type="date" value={exportFrom} max={exportTo} onChange={e => setExportFrom(e.target.value)} style={{ border: `1px solid ${LINE}`, borderRadius: 6, padding: '3px 6px', color: INK }} /></label>
              <label className="flex items-center gap-1.5" style={{ color: MUTED }}>{tr('exportTo')}
                <input type="date" value={exportTo} min={exportFrom} onChange={e => setExportTo(e.target.value)} style={{ border: `1px solid ${LINE}`, borderRadius: 6, padding: '3px 6px', color: INK }} /></label>
              <a href={`/api/lab/online-orders-export?from=${exportFrom}&to=${exportTo}&lang=${lang}`} style={{ backgroundColor: DARK, color: '#FBF7F0', fontWeight: 700, padding: '6px 12px', borderRadius: 8, textDecoration: 'none' }}>{tr('exportBtn')}</a>
            </div>
          )}

          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-3.5 px-3.5 lg:mx-0 lg:px-0">
            <button onClick={() => shiftDay(-1)} aria-label="previous day" className="hidden lg:flex items-center justify-center" style={{ ...dayBtn(false), minWidth: 36, padding: 0 }}><ChevronLeft size={16} /></button>
            {days.map(d => (
              <button key={d} onClick={() => setView({ kind: 'day', date: d })} style={dayBtn(curDate === d)}>
                <span style={{ fontSize: 10.5, fontWeight: 600, opacity: 0.8 }}>{dayLabel(d)}</span>
                <span>{dayNum(d)}{counts[d] ? <span style={{ opacity: 0.7, fontWeight: 600 }}> · {counts[d]}</span> : null}</span>
              </button>
            ))}
            <button onClick={() => shiftDay(1)} aria-label="next day" className="hidden lg:flex items-center justify-center" style={{ ...dayBtn(false), minWidth: 36, padding: 0 }}><ChevronRight size={16} /></button>
            <label className="relative flex items-center justify-center" style={{ ...dayBtn(!!curDate && !days.includes(curDate)), minWidth: 48, cursor: 'pointer' }} title={tr('pickDate')}>
              {curDate && !days.includes(curDate) ? <span style={{ fontSize: 12 }}>{dayNum(curDate)}</span> : <CalendarDays size={17} />}
              <input type="date" aria-label={tr('pickDate')} value={curDate ?? ''} onChange={e => e.target.value && setView({ kind: 'day', date: e.target.value })}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
            </label>
          </div>

          <div className="flex lg:hidden items-center gap-1.5 overflow-x-auto no-scrollbar -mx-3.5 px-3.5">
            {([['all', tr('fAll')], ['atLab', tr('stLab')], ['unpaid', tr('unpaid')], ['latePay', tr('latePay')]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} style={chip(filter === k, k === 'latePay')}>{label}</button>
            ))}
            {loading && <Loader2 size={15} className="animate-spin flex-none" color={LIGHT} />}
          </div>

          {watch.length > 0 && (
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap rounded-xl px-3.5 py-2" style={{ backgroundColor: '#FBF3DF', border: '1px solid #EAD7A4', color: '#5F4A10', fontSize: 12.5 }}>
              <b>✦ {tr('watchTitle')}</b>
              {watch.map(w => <span key={w}>· {w}</span>)}
            </div>
          )}
        </div>

        {/* ── Desktop (UI v2.1, Axel 2026-11-14: "espace très mal organisé, peu visible") ──
            One summary strip for the day (each tile filters the list), then one grid of large
            photo-first cards sorted by time. The stage is a pill on each card instead of two
            columns, so an empty stage no longer wastes half the screen. */}
        <div className="hidden lg:flex flex-col gap-4 px-6 pb-6 flex-1 min-h-0 overflow-y-auto">
          {orders && (() => {
            const live = orders.filter(o => !o.cancelled && !o.refunded);
            const revenue = live.reduce((a, o) => a + grand(o), 0);
            const toCollect = live.reduce((a, o) => a + (o.paymentStatus === 'paid' ? 0 : Math.max(0, grand(o) - (o.amountPaid || 0))), 0);
            const unpaidN = live.filter(o => o.paymentStatus !== 'paid').length;
            const labN = live.filter(o => stageOf(o) === 'lab').length;
            const tiles: { k: Filter; label: string; value: string; sub: string; color: string; bg: string }[] = [
              { k: 'all', label: tr('sumOrders'), value: String(live.length), sub: fmtVnd(revenue), color: DARK, bg: CARD },
              { k: 'atLab', label: tr('stLab'), value: String(labN), sub: labN ? tr('sumLabSub') : `✓ ${tr('labClear')}`, color: labN ? ST.amber.fg : ST.green.fg, bg: labN ? ST.amber.bg : CARD },
              { k: 'unpaid', label: tr('sumToCollect'), value: toCollect ? fmtCompactVnd(toCollect) : '0', sub: unpaidN ? `${unpaidN} ${tr(unpaidN === 1 ? 'sumOrderUnit1' : 'sumOrdersUnit')}` : `✓ ${tr('paidFull')}`, color: toCollect ? ST.red.fg : DARK, bg: CARD },
              { k: 'latePay', label: tr('latePay'), value: String(latePayN), sub: tr('sumLateSub'), color: latePayN ? ST.red.fg : DARK, bg: latePayN ? ST.red.bg : CARD },
            ];
            return (
              <div className="grid grid-cols-4 gap-3">
                {tiles.map(t => (
                  <button key={t.k} onClick={() => setFilter(filter === t.k ? 'all' : t.k)} className="text-left flex flex-col gap-1 rounded-2xl"
                    style={{ backgroundColor: t.bg, padding: '14px 18px', boxShadow: '0 1px 2px rgba(42,24,16,0.05)', outline: filter === t.k && t.k !== 'all' ? `2px solid ${DARK}` : 'none', outlineOffset: -2 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: MUTED }}>{t.label}</span>
                    <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontFeatureSettings: '"lnum" 1, "tnum" 1', fontSize: 30, fontWeight: 700, lineHeight: 1.1, color: t.color }}>{t.value}</span>
                    <span style={{ fontSize: 12, color: LIGHT }}>{t.sub}</span>
                  </button>
                ))}
              </div>
            );
          })()}
          {!orders && <div className="text-center py-16" style={{ color: LIGHT }}><Loader2 className="animate-spin inline" /></div>}
          {orders && filtered.length === 0 && <div className="rounded-2xl text-center" style={{ backgroundColor: CARD, color: LIGHT, fontSize: 14, padding: '48px 0' }}>{tr('noOrdersDay')}</div>}
          <div className="grid gap-4 content-start" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
            {filtered.map(o => (
              <DeskCard key={o.orderBatchId} o={o} selected={o.orderBatchId === selectedId} onOpen={() => setSelectedId(o.orderBatchId)} />
            ))}
          </div>
        </div>

        {/* ── Phone list ── */}
        <div className="lg:hidden px-3.5 pb-24 flex flex-col gap-2.5">
          {orders && filtered.length === 0 && <div style={{ textAlign: 'center', color: LIGHT, fontSize: 13, padding: '28px 0' }}>{tr('noOrdersDay')}</div>}
          {!orders && <div className="text-center py-10" style={{ color: LIGHT }}><Loader2 className="animate-spin inline" /></div>}
          {filtered.map(o => (
            <OrderCard key={o.orderBatchId} o={o} readOnly={readOnly} onOpen={() => setSelectedId(o.orderBatchId)} onChanged={refresh} />
          ))}
        </div>
      </div>

      {/* ── Detail: side panel on desktop, full screen on phone ── */}
      {selected && (
        <div className="hidden lg:block fixed inset-0 z-30" onClick={() => setSelectedId(null)} style={{ backgroundColor: 'rgba(42,24,16,0.18)' }}>
          <aside onClick={e => e.stopPropagation()} className="absolute right-0 top-0 bottom-0 flex flex-col" style={{ width: 480, backgroundColor: CARD, boxShadow: '-12px 0 32px rgba(42,24,16,0.14)' }}>
            <OrderDetail key={selected.orderBatchId} o={selected} readOnly={readOnly} onClose={() => setSelectedId(null)} onChanged={refresh} />
          </aside>
        </div>
      )}
      {selected && (
        <div className="lg:hidden fixed inset-0 z-40 flex flex-col" style={{ backgroundColor: BG }}>
          <OrderDetail key={selected.orderBatchId} o={selected} readOnly={readOnly} onClose={() => setSelectedId(null)} onChanged={refresh} fullScreen />
        </div>
      )}
    </div>
  );
}

function SearchBox({ q, setQ }: { q: string; setQ: (s: string) => void }) {
  const { tr } = useL();
  return (
    <label className="flex items-center gap-2" style={{ backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: '0 12px', minHeight: 42, minWidth: 0 }}>
      <Search size={15} color={LIGHT} />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('searchOrdersPh')} className="flex-1 min-w-0 outline-none bg-transparent" style={{ fontSize: 13.5, color: INK }} />
      {q && <button onClick={() => setQ('')} aria-label="clear"><X size={14} color={LIGHT} /></button>}
    </label>
  );
}

function Pill({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return <span style={{ backgroundColor: bg, color: fg, fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '3px 8px', whiteSpace: 'nowrap' }}>{children}</span>;
}

function usePayBadge(o: OnlineOrderSummary) {
  const { tr } = useL();
  if (isLatePay(o)) return { ...ST.red, label: tr('latePay') };
  if (o.paymentStatus === 'paid') return { ...ST.green, label: tr('paidFull') };
  if (o.paymentStatus === 'partial') return { ...ST.amber, label: `${tr('partial')}${o.amountPaid ? ' ' + fmtCompactVnd(o.amountPaid) : ''}` };
  return { ...ST.red, label: tr('unpaidFull') };
}

function RefBadge({ o }: { o: OnlineOrderSummary }) {
  const { tr } = useL();
  const s: React.CSSProperties = { fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' };
  if (o.source === 'excel_import') return <span style={{ ...s, backgroundColor: ST.violet.bg, color: ST.violet.fg }}>{tr('importBadge')}</span>;
  if (o.source === 'shop_stock') return <span style={{ ...s, backgroundColor: ST.orange.bg, color: ST.orange.fg }}>{tr('stockBadge')}</span>;
  if (o.orderRef) return <span style={{ ...s, backgroundColor: PANEL, color: '#7A5A12' }}>{o.orderRef}</span>;
  return <span style={{ ...s, backgroundColor: ST.red.bg, color: ST.red.fg }}>{tr('noOdoo')}</span>;
}

function useRoute(o: OnlineOrderSummary) {
  const { tr } = useL();
  if (o.source === 'shop_stock') return `${tr('stockShort')} ${o.shopName}`;
  if (o.shopName === 'Lab' || o.deliveryMode === 'direct') return `${tr('routeLab')} → ${tr('routeCustomer')}`;
  return o.shopName;
}

function Photos({ o, size }: { o: OnlineOrderSummary; size: number }) {
  const imgs = o.items.filter(i => !i.isFee && i.imageUrl).map(i => i.imageUrl as string);
  const uniq = Array.from(new Set(imgs));
  if (!uniq.length) return <span className="flex-none flex items-center justify-center" style={{ width: size, height: size, borderRadius: 12, backgroundColor: PANEL, fontSize: size * 0.4 }}>🎂</span>;
  return (
    <span className="flex-none relative" style={{ width: size, height: size }}>
      {uniq.length > 1 && <span style={{ position: 'absolute', left: 4, top: 4, width: size, height: size, borderRadius: 12, backgroundColor: SOFT }} />}
      <img src={thumb(uniq[0], size * 2 <= 96 ? 96 : 128)} alt="" loading="lazy" style={{ position: 'relative', width: size, height: size, borderRadius: 12, objectFit: 'cover', backgroundColor: PANEL }} />
      {uniq.length > 1 && <span style={{ position: 'absolute', right: -6, bottom: -6, backgroundColor: DARK, color: '#FBF7F0', fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 6px' }}>+{uniq.length - 1}</span>}
    </span>
  );
}

// Desktop card: the cake photo first (that is how the team recognises an order), then who / how much,
// then where it goes. Time and payment sit on the photo so they are seen at a glance.
function DeskCard({ o, selected, onOpen }: { o: OnlineOrderSummary; selected: boolean; onOpen: () => void }) {
  const { tr } = useL();
  const pay = usePayBadge(o);
  const route = useRoute(o);
  const stage = stageOf(o);
  const late = isLatePay(o);
  const items = o.items.filter(i => !i.isFee);
  const imgs = Array.from(new Set(items.filter(i => i.imageUrl).map(i => i.imageUrl as string)));
  const products = items.map(i => `${i.nameVi}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—';
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      className="text-left flex flex-col cursor-pointer overflow-hidden transition-shadow hover:shadow-[0_10px_28px_rgba(42,24,16,0.12)]"
      style={{ backgroundColor: CARD, borderRadius: 18, boxShadow: '0 1px 2px rgba(42,24,16,0.06), 0 4px 14px rgba(42,24,16,0.05)',
        outline: selected ? `2px solid ${GOLD}` : late ? `2px solid ${ST.red.fg}` : 'none', outlineOffset: -2, opacity: o.refunded || o.cancelled ? 0.6 : 1 }}>
      <div className="relative" style={{ height: 170, backgroundColor: PANEL }}>
        {imgs.length
          ? <img src={thumb(imgs[0], 400)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span className="absolute inset-0 flex items-center justify-center" style={{ fontSize: 46 }}>🎂</span>}
        {o.readyTime && (
          <span className="absolute" style={{ left: 10, top: 10, backgroundColor: 'rgba(42,24,16,0.86)', color: '#FBF7F0', borderRadius: 10, padding: '4px 10px', fontSize: 15, fontWeight: 700, fontFeatureSettings: '"tnum" 1' }}>
            {o.readyTime.slice(0, 5)}
          </span>
        )}
        <span className="absolute" style={{ right: 10, top: 10 }}><Pill bg={pay.bg} fg={pay.fg}>{pay.label}</Pill></span>
        {imgs.length > 1 && (
          <span className="absolute flex gap-1.5" style={{ right: 10, bottom: 10 }}>
            {imgs.slice(1, 3).map(u => <img key={u} src={thumb(u, 96)} alt="" loading="lazy" style={{ width: 40, height: 40, borderRadius: 10, objectFit: 'cover', border: '2px solid #fff' }} />)}
            {imgs.length > 3 && <span className="flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: DARK, color: '#FBF7F0', fontSize: 12, fontWeight: 700, border: '2px solid #fff' }}>+{imgs.length - 3}</span>}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5" style={{ padding: '12px 14px 14px' }}>
        <div className="flex items-baseline justify-between gap-2">
          <b className="truncate" style={{ fontSize: 16, color: DARK }}>{o.customerName || tr('walkIn')}</b>
          <b style={{ fontSize: 16, color: DARK, flex: 'none' }}>{fmtCompactVnd(grand(o)).replace(' ₫', '')}</b>
        </div>
        <div className="line-clamp-2" style={{ fontSize: 13, color: MUTED, lineHeight: 1.35, minHeight: 35 }}>{products}</div>
        <div className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: 2 }}>
          {o.source === 'shop_stock'
            ? <Pill bg={ST.orange.bg} fg={ST.orange.fg}>{tr('stockBadge')}</Pill>
            : <Pill bg={stage === 'lab' ? ST.amber.bg : ST.green.bg} fg={stage === 'lab' ? ST.amber.fg : ST.green.fg}>{stage === 'lab' ? tr('stLab') : tr('stSentShort')}</Pill>}
          {o.customerPhone && o.isReturningCustomer && <Pill bg={ST.green.bg} fg={ST.green.fg}>↻ {tr('returningShort')}</Pill>}
          {o.cancelled && <Pill bg={ST.red.bg} fg={ST.red.fg}>{tr('cancelledBadge')}</Pill>}
          {o.refunded && <Pill bg={ST.red.bg} fg={ST.red.fg}>{tr('refundedBadge')}</Pill>}
          {noOdoo(o) && <Pill bg={ST.red.bg} fg={ST.red.fg}>{tr('noOdoo')}</Pill>}
        </div>
        <div className="flex items-center justify-between gap-2 min-w-0" style={{ fontSize: 12.5, borderTop: `1px solid ${PANEL}`, paddingTop: 8, marginTop: 2 }}>
          <span className="truncate" style={{ fontWeight: 600, color: INK }}>{o.source === 'shop_stock' ? o.shopName : route}</span>
          {o.source !== 'shop_stock' && <span className="flex-none"><RefBadge o={o} /></span>}
        </div>
      </div>
    </div>
  );
}

function OrderCard({ o, readOnly, compact = false, selected = false, onOpen, onChanged }: { o: OnlineOrderSummary; readOnly: boolean; compact?: boolean; selected?: boolean; onOpen: () => void; onChanged: () => void }) {
  const { tr } = useL();
  const pay = usePayBadge(o);
  const route = useRoute(o);
  const stage = stageOf(o);
  const late = isLatePay(o);
  void readOnly; void onChanged;
  const products = o.items.filter(i => !i.isFee).map(i => `${i.nameVi}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join(', ') || '—';
  let action: React.ReactNode = null;
  if (o.cancelled) action = <span style={{ fontSize: 12, fontWeight: 600, color: ST.red.fg }}>{tr('cancelledBadge')}</span>;
  else if (stage === 'lab') action = noOdoo(o)
    ? <span style={{ fontSize: 12, fontWeight: 600, color: ST.red.fg }}>{tr('noOdooAdmin')}</span>
    : <span style={{ fontSize: 12, fontWeight: 600, color: LIGHT }}>{tr('labTurn')}{o.production && o.production.total > 0 ? ` · ${tr('produced')} ${o.production.produced}/${o.production.total}` : ''}</span>;
  // A late payment is already shown by the red pill at the top of the card (and its red edge).

  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}
      className="text-left flex flex-col cursor-pointer"
      style={{
        backgroundColor: CARD, borderRadius: compact ? 12 : 16, padding: compact ? '11px 12px' : '13px 14px', gap: compact ? 7 : 8,
        boxShadow: late ? `inset 3px 0 0 ${ST.red.fg}, 0 1px 2px rgba(42,24,16,0.06)` : '0 1px 2px rgba(42,24,16,0.06)',
        outline: selected ? `2px solid ${GOLD}` : 'none', outlineOffset: -1, opacity: o.refunded || o.cancelled ? 0.6 : 1,
      }}>
      <div className="flex items-center justify-between gap-2">
        <span style={{ fontSize: 12, fontWeight: 700, color: DARK, minWidth: 0 }} className="truncate">{o.readyTime ? `${o.readyTime.slice(0, 5)} · ` : ''}{route}</span>
        <Pill bg={pay.bg} fg={pay.fg}>{pay.label}</Pill>
      </div>
      <div className="flex items-center gap-3">
        <Photos o={o} size={compact ? 46 : 56} />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
              <b className="truncate" style={{ fontSize: 14.5, color: DARK }}>{o.customerName || tr('walkIn')}</b>
              {o.customerPhone && o.isReturningCustomer && <span title={tr('returningCustomerBadge')} style={{ fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '1px 7px', flex: 'none', backgroundColor: ST.green.bg, color: ST.green.fg }}>↻ {tr('returningShort')}</span>}
            </span>
            <b style={{ fontSize: 13.5, color: DARK, flex: 'none' }}>{fmtCompactVnd(grand(o)).replace(' ₫', '')}</b>
          </div>
          <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.35 }} className={compact ? 'line-clamp-2' : 'truncate'}>{products}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <RefBadge o={o} />
        {!compact && <Pill bg={stage === 'lab' ? ST.amber.bg : ST.green.bg} fg={stage === 'lab' ? ST.amber.fg : ST.green.fg}>{stage === 'lab' ? tr('stLab') : tr('stSent')}</Pill>}
        <span className="truncate" style={{ fontSize: 11, color: LIGHT }}>{o.channel}</span>
        {o.refunded && <Pill bg={ST.red.bg} fg={ST.red.fg}>{tr('refundedBadge')}</Pill>}
      </div>
      {action}
    </div>
  );
}

function OrderDetail({ o, readOnly, onClose, onChanged, fullScreen = false }: { o: OnlineOrderSummary; readOnly: boolean; onClose: () => void; onChanged: () => void; fullScreen?: boolean }) {
  const { tr, lang } = useL();
  const route = useRoute(o);
  const stage = stageOf(o);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [reconstructing, setReconstructing] = useState(false);
  const total = grand(o);
  const received = o.paymentStatus === 'paid' ? total : Math.min(total, o.amountPaid || 0);
  const due = Math.max(0, total - received - (o.refundAmount || 0));
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  async function run(fn: () => Promise<{ error?: string } | undefined | null | { ok?: boolean; error?: string }>) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res && 'error' in res && res.error) { window.alert(res.error); return; }
    onChanged();
  }
  function setPay(s: 'unpaid' | 'partial' | 'paid') {
    if (s === 'paid') return run(() => actions.setPaymentStatusAction(o.orderBatchId, 'paid', total));
    if (s === 'unpaid') return run(() => actions.setPaymentStatusAction(o.orderBatchId, 'unpaid', o.amountPaid));
    const raw = window.prompt(tr('depositAmount'), String(o.amountPaid || ''));
    if (raw == null) return;
    const amt = Math.round(Number(raw.replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(amt) || amt < 0) return;
    return run(() => actions.setPaymentStatusAction(o.orderBatchId, 'partial', amt));
  }
  async function onProof(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    setUploading(true);
    const fd = new FormData(); fd.append('file', await compressImage(file));
    const res = await actions.uploadPaymentProofAction(o.orderBatchId, fd);
    setUploading(false);
    if (res?.error) { window.alert(res.error); return; }
    onChanged();
  }
  function refund() {
    const prefill = o.refundAmount > 0 ? o.refundAmount : Math.round(total);
    const raw = window.prompt(tr('refundPrompt'), String(prefill));
    if (raw == null) return;
    const amount = Math.round(Number(raw.replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(amount) || amount <= 0) return;
    run(() => actions.refundOnlineOrderAction(o.orderBatchId, amount));
  }
  function editFee() {
    const raw = window.prompt(tr('deliveryFeePrompt'), String(o.deliveryFee || 0));
    if (raw == null) return;
    const fee = Math.round(Number(raw.replace(/[^\d.-]/g, '')));
    if (!Number.isFinite(fee) || fee < 0) return;
    run(() => actions.updateDeliveryFeeAction(o.orderBatchId, fee));
  }
  const toggleReturning = () => run(() => actions.setCustomerReturningOverrideAction(o.orderBatchId, o.returningManual ? null : true));

  type Step = { label: string; who: string; at: string; state: 'done' | 'now' | 'todo' };
  const steps: Step[] = [];
  steps.push({ label: tr('tlCreated'), who: o.source === 'excel_import' ? tr('tlImport') : o.orderRef ? `Odoo ${o.orderRef}` : o.source === 'shop_stock' ? tr('stockBadge') : tr('noOdoo'), at: fmtTime(o.createdAt), state: 'done' });
  if (o.source === 'lab') {
    const prod = o.production && o.production.total > 0 ? `${tr('produced')} ${o.production.produced}/${o.production.total}` : '';
    const sent = o.labDelivered || o.shopDelivered;
    steps.push({ label: tr('tlLab'), who: prod, at: '', state: sent ? 'done' : 'now' });
    const direct = o.shopName === 'Lab' || o.deliveryMode === 'direct';
    steps.push({ label: direct ? tr('tlSentDirect') : `${tr('tlSentTo')} ${o.shopName}`, who: tr('tlAuto'), at: '', state: sent ? 'done' : 'todo' });
  } else if (o.source === 'shop_stock') {
    steps.push({ label: `${tr('tlStock')} ${o.shopName}`, who: '', at: '', state: 'done' });
  }
  void stage;

  const sectionTitle: React.CSSProperties = { fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: LIGHT, fontWeight: 700 };
  const box: React.CSSProperties = fullScreen ? { backgroundColor: CARD, borderRadius: 16, padding: '14px 16px' } : { border: `1px solid ${LINE}`, borderRadius: 12, padding: '12px 14px' };
  const payBtn = (s: 'unpaid' | 'partial' | 'paid', label: string) => {
    const on = o.paymentStatus === s;
    const c = s === 'paid' ? ST.green : s === 'partial' ? ST.amber : ST.red;
    return (
      <button key={s} disabled={readOnly || busy} onClick={() => setPay(s)} style={{
        flex: 1, minHeight: 38, borderRadius: 10, fontSize: 12.5, fontWeight: 700,
        border: on ? `1.5px solid ${c.fg}` : `1px solid ${SOFT}`, backgroundColor: on ? c.bg : CARD, color: on ? c.fg : MUTED, opacity: readOnly && !on ? 0.6 : 1,
      }}>{label}</button>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-col gap-2" style={{ padding: fullScreen ? '14px 16px 12px' : '18px 22px 14px', borderBottom: `1px solid ${LINE}`, backgroundColor: CARD }}>
        <div className="flex items-center justify-between gap-2">
          <button onClick={onClose} className="flex items-center gap-1" style={{ fontSize: 14, fontWeight: 600, color: DARK, minHeight: 36 }} aria-label={tr('close')}>
            {fullScreen ? <><ChevronLeft size={18} />{tr('navOrders')}</> : <X size={18} />}
          </button>
          <span className="flex items-center gap-1.5 min-w-0"><RefBadge o={o} /><span className="truncate" style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{o.channel}</span></span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <div style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 23, fontWeight: 700, color: DARK }}>{o.customerName || tr('walkIn')}</div>
          <b style={{ fontSize: 18, color: DARK }}>{fmtVnd(total)}</b>
        </div>
        <div className="flex items-center gap-2 flex-wrap" style={{ fontSize: 12.5, color: '#3D2A20' }}>
          {o.customerPhone && <a href={`tel:${o.customerPhone}`} style={{ color: '#3D2A20' }}>{o.customerPhone}</a>}
          {o.customerPhone && (readOnly || (o.isReturningCustomer && !o.returningManual)
            ? <Pill bg={o.isReturningCustomer ? ST.green.bg : PANEL} fg={o.isReturningCustomer ? ST.green.fg : '#7A5A12'}>{o.isReturningCustomer ? `${tr('returningCustomerBadge')}${o.priorOrderCount ? ` · ${o.priorOrderCount}` : ''}` : tr('newCustomerBadge')}</Pill>
            : <button onClick={toggleReturning} title={o.returningManual ? tr('clearReturningOverride') : tr('markReturning')}><Pill bg={o.isReturningCustomer ? ST.green.bg : PANEL} fg={o.isReturningCustomer ? ST.green.fg : '#7A5A12'}>{o.isReturningCustomer ? `${tr('returningCustomerBadge')}${o.returningManual ? ` (${tr('returningManualTag')})` : ''}` : tr('newCustomerBadge')}</Pill></button>)}
        </div>
        <div style={{ fontSize: 13, color: '#3D2A20' }}>
          {fmtDayLabel(o.deliveryDate.slice(0, 10), lang)}{o.readyTime ? ` · ${tr('readyAt')} ${o.readyTime.slice(0, 5)}` : ''} · <b>{route}</b>
        </div>
        {o.cancelled && <div style={{ fontSize: 12.5, fontWeight: 700, color: ST.red.fg }}>{tr('cancelledBadge')}</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3" style={{ padding: fullScreen ? '12px 14px' : '16px 22px' }}>
        <section style={box}>
          <div style={{ ...sectionTitle, marginBottom: 10 }}>{tr('trackingTitle')}</div>
          {steps.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) auto', gap: 12 }}>
              <div className="flex flex-col items-center">
                <span className="flex items-center justify-center flex-none" style={{
                  width: 20, height: 20, borderRadius: 10, fontSize: 11, fontWeight: 700, boxSizing: 'border-box',
                  ...(s.state === 'done' ? { backgroundColor: ST.green.fg, color: '#fff' } : s.state === 'now' ? { backgroundColor: '#FBF3DF', border: '2px solid #B08A3E' } : { backgroundColor: '#fff', border: `2px solid ${SOFT}` }),
                }}>{s.state === 'done' ? '✓' : ''}</span>
                {i < steps.length - 1 && <span style={{ flex: 1, width: 2, minHeight: 14, backgroundColor: s.state === 'done' ? ST.green.fg : LINE }} />}
              </div>
              <div className="flex flex-col gap-0.5" style={{ paddingBottom: 11 }}>
                <span style={{ fontSize: 13.5, fontWeight: s.state === 'now' ? 700 : 600, color: s.state === 'todo' ? LIGHT : DARK }}>{s.label}</span>
                {s.who && <span style={{ fontSize: 11.5, color: LIGHT }}>{s.who}</span>}
              </div>
              <span style={{ fontSize: 11.5, color: MUTED, paddingTop: 2 }}>{s.at}</span>
            </div>
          ))}
        </section>

        <section style={box} className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between"><span style={sectionTitle}>{tr('payTitle')}</span><span style={{ fontSize: 11, color: LIGHT }}>{tr('payNeverBlocks')}</span></div>
          <div className="flex gap-1.5">{payBtn('unpaid', tr('unpaid'))}{payBtn('partial', tr('partial'))}{payBtn('paid', tr('paid'))}</div>
          <div style={{ height: 6, borderRadius: 3, backgroundColor: '#EFE6D8', overflow: 'hidden', display: 'flex' }}>
            <span style={{ width: `${total > 0 ? Math.round(received / total * 100) : 0}%`, backgroundColor: o.paymentStatus === 'paid' ? ST.green.fg : '#B08A3E' }} />
          </div>
          <div className="flex justify-between" style={{ fontSize: 13 }}>
            <span>{tr('payReceived')} {fmtVnd(received)}</span>
            {due > 0 && o.paymentStatus !== 'paid' && <b style={{ color: ST.red.fg }}>{tr('payDue')} {fmtVnd(due)}</b>}
          </div>
          {(o.paymentProofUrl || !readOnly) && (
            <div className="flex items-center gap-2.5" onDragOver={readOnly ? undefined : e => e.preventDefault()} onDrop={readOnly ? undefined : e => { e.preventDefault(); onProof(e.dataTransfer.files?.[0]); }}>
              {o.paymentProofUrl && <a href={o.paymentProofUrl} target="_blank" rel="noreferrer" className="flex-none"><img src={thumb(o.paymentProofUrl, 96)} alt={tr('payProof')} style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', border: `1px solid ${LINE}` }} /></a>}
              {!readOnly && (
                <label className="flex-1 text-center cursor-pointer" style={{ border: `1px dashed ${SOFT}`, borderRadius: 10, padding: 9, fontSize: 12, color: MUTED }}>
                  {uploading ? tr('uploading') : o.paymentProofUrl ? `✓ ${tr('payProof')}` : tr('payProofDrop')}
                  <input type="file" accept="image/*" className="hidden" onChange={e => onProof(e.target.files?.[0])} />
                </label>
              )}
            </div>
          )}
        </section>

        <section style={box} className="flex flex-col gap-2">
          <span style={sectionTitle}>{tr('itemsTitle')}</span>
          {o.items.map((it, i) => (
            <div key={i} className="flex items-center gap-2.5" style={{ fontSize: 13 }}>
              {it.isFee
                ? <span className="flex-none flex items-center justify-center" style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: PANEL, fontSize: 16 }}>🎁</span>
                : it.imageUrl
                  ? <img src={thumb(it.imageUrl, 96)} alt="" loading="lazy" className="flex-none" style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', backgroundColor: PANEL }} />
                  : <span className="flex-none flex items-center justify-center" style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: PANEL, fontSize: 18 }}>🎂</span>}
              <span className="flex-1 min-w-0">{it.qty} × {it.nameVi}</span>
              <b>{fmtCompactVnd((it.qty || 0) * (it.unitPrice || 0)).replace(' ₫', '')}</b>
            </div>
          ))}
          <div className="flex justify-between items-center" style={{ fontSize: 12.5, color: MUTED }}>
            <span>{tr('deliveryFee')}{!readOnly && o.source !== 'excel_import' && <button onClick={editFee} style={{ marginLeft: 8, color: '#7A5A12', fontWeight: 700 }}>✎ {tr('editDeliveryFeeBtn')}</button>}</span>
            <span>{fmtVnd(o.deliveryFee)}</span>
          </div>
          {!readOnly && o.source === 'excel_import' && o.items.length > 0 && o.items.every(i => !i.sku) && (
            reconstructing
              ? <ReconstructPanel order={o} onDone={() => { setReconstructing(false); onChanged(); }} onCancel={() => setReconstructing(false)} />
              : <button onClick={() => setReconstructing(true)} style={{ alignSelf: 'flex-start', backgroundColor: ST.violet.bg, color: ST.violet.fg, fontSize: 11.5, fontWeight: 700, padding: '4px 10px', borderRadius: 999 }}>{tr('needsItemsBadge')}</button>
          )}
        </section>

        {(o.cakeMessage || o.designPhotoUrl || o.address || o.notes) && (
          <section style={box} className="flex flex-col gap-2" >
            {o.cakeMessage && <div style={{ fontSize: 13 }}><span style={{ color: LIGHT }}>{tr('cakeText')}: </span><b>“{o.cakeMessage}”</b></div>}
            {o.designPhotoUrl && (
              <a href={o.designPhotoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2.5" style={{ fontSize: 12.5, color: MUTED }}>
                <img src={thumb(o.designPhotoUrl, 128)} alt="" style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover', border: `1px solid ${LINE}` }} />{tr('designRef')}
              </a>
            )}
            {o.address && <div style={{ fontSize: 12.5 }}><span style={{ color: LIGHT }}>{tr('addressLabel')}: </span>{o.address}{o.district ? `, ${o.district}` : ''}</div>}
            {o.notes && <div style={{ fontSize: 12.5 }}><span style={{ color: LIGHT }}>{tr('notesLabel')}: </span>{o.notes}</div>}
          </section>
        )}

        {o.refundedAt && (
          <div style={{ fontSize: 11.5, color: ST.red.fg }}>
            {tr('refundedAmountLabel')} {fmtVnd(o.refundAmount)} · {tr('refundedByShort')}{o.refundedByName ?? '—'} · {fmtTime(o.refundedAt)}
          </div>
        )}
      </div>

      {!readOnly && (
        <div className="flex flex-col gap-2" style={{ padding: fullScreen ? '10px 14px 22px' : '12px 22px 18px', borderTop: `1px solid ${LINE}`, backgroundColor: CARD }}>
          {o.source !== 'excel_import' && (
            <button onClick={refund} disabled={busy} style={{ minHeight: 40, borderRadius: 11, fontSize: 13, fontWeight: 600, color: ST.red.fg, backgroundColor: CARD, border: '1px solid #EBC3BA' }}>
              {o.refundedAt ? tr('adjustRefundBtn') : tr('refundBtn')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
