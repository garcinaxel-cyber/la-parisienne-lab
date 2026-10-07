'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Banknote, ArrowRightLeft, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { getEventSalesLedgerAction, type EventSale, type EventSalesLedger } from './actions';
import { NAVY, GOLD_PALE, INK, BORDER } from './ShopView';
import { useShopL, useShopLang } from './shop-lang';

// "Doanh thu" — the Sales side of the event till (Axel, 2026-10-07: "une version facile, par
// jour, en consolidé, graphique si tu veux ... adaptée version mobile" + "par virement, par cash
// aussi + traçabilité des transactions"). One read (getEventSalesLedgerAction: every sale of the
// event, with its lines) and every figure below is added up from it, so the total, the day view,
// the cash / transfer split, the breakdown and the transaction list can never disagree.
//
// Chart colours: cash green, transfer gold — the app's own hues, stepped until they pass the
// palette checks on a white card (lightness band, chroma, colour-blind separation, 3:1 contrast).
const CASH = '#1E7D55';
const TRANSFER = '#C08A12';
const HAIR = '#EFE9CF';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const GOLD_TEXT = '#8A6D14';

const fmt = (v: number) => Math.round(v).toLocaleString('vi-VN') + ' ₫';
const num = (v: number) => Math.round(v).toLocaleString('vi-VN');
function short(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2).replace('.', ',').replace(/,?0+$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(Math.round(v));
}
function niceMax(v: number): number {
  const e = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * e >= v) return s * e;
  return 10 * e;
}
const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + f(x), 0);

// Every day of the event (so a day without a sale still shows, as zero), plus any day a sale
// was actually recorded on. Without event dates: the days that have sales, and today.
function eventDays(l: EventSalesLedger): string[] {
  const set = new Set<string>(l.sales.map(s => s.day));
  if (l.eventStart && l.eventEnd && l.eventStart <= l.eventEnd) {
    const d = new Date(l.eventStart + 'T00:00:00Z');
    for (let i = 0; i < 31; i++) {
      const k = d.toISOString().slice(0, 10);
      if (k > l.eventEnd) break;
      set.add(k);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } else {
    set.add(l.today);
  }
  return Array.from(set).sort();
}

type Col = { key: string; label: string; a: number; b: number; tip?: ReactNode; dash?: boolean };

// Thin columns on one baseline, hairline grid, value on the cap. `stack`: a = cash (bottom),
// b = transfer (top), separated by a 2px gap in the card colour rather than a border.
function Columns({ items, stack, barWidth = 24, height = 176, showLabel }: {
  items: Col[]; stack: boolean; barWidth?: number; height?: number; showLabel: (c: Col) => boolean;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const W = 330, padL = 30, padR = 6, padT = 18, padB = 22, pw = W - padL - padR, ph = height - padT - padB;
  const mx = niceMax(Math.max(1, ...items.map(i => i.a + i.b)));
  const y = (v: number) => padT + ph - (v / mx) * ph;
  const slot = pw / Math.max(1, items.length);
  const bw = Math.min(barWidth, Math.max(4, slot - 6));
  const cap = (x: number, top: number, bottom: number) => {
    const r = Math.min(4, Math.max(0, (bottom - top) / 2), bw / 2);
    return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${bottom} Z`;
  };
  const cur = hi !== null ? items[hi] : null;
  const curCx = hi !== null ? padL + slot * hi + slot / 2 : 0;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} className="block w-full h-auto" style={{ overflow: 'visible' }} role="img">
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(mx * t)} y2={y(mx * t)} stroke={HAIR} strokeWidth={1} />
            <text x={padL - 6} y={y(mx * t) + 3.5} textAnchor="end" fontSize={10} fill={FAINT}>{t ? short(mx * t) : '0'}</text>
          </g>
        ))}
        {items.map((it, i) => {
          const cx = padL + slot * i + slot / 2, x = cx - bw / 2, tot = it.a + it.b;
          return (
            <g key={it.key}>
              {tot > 0 && (stack ? (
                <>
                  {it.a > 0 && (it.b > 0
                    ? <rect x={x} y={y(it.a)} width={bw} height={Math.max(0, y(0) - y(it.a))} fill={CASH} />
                    : <path d={cap(x, y(it.a), y(0))} fill={CASH} />)}
                  {it.b > 0 && <path d={cap(x, y(tot), it.a > 0 ? y(it.a) - 2 : y(0))} fill={TRANSFER} />}
                </>
              ) : <path d={cap(x, y(tot), y(0))} fill={CASH} />)}
              {tot > 0 && showLabel(it) && <text x={cx} y={y(tot) - 6} textAnchor="middle" fontSize={10.5} fontWeight={800} fill={INK}>{short(tot)}</text>}
              {tot <= 0 && it.dash && <text x={cx} y={y(0) - 6} textAnchor="middle" fontSize={10} fill={FAINT}>—</text>}
              {it.label && <text x={cx} y={height - 6} textAnchor="middle" fontSize={10.5} fontWeight={600} fill={MUTED}>{it.label}</text>}
              <rect x={padL + slot * i} y={padT - 10} width={slot} height={ph + 10} fill="transparent"
                onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(h => (h === i ? null : h))} onClick={() => setHi(i)} />
            </g>
          );
        })}
      </svg>
      {cur?.tip && (
        <div className="absolute pointer-events-none rounded-lg px-2.5 py-1.5 text-[11px] leading-snug whitespace-nowrap"
          style={{
            left: `${(Math.min(W - 78, Math.max(78, curCx)) / W) * 100}%`, top: `${(y(cur.a + cur.b) / height) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 8px))', backgroundColor: INK, color: '#fff', zIndex: 5,
          }}>
          {cur.tip}
        </div>
      )}
    </div>
  );
}

function PayBadge({ pay, label }: { pay: 'cash' | 'transfer'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] font-extrabold rounded-full whitespace-nowrap mt-1"
      style={{ padding: '2px 7px 2px 6px', backgroundColor: pay === 'cash' ? '#E6F2EC' : '#FBF1DA', color: pay === 'cash' ? '#17603F' : '#7A5608' }}>
      {pay === 'cash' ? <Banknote size={11} /> : <ArrowRightLeft size={11} />}{label}
    </span>
  );
}

export default function EventSalesView() {
  const L = useShopL();
  const lang = useShopLang();
  const [ledger, setLedger] = useState<EventSalesLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<string>('all');
  const [mode, setMode] = useState<'cat' | 'prod'>('cat');
  const [pay, setPay] = useState<'all' | 'cash' | 'transfer'>('all');
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const [openSales, setOpenSales] = useState<Set<string>>(new Set());
  const [allProducts, setAllProducts] = useState(false);
  const [shown, setShown] = useState(6);

  async function load() {
    setLoading(true);
    const res = await getEventSalesLedgerAction();
    setLoading(false);
    if (res.error || !res.ledger) { setError(res.error ?? 'Error'); return; }
    setError(null);
    setLedger(res.ledger);
  }
  useEffect(() => { load(); }, []);

  const locale = lang === 'en' ? 'en-GB' : 'vi-VN';
  const wd = (day: string, style: 'short' | 'long') => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  const ddmm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
  const longDay = (day: string) => `${wd(day, 'long')} ${ddmm(day)}`;
  const shortDay = (day: string) => `${wd(day, 'short')} ${day.slice(8, 10)}`;

  const days = useMemo(() => (ledger ? eventDays(ledger) : []), [ledger]);
  const all = ledger?.sales ?? [];
  const today = ledger?.today ?? '';
  const inScope = useMemo(() => (scope === 'all' ? all : all.filter(s => s.day === scope)), [all, scope]);

  const totals = useMemo(() => {
    const cash = inScope.filter(s => s.payment === 'cash');
    const total = sum(inScope, s => s.amount), cashAmount = sum(cash, s => s.amount);
    return {
      total, cash: cashAmount, transfer: total - cashAmount, count: inScope.length, cashCount: cash.length,
      units: sum(inScope, s => sum(s.lines, l => l.qty)), free: sum(inScope, s => sum(s.lines.filter(l => l.free), l => l.qty)),
    };
  }, [inScope]);

  const breakdown = useMemo(() => {
    const bySku = new Map<string, { sku: string; name: string; category: string; qty: number; revenue: number }>();
    for (const s of inScope) for (const l of s.lines) {
      const cur = bySku.get(l.sku) ?? { sku: l.sku, name: l.name, category: l.category || L('Khác', 'Other'), qty: 0, revenue: 0 };
      cur.qty += l.qty; cur.revenue += l.qty * l.unitPrice;
      bySku.set(l.sku, cur);
    }
    const products = Array.from(bySku.values()).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty);
    const byCat = new Map<string, { name: string; qty: number; revenue: number; items: typeof products }>();
    for (const p of products) {
      const c = byCat.get(p.category) ?? { name: p.category, qty: 0, revenue: 0, items: [] };
      c.qty += p.qty; c.revenue += p.revenue; c.items.push(p);
      byCat.set(p.category, c);
    }
    return { products, categories: Array.from(byCat.values()).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inScope, lang]);

  if (!ledger) {
    return (
      <div className="text-center py-10 text-sm" style={{ color: error ? '#B42318' : MUTED }}>
        {error ?? L('Đang tải…', 'Loading…')}
      </div>
    );
  }

  const isDay = scope !== 'all';
  const pc = totals.total ? Math.round((totals.cash / totals.total) * 100) : 0;
  const payLabel = (p: 'cash' | 'transfer', full = false) => p === 'cash' ? L('Tiền mặt', 'Cash') : full ? L('Chuyển khoản', 'Bank transfer') : L('Chuyển khoản', 'Transfer');
  const sales = (n: number) => `${n} ${L('đơn', n === 1 ? 'sale' : 'sales')}`;
  const card = { border: `1px solid ${BORDER}` };
  const label = 'text-[10.5px] font-extrabold uppercase tracking-wide';

  // ── charts ──
  const dayCols: Col[] = days.map(d => {
    const t = all.filter(s => s.day === d), c = sum(t.filter(s => s.payment === 'cash'), s => s.amount), b = sum(t, s => s.amount) - c;
    return {
      key: d, label: shortDay(d), a: c, b, dash: d > today,
      tip: t.length ? (
        <>
          <b>{longDay(d)}{d === today ? ` · ${L('đến giờ', 'so far')}` : ''}</b><br />
          <b>{fmt(c + b)}</b> · {sales(t.length)}<br />
          {payLabel('cash')} <b>{fmt(c)}</b><br />{payLabel('transfer')} <b>{fmt(b)}</b>
        </>
      ) : undefined,
    };
  });
  const hours = inScope.map(s => s.hour);
  const h0 = Math.min(9, ...hours), h1 = Math.max(21, ...hours);
  const hourCols: Col[] = [];
  if (isDay) for (let h = h0; h <= h1; h++) {
    const t = inScope.filter(s => s.hour === h), a = sum(t, s => s.amount);
    hourCols.push({
      key: String(h), label: (h - h0) % 3 === 0 ? `${h}h` : '', a, b: 0,
      tip: t.length ? <><b>{h}:00 – {h + 1}:00</b><br /><b>{fmt(a)}</b> · {sales(t.length)}</> : undefined,
    });
  }
  const peak = Math.max(0, ...hourCols.map(c => c.a));

  // ── transactions ──
  const list = inScope.filter(s => pay === 'all' || s.payment === pay).slice().reverse();
  const visible = list.slice(0, shown);
  const lineLabel = (s: EventSale) => {
    // Paid and free units of the same product are two rows in the database: shown as one item.
    const m = new Map<string, { name: string; qty: number; free: number }>();
    for (const l of s.lines) {
      const cur = m.get(l.sku) ?? { name: l.name, qty: 0, free: 0 };
      if (l.free) cur.free += l.qty; else cur.qty += l.qty;
      m.set(l.sku, cur);
    }
    return Array.from(m.values());
  };

  function pick(next: string) {
    setScope(next); setShown(6); setOpenSales(new Set()); setAllProducts(false);
  }
  const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };

  return (
    <div className="space-y-3">
      {/* Period: the whole event, or one of its days. Always fits: equal cells, no sideways scroll
          up to a week; a longer event scrolls. */}
      <div className={days.length <= 6 ? 'grid gap-1.5' : 'flex gap-1.5 overflow-x-auto pb-0.5'}
        style={days.length <= 6 ? { gridTemplateColumns: `repeat(${days.length + 1}, minmax(0, 1fr))` } : undefined}>
        {[{ k: 'all', top: 'Event', main: L('Tất cả', 'All'), off: false, dot: false },
          ...days.map(d => ({ k: d, top: wd(d, 'short'), main: d.slice(8, 10), off: d > today, dot: d === today }))].map(c => (
          <button key={c.k} onClick={() => pick(c.k)} disabled={c.off}
            className="relative rounded-xl text-center disabled:opacity-45 flex-shrink-0"
            style={{
              padding: '7px 2px 8px', minHeight: 50, minWidth: days.length <= 6 ? undefined : 58,
              backgroundColor: scope === c.k ? NAVY : '#fff', color: scope === c.k ? '#fff' : INK,
              border: `1px solid ${scope === c.k ? NAVY : BORDER}`,
            }}>
            {c.dot && <span className="absolute rounded-full" style={{ top: 6, right: 7, width: 6, height: 6, backgroundColor: '#C9A84C' }} />}
            <span className="block text-[10px] font-extrabold uppercase tracking-wide" style={{ color: scope === c.k ? '#F0D98A' : FAINT }}>{c.top}</span>
            <span className="block text-[15px] font-extrabold">{c.main}</span>
          </button>
        ))}
      </div>

      {/* Headline + cash / transfer */}
      <div className="bg-white rounded-2xl p-3.5" style={card}>
        <div className="flex items-start justify-between gap-2">
          <div className={label} style={{ color: FAINT }}>
            {isDay ? `${longDay(scope)}${scope === today ? ` · ${L('đến giờ', 'so far')}` : ''}` : L('Tổng doanh thu event', 'Total event sales')}
          </div>
          <button onClick={load} disabled={loading} className="flex-shrink-0 -mt-1 -mr-1 w-8 h-8 flex items-center justify-center rounded-lg" aria-label={L('Tải lại', 'Refresh')} style={{ color: MUTED }}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          </button>
        </div>
        <div className="text-[30px] font-extrabold leading-tight" style={{ color: NAVY }}>{fmt(totals.total)}</div>
        {totals.count > 0 && (
          <div className="flex mt-3" style={{ gap: 2, height: 12 }}>
            {totals.cash > 0 && <span style={{ width: `${(totals.cash / totals.total) * 100}%`, backgroundColor: CASH, borderRadius: totals.transfer > 0 ? '6px 0 0 6px' : 6 }} />}
            {totals.transfer > 0 && <span style={{ flex: 1, backgroundColor: TRANSFER, borderRadius: totals.cash > 0 ? '0 6px 6px 0' : 6 }} />}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 mt-2.5">
          {(['cash', 'transfer'] as const).map(p => {
            const amount = p === 'cash' ? totals.cash : totals.transfer, n = p === 'cash' ? totals.cashCount : totals.count - totals.cashCount;
            return (
              <button key={p} onClick={() => { setPay(pay === p ? 'all' : p); setShown(6); }} className="text-left rounded-xl min-w-0"
                style={{ padding: '9px 10px', border: `1px solid ${pay === p ? NAVY : HAIR}` }}>
                <div className="flex items-center gap-1.5 text-[11.5px] font-bold" style={{ color: MUTED }}>
                  <span className="rounded-sm flex-shrink-0" style={{ width: 10, height: 10, backgroundColor: p === 'cash' ? CASH : TRANSFER }} />{payLabel(p, true)}
                </div>
                <div className="text-base font-extrabold mt-0.5" style={{ color: INK }}>{fmt(amount)}</div>
                <div className="text-[11px]" style={{ color: MUTED }}>{totals.total ? (p === 'cash' ? pc : 100 - pc) : 0}% · {sales(n)}</div>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 pt-3" style={{ borderTop: `1px solid ${HAIR}` }}>
          <div><div className="text-[15px] font-extrabold" style={{ color: INK }}>{totals.count}</div><div className="text-[10.5px] leading-tight" style={{ color: MUTED }}>{L('đơn', 'sales')}</div></div>
          <div><div className="text-[15px] font-extrabold" style={{ color: INK }}>{fmt(totals.count ? Math.round(totals.total / totals.count / 1000) * 1000 : 0)}</div><div className="text-[10.5px] leading-tight" style={{ color: MUTED }}>{L('trung bình mỗi đơn', 'average sale')}</div></div>
          <div>
            <div className="text-[15px] font-extrabold" style={{ color: INK }}>{totals.units}</div>
            <div className="text-[10.5px] leading-tight" style={{ color: MUTED }}>{L('sản phẩm đã xuất', 'units out')}</div>
            {totals.free > 0 && <div className="text-[10.5px] leading-tight font-semibold" style={{ color: GOLD_TEXT }}>{L(`gồm ${totals.free} miễn phí`, `incl. ${totals.free} free`)}</div>}
          </div>
        </div>
      </div>

      {/* Per day (whole event) — or per hour (one day) */}
      {!isDay ? (
        <div className="bg-white rounded-2xl p-3.5" style={card}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-[14.5px] font-extrabold" style={{ color: INK }}>{L('Theo ngày', 'Per day')}</div>
            <div className="flex gap-3 text-[11px] font-semibold" style={{ color: MUTED }}>
              <span className="inline-flex items-center gap-1.5"><i className="rounded-sm" style={{ width: 10, height: 10, backgroundColor: CASH }} />{payLabel('cash')}</span>
              <span className="inline-flex items-center gap-1.5"><i className="rounded-sm" style={{ width: 10, height: 10, backgroundColor: TRANSFER }} />{payLabel('transfer')}</span>
            </div>
          </div>
          <Columns items={dayCols} stack showLabel={() => true} barWidth={days.length > 7 ? 14 : 24} />
          <table className="w-full mt-2.5" style={{ borderCollapse: 'collapse', fontSize: 'clamp(10px, 3.1vw, 11.5px)' }}>
            <thead>
              <tr style={{ color: FAINT }}>
                {[L('Ngày', 'Day'), payLabel('cash'), payLabel('transfer'), L('Tổng ₫', 'Total ₫')].map((h, i) => (
                  <th key={h} className="text-[9.5px] font-extrabold uppercase tracking-wide pb-1.5" style={{ textAlign: i ? 'right' : 'left', paddingLeft: i ? 6 : 0, borderBottom: `1px solid ${HAIR}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dayCols.map(c => {
                const n = all.filter(s => s.day === c.key).length;
                const cell = { padding: '8px 0 8px 4px', borderBottom: `1px solid ${HAIR}`, textAlign: 'right' as const, whiteSpace: 'nowrap' as const };
                if (c.dash) {
                  return (
                    <tr key={c.key}><td className="font-bold" style={{ ...cell, textAlign: 'left', paddingLeft: 0 }}>{c.label}</td>
                      <td colSpan={3} style={{ ...cell, color: FAINT }}>{L('chưa bắt đầu', 'not started')}</td></tr>
                  );
                }
                return (
                  <tr key={c.key} onClick={() => pick(c.key)} className="cursor-pointer tabular-nums">
                    <td className="font-bold" style={{ ...cell, textAlign: 'left', paddingLeft: 0 }}>{c.label}
                      <span className="block text-[10.5px] font-medium" style={{ color: MUTED }}>{sales(n)}{c.key === today ? ` · ${L('đến giờ', 'so far')}` : ''}</span></td>
                    <td style={cell}>{num(c.a)}</td><td style={cell}>{num(c.b)}</td><td className="font-extrabold" style={cell}>{num(c.a + c.b)}</td>
                  </tr>
                );
              })}
              <tr className="tabular-nums font-extrabold" style={{ color: NAVY }}>
                {[L('Tổng', 'Event'), num(totals.cash), num(totals.transfer), num(totals.total)].map((v, i) => (
                  <td key={i} style={{ padding: '8px 0 2px 6px', paddingLeft: i ? 6 : 0, borderTop: `1.5px solid ${NAVY}`, textAlign: i ? 'right' : 'left', whiteSpace: 'nowrap' }}>
                    {v}{i === 0 && <span className="block text-[10.5px] font-medium" style={{ color: MUTED }}>{sales(totals.count)}</span>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : totals.count > 0 && (
        <div className="bg-white rounded-2xl p-3.5" style={card}>
          <div className="text-[14.5px] font-extrabold mb-2" style={{ color: INK }}>{L('Doanh thu theo giờ', 'Sales by hour')}</div>
          <Columns items={hourCols} stack={false} barWidth={14} height={160} showLabel={c => c.a === peak} />
        </div>
      )}

      {/* What sold */}
      <div className="bg-white rounded-2xl p-3.5" style={card}>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 mb-1.5">
          <div className="text-[14.5px] font-extrabold whitespace-nowrap" style={{ color: INK }}>{L('Sản phẩm đã bán', 'What sold')}</div>
          <div className="flex rounded-lg flex-shrink-0" style={{ backgroundColor: GOLD_PALE, padding: 3, gap: 2 }}>
            {([['cat', L('Danh mục', 'By category')], ['prod', L('Sản phẩm', 'By product')]] as const).map(([k, t]) => (
              <button key={k} onClick={() => setMode(k)} className="text-[11.5px] font-bold rounded-md"
                style={{ padding: '5px 9px', color: GOLD_TEXT, backgroundColor: mode === k ? '#fff' : 'transparent', boxShadow: mode === k ? `0 0 0 1px ${BORDER}` : undefined }}>{t}</button>
            ))}
          </div>
        </div>
        {!breakdown.products.length ? (
          <div className="py-3 text-center text-[12.5px]" style={{ color: MUTED }}>{L('Chưa có đơn nào.', 'No sale yet.')}</div>
        ) : mode === 'cat' ? breakdown.categories.map((c, i) => {
          const open = openCats.has(c.name), mx = breakdown.categories[0].revenue || 1;
          return (
            <div key={c.name} style={{ borderTop: i ? `1px solid ${HAIR}` : undefined }}>
              <button onClick={() => setOpenCats(toggle(openCats, c.name))} className="block w-full text-left py-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 min-w-0 text-[13px] font-bold" style={{ color: INK }}>{c.name}</span>
                  <span className="flex-shrink-0 text-[11.5px] tabular-nums" style={{ color: MUTED }}>{c.qty} {L('cái', 'pcs')} · {totals.total ? Math.round((c.revenue / totals.total) * 100) : 0}%</span>
                  <span className="flex-shrink-0 text-[13px] font-extrabold tabular-nums text-right" style={{ color: INK, minWidth: 84 }}>{fmt(c.revenue)}</span>
                  <ChevronDown size={15} className="flex-shrink-0 self-center" style={{ color: FAINT, transform: open ? 'rotate(180deg)' : undefined }} />
                </div>
                <div className="mt-1.5" style={{ height: 6, borderRadius: '0 4px 4px 0', backgroundColor: CASH, width: `${Math.max(2, (c.revenue / mx) * 100)}%` }} />
              </button>
              {open && (
                <div className="mb-2 pl-2.5" style={{ borderLeft: `2px solid ${HAIR}` }}>
                  {c.items.map(p => (
                    <div key={p.sku} className="flex items-baseline gap-2 py-1 text-xs">
                      <span className="flex-1 min-w-0" style={{ color: INK }}>{p.name}</span>
                      <span className="flex-shrink-0 tabular-nums" style={{ color: MUTED }}>×{p.qty}</span>
                      <span className="flex-shrink-0 font-bold tabular-nums text-right" style={{ color: INK, minWidth: 80 }}>{fmt(p.revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }) : (
          <>
            {(allProducts ? breakdown.products : breakdown.products.slice(0, 8)).map((p, i) => (
              <div key={p.sku} className="py-2.5" style={{ borderTop: i ? `1px solid ${HAIR}` : undefined }}>
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 min-w-0 text-[13px] font-bold" style={{ color: INK }}>{p.name}</span>
                  <span className="flex-shrink-0 text-[11.5px] tabular-nums" style={{ color: MUTED }}>×{p.qty}</span>
                  <span className="flex-shrink-0 text-[13px] font-extrabold tabular-nums text-right" style={{ color: INK, minWidth: 84 }}>{fmt(p.revenue)}</span>
                </div>
                <div className="mt-1.5" style={{ height: 6, borderRadius: '0 4px 4px 0', backgroundColor: CASH, width: `${Math.max(2, (p.revenue / (breakdown.products[0].revenue || 1)) * 100)}%` }} />
              </div>
            ))}
            {!allProducts && breakdown.products.length > 8 && (
              <button onClick={() => setAllProducts(true)} className="block w-full mt-2 rounded-xl text-center text-[12.5px] font-extrabold" style={{ padding: 10, backgroundColor: GOLD_PALE, color: GOLD_TEXT }}>
                {L(`Xem ${breakdown.products.length - 8} sản phẩm khác`, `Show the ${breakdown.products.length - 8} other products`)}
              </button>
            )}
          </>
        )}
      </div>

      {/* Transactions: one line per sale, newest first, grouped by day */}
      <div className="bg-white rounded-2xl p-3.5" style={card}>
        <div className="text-[14.5px] font-extrabold mb-2.5" style={{ color: INK }}>{L('Giao dịch', 'Transactions')}</div>
        <div className="flex gap-1.5 flex-wrap">
          {([['all', L('Tất cả', 'All'), totals.count], ['cash', payLabel('cash'), totals.cashCount], ['transfer', payLabel('transfer'), totals.count - totals.cashCount]] as const).map(([k, t, n]) => (
            <button key={k} onClick={() => { setPay(k); setShown(6); }} className="text-xs font-bold rounded-full whitespace-nowrap"
              style={{ padding: '6px 11px', minHeight: 32, backgroundColor: pay === k ? NAVY : '#fff', color: pay === k ? '#fff' : INK, border: `1px solid ${pay === k ? NAVY : BORDER}` }}>
              {t} <span className="font-semibold" style={{ opacity: 0.75, fontSize: 11 }}>{n}</span>
            </button>
          ))}
        </div>
        {!list.length && <div className="pt-4 pb-1 text-center text-[12.5px]" style={{ color: MUTED }}>{inScope.length ? L('Không có đơn nào cho bộ lọc này.', 'No sale for this filter.') : L('Chưa có đơn nào.', 'No sale yet.')}</div>}
        {visible.map((s, i) => {
          const head = i === 0 || visible[i - 1].day !== s.day;
          const dayList = head ? list.filter(x => x.day === s.day) : [];
          const open = openSales.has(s.no), items = lineLabel(s);
          return (
            <div key={s.no}>
              {head && (
                <div className="flex items-baseline justify-between gap-2 mt-3.5 pb-1" style={{ borderBottom: `1.5px solid ${NAVY}` }}>
                  <b className="text-[12.5px] font-extrabold" style={{ color: NAVY }}>{longDay(s.day)}</b>
                  <span className="text-[11.5px] font-semibold text-right" style={{ color: MUTED }}>{sales(dayList.length)} · {fmt(sum(dayList, x => x.amount))}</span>
                </div>
              )}
              <button onClick={() => setOpenSales(toggle(openSales, s.no))} className="block w-full text-left py-2.5" style={{ borderBottom: `1px solid ${HAIR}` }}>
                <div className="flex items-start gap-2.5">
                  <div className="flex-shrink-0" style={{ width: 44 }}>
                    <b className="block text-[13px] font-extrabold tabular-nums" style={{ color: INK }}>{s.time.slice(0, 5)}</b>
                    <span className="text-[10.5px] tabular-nums" style={{ color: FAINT }}>#{s.no}</span>
                  </div>
                  <div className="flex-1 min-w-0 text-[12.5px] font-semibold leading-snug" style={{ color: INK }}>
                    {items.map((it, k) => (
                      <span key={k}>{k ? ', ' : ''}{it.name}{it.qty > 1 ? ` ×${it.qty}` : ''}{it.qty === 0 && it.free > 1 ? ` ×${it.free}` : ''}
                        {it.free > 0 && <span style={{ color: GOLD_TEXT }}> {it.qty > 0 ? `+${it.free} ` : ''}{L('miễn phí', 'free')}</span>}</span>
                    ))}
                    {!items.length && L('Đơn hàng', 'Sale')}
                    {s.seller && <span className="block text-[11px] font-medium mt-0.5" style={{ color: MUTED }}>{s.seller}</span>}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <b className="block text-[13px] font-extrabold whitespace-nowrap tabular-nums" style={{ color: INK }}>{fmt(s.amount)}</b>
                    <PayBadge pay={s.payment} label={payLabel(s.payment)} />
                  </div>
                </div>
              </button>
              {open && (
                <div className="rounded-xl text-xs" style={{ margin: '8px 0 2px 54px', padding: '10px 11px', backgroundColor: GOLD_PALE }}>
                  {s.lines.map((l, k) => (
                    <div key={k} className="flex gap-2 py-0.5" style={{ color: l.free ? GOLD_TEXT : INK, fontWeight: l.free ? 700 : undefined }}>
                      <span className="flex-1 min-w-0">{l.name}
                        <span className="block text-[11px]" style={{ color: l.free ? GOLD_TEXT : MUTED }}>{l.free ? `${L('miễn phí', 'free')} ×${l.qty}` : `${l.qty} × ${num(l.unitPrice)} ₫`}</span></span>
                      <span className="flex-shrink-0 font-bold tabular-nums">{fmt(l.qty * l.unitPrice)}</span>
                    </div>
                  ))}
                  <div className="mt-2 pt-2 text-[11px] leading-relaxed" style={{ borderTop: `1px solid ${BORDER}`, color: MUTED }}>
                    {L('Đơn', 'Sale')} <b style={{ color: INK }}>#{s.no}</b> · {s.day.slice(8, 10)}/{s.day.slice(5, 7)}/{s.day.slice(0, 4)} {L('lúc', 'at')} <b style={{ color: INK }}>{s.time}</b><br />
                    {L('Thanh toán', 'Paid by')}: <b style={{ color: INK }}>{payLabel(s.payment, true)}</b>
                    {s.seller && <><br />{L('Người bán', 'Sold by')}: <b style={{ color: INK }}>{s.seller}</b></>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {list.length > visible.length && (
          <button onClick={() => setShown(shown + 20)} className="block w-full mt-2.5 rounded-xl text-center text-[12.5px] font-extrabold" style={{ padding: 10, backgroundColor: GOLD_PALE, color: GOLD_TEXT }}>
            {L(`Xem thêm 20 · còn ${list.length - visible.length}`, `Show 20 more · ${list.length - visible.length} left`)}
          </button>
        )}
      </div>
    </div>
  );
}
