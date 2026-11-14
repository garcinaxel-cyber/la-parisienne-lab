'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Loader2, Search, X } from 'lucide-react';
import * as actions from './actions';
import type { CustomerRecord, CustomerOrderHistoryItem } from './actions';
import { useL, fmtVnd } from './shared';
import { HANOI_DISTRICTS } from '@/lib/hanoi-districts';

// "Base de données client" (Axel, 2026-09-11), UI v2 (2026-11-14): merges customers from
// shop-placed orders (public /order/[token] link) and online-sales orders, grouped by phone
// number — see getCustomerDatabaseAction for the merge logic. Read-only; the only action is
// "New order", which just pre-fills the order form.

const CARD = '#FFFFFF', LINE = '#E6DCCF', PANEL = '#F7F1E8';
const DARK = '#2A1810', INK = '#2E1B12', MUTED = '#6B5A4C', LIGHT = '#8A7A66';
const RED = { bg: '#F5E1DC', fg: '#9A3324' }, GREEN = { bg: '#E2EEE5', fg: '#1F5235' }, AMBER = { bg: '#F1E3C4', fg: '#5F4A10' };
const TONES = [['#EADFD0', '#2A1810'], ['#E5EEF4', '#24425A'], ['#F1E3C4', '#5F4A10']];

type Seg = 'all' | 'new' | 'returning' | 'vip' | 'dormant';
export type CustomerPrefill = { name: string; phone: string; address: string | null; district: string | null };

const dayMs = 86400000;
const toTime = (iso: string) => { const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso); return d.getTime(); };
const initials = (name: string) => { const p = name.trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?'; };
const M = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`;

export default function CustomersTab({ onNewOrder }: { onNewOrder?: (p: CustomerPrefill) => void }) {
  const { tr, lang } = useL();
  const t = (vi: string, en: string) => (lang === 'en' ? en : vi);
  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [seg, setSeg] = useState<Seg>('all');
  const [district, setDistrict] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [limit, setLimit] = useState(80);

  useEffect(() => { actions.getCustomerDatabaseAction().then(res => setCustomers(res.customers ?? [])); }, []);

  const derived = useMemo(() => {
    const list = customers ?? [];
    const now = Date.now();
    const firstOf = (c: CustomerRecord) => Math.min(...c.history.map(h => toTime(h.date)).filter(n => !Number.isNaN(n)));
    const amounts = list.map(c => c.totalAmount).sort((a, b) => b - a);
    const vipCut = amounts[Math.max(0, Math.floor(amounts.length * 0.05) - 1)] ?? Infinity;
    const isNew = (c: CustomerRecord) => now - firstOf(c) <= 30 * dayMs;
    const isRet = (c: CustomerRecord) => c.orderCount >= 2;
    const isVip = (c: CustomerRecord) => c.totalAmount > 0 && c.totalAmount >= vipCut;
    const isDormant = (c: CustomerRecord) => now - toTime(c.lastOrderDate) > 60 * dayMs;
    const counts = { all: list.length, new: list.filter(isNew).length, returning: list.filter(isRet).length, vip: list.filter(isVip).length, dormant: list.filter(isDormant).length };
    return { isNew, isRet, isVip, isDormant, counts, firstOf };
  }, [customers]);

  if (!customers) return <div className="text-center py-12" style={{ color: LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const q = query.trim().toLowerCase();
  const qd = q.replace(/\D/g, '');
  const filtered = customers
    .filter(c => seg === 'all' ? true : seg === 'new' ? derived.isNew(c) : seg === 'returning' ? derived.isRet(c) : seg === 'vip' ? derived.isVip(c) : derived.isDormant(c))
    .filter(c => !district || c.lastDistrict === district)
    .filter(c => !q || c.name.toLowerCase().includes(q) || (qd.length >= 3 && c.phone.replace(/\D/g, '').includes(qd)))
    .sort((a, b) => seg === 'vip' ? b.totalAmount - a.totalAmount : (b.lastOrderDate || '').localeCompare(a.lastOrderDate || ''));
  const sel = selected ? customers.find(c => c.phoneKey === selected) ?? null : null;
  const retPct = customers.length ? Math.round(derived.counts.returning / customers.length * 1000) / 10 : 0;

  const segs: [Seg, string, string][] = [
    ['all', t('Tất cả', 'All'), t('có số điện thoại', 'with a phone number')],
    ['new', t('Mới', 'New'), t('đơn đầu trong 30 ngày', 'first order in the last 30 days')],
    ['returning', t('Quay lại', 'Returning'), t('từ 2 đơn trở lên', 'two orders or more')],
    ['vip', 'VIP', t('top 5% theo chi tiêu', 'top 5% by amount spent')],
    ['dormant', t('Lâu không mua', 'Dormant'), t('không mua từ 60 ngày', 'no order for 60 days or more')],
  ];

  return (
    <div className="flex flex-col gap-4" style={{ color: INK }}>
      <div className="hidden lg:flex items-center justify-between">
        <h1 style={{ margin: 0, fontFamily: "'Playfair Display', Georgia, serif", fontSize: 28, fontWeight: 700, color: DARK }}>{t('Khách hàng', 'Customers')}</h1>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          [t('Khách hàng', 'Customers'), customers.length.toLocaleString('vi-VN'), t('có số điện thoại', 'with a phone number')],
          [t('Quay lại mua', 'Ordered again'), `${retPct}%`, `${derived.counts.returning} ${t('khách', 'customers')}`],
          [t('Khách mới', 'New'), String(derived.counts.new), t('30 ngày qua', 'last 30 days')],
        ].map(([l, v, s]) => (
          <div key={l} className="rounded-2xl flex flex-col gap-0.5" style={{ backgroundColor: CARD, padding: '12px 14px', boxShadow: '0 1px 2px rgba(42,24,16,0.05)' }}>
            <span style={{ fontSize: 11.5, color: MUTED, fontWeight: 600 }}>{l}</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: DARK, letterSpacing: '-0.02em' }}>{v}</span>
            <span style={{ fontSize: 11, color: LIGHT }}>{s}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4 lg:mx-0 lg:px-0">
        {segs.map(([k, label, sub]) => (
          <button key={k} onClick={() => { setSeg(k); setLimit(80); }} title={sub} className="flex-none flex items-center gap-2" style={{
            borderRadius: 999, padding: '7px 13px', fontSize: 12.5, fontWeight: 600,
            backgroundColor: seg === k ? DARK : CARD, color: seg === k ? '#FBF7F0' : INK, border: `1px solid ${seg === k ? DARK : LINE}`,
          }}>{label}<span style={{ opacity: 0.7 }}>{derived.counts[k]}</span></button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label className="flex-1 flex items-center gap-2" style={{ backgroundColor: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: '0 12px', minHeight: 42 }}>
          <Search size={15} color={LIGHT} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('custSearchPh')} className="flex-1 min-w-0 outline-none bg-transparent" style={{ fontSize: 13.5 }} />
          {query && <button onClick={() => setQuery('')} aria-label="clear"><X size={14} color={LIGHT} /></button>}
        </label>
        <select value={district} onChange={e => setDistrict(e.target.value)} style={{ minHeight: 42, borderRadius: 12, border: `1px solid ${LINE}`, backgroundColor: CARD, padding: '0 10px', fontSize: 13, color: district ? INK : LIGHT }}>
          <option value="">{tr('custDistrictFilterAll')}</option>
          {HANOI_DISTRICTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <section className="rounded-2xl overflow-hidden" style={{ backgroundColor: CARD, boxShadow: '0 1px 2px rgba(42,24,16,0.05)' }}>
        <div className="hidden lg:grid gap-3 px-5 py-3" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) 70px 110px 110px', fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: LIGHT, fontWeight: 700, borderBottom: `1px solid ${PANEL}` }}>
          <span>{t('Khách', 'Customer')}</span><span>{t('Quận', 'District')}</span><span style={{ textAlign: 'right' }}>{t('Đơn', 'Orders')}</span><span style={{ textAlign: 'right' }}>{t('Chi tiêu', 'Spent')}</span><span style={{ textAlign: 'right' }}>{t('Đơn gần nhất', 'Last order')}</span>
        </div>
        {filtered.length === 0 && <div className="text-center py-10" style={{ color: LIGHT, fontSize: 13 }}>{tr('custNoResults')}</div>}
        {filtered.slice(0, limit).map((c, i) => {
          const tone = TONES[i % 3];
          const badge = derived.isVip(c) ? ['VIP', AMBER] as const : derived.isRet(c) ? [tr('returningCustomerBadge'), GREEN] as const : null;
          return (
            <button key={c.phoneKey} onClick={() => setSelected(c.phoneKey)} className="w-full text-left grid gap-3 items-center px-4 lg:px-5 py-2.5"
              style={{ borderTop: i ? `1px solid ${PANEL}` : 'none', gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span className="flex items-center gap-3 min-w-0 lg:hidden">
                <span className="flex-none flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: tone[0], color: tone[1], fontSize: 12.5, fontWeight: 700 }}>{initials(c.name)}</span>
                <span className="flex flex-col min-w-0">
                  <span className="flex items-center gap-1.5 min-w-0"><b className="truncate" style={{ fontSize: 14, color: DARK }}>{c.name}</b>{badge && <Pill c={badge[1]}>{badge[0]}</Pill>}</span>
                  <span className="truncate" style={{ fontSize: 12, color: LIGHT }}>{c.phone}{c.lastDistrict ? ` · ${c.lastDistrict}` : ''}</span>
                </span>
              </span>
              <span className="flex flex-col items-end lg:hidden">
                <b style={{ fontSize: 13.5, color: DARK }}>{c.totalAmount > 0 ? M(c.totalAmount) : '—'}</b>
                <span style={{ fontSize: 11.5, color: LIGHT }}>{c.orderCount} {t('đơn', 'orders')} · {fmtShort(c.lastOrderDate, lang)}</span>
              </span>
              <span className="hidden lg:grid gap-3 items-center col-span-2" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr) 70px 110px 110px' }}>
                <span className="flex items-center gap-3 min-w-0">
                  <span className="flex-none flex items-center justify-center" style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: tone[0], color: tone[1], fontSize: 12, fontWeight: 700 }}>{initials(c.name)}</span>
                  <span className="flex flex-col min-w-0"><span className="flex items-center gap-1.5 min-w-0"><b className="truncate" style={{ fontSize: 13.5, color: DARK }}>{c.name}</b>{badge && <Pill c={badge[1]}>{badge[0]}</Pill>}</span><span style={{ fontSize: 11.5, color: LIGHT }}>{c.phone}</span></span>
                </span>
                <span className="truncate" style={{ fontSize: 12.5, color: MUTED }}>{c.lastDistrict ?? '—'}</span>
                <b style={{ textAlign: 'right', fontSize: 13 }}>{c.orderCount}</b>
                <span style={{ textAlign: 'right', fontSize: 13 }}>{c.totalAmount > 0 ? fmtVnd(c.totalAmount) : '—'}{c.hasUnknownAmounts && c.totalAmount > 0 ? '+' : ''}</span>
                <span style={{ textAlign: 'right', fontSize: 12.5, color: MUTED }}>{fmtShort(c.lastOrderDate, lang)}</span>
              </span>
            </button>
          );
        })}
        {filtered.length > limit && (
          <button onClick={() => setLimit(l => l + 120)} className="w-full py-3" style={{ borderTop: `1px solid ${PANEL}`, fontSize: 13, fontWeight: 600, color: '#7A5A12' }}>
            {t('Xem thêm', 'Show more')} ({filtered.length - limit})
          </button>
        )}
      </section>

      {sel && (
        <div className="fixed inset-0 z-40 lg:z-30" onClick={() => setSelected(null)} style={{ backgroundColor: 'rgba(42,24,16,0.18)' }}>
          <aside onClick={e => e.stopPropagation()} className="absolute inset-0 lg:left-auto lg:w-[440px] flex flex-col" style={{ backgroundColor: '#F6F1EA', boxShadow: '-12px 0 32px rgba(42,24,16,0.14)' }}>
            <Detail c={sel} onClose={() => setSelected(null)} t={t} lang={lang} tr={tr} first={derived.firstOf(sel)} onNewOrder={onNewOrder ? () => onNewOrder({ name: sel.name === '—' ? '' : sel.name, phone: sel.phone, address: sel.lastAddress, district: sel.lastDistrict }) : undefined} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Pill({ c, children }: { c: { bg: string; fg: string }; children: React.ReactNode }) {
  return <span className="flex-none" style={{ backgroundColor: c.bg, color: c.fg, fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>{children}</span>;
}

function Detail({ c, onClose, t, lang, tr, first, onNewOrder }: { c: CustomerRecord; onClose: () => void; t: (vi: string, en: string) => string; lang: 'vi' | 'en'; tr: (k: any) => string; first: number; onNewOrder?: () => void }) {
  const dates = c.history.map(h => toTime(h.date)).filter(n => !Number.isNaN(n)).sort((a, b) => a - b);
  const rhythm = dates.length >= 2 ? Math.round((dates[dates.length - 1] - dates[0]) / (dates.length - 1) / dayMs) : null;
  const rhythmLabel = rhythm == null ? '—' : rhythm >= 14 ? `${Math.round(rhythm / 7)} ${t('tuần', 'wk')}` : `${rhythm} ${t('ngày', 'days')}`;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-col gap-3" style={{ backgroundColor: CARD, padding: '14px 18px', borderBottom: `1px solid ${LINE}` }}>
        <button onClick={onClose} className="flex items-center gap-1 w-fit" style={{ fontSize: 14, fontWeight: 600, color: DARK, minHeight: 34 }}><ChevronLeft size={18} />{t('Khách hàng', 'Customers')}</button>
        <div className="flex items-center gap-3">
          <span className="flex-none flex items-center justify-center" style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: '#F1E3C4', color: '#5F4A10', fontWeight: 700 }}>{initials(c.name)}</span>
          <div className="flex flex-col min-w-0">
            <div className="truncate" style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 22, fontWeight: 700, color: DARK }}>{c.name}</div>
            <a href={`tel:${c.phone}`} style={{ fontSize: 13, color: MUTED }}>{c.phone}{c.lastDistrict ? ` · ${c.lastDistrict}` : ''}</a>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[[String(c.orderCount), t('đơn', 'orders')], [c.totalAmount > 0 ? M(c.totalAmount) : '—', t('chi tiêu', 'spent')], [rhythmLabel, t('giữa 2 đơn', 'between orders')]].map(([v, l]) => (
            <div key={l} className="rounded-xl" style={{ backgroundColor: PANEL, padding: '9px 4px' }}><b style={{ fontSize: 17, color: DARK }}>{v}</b><div style={{ fontSize: 11, color: MUTED }}>{l}</div></div>
          ))}
        </div>
        {c.lastAddress && <div style={{ fontSize: 12.5, color: MUTED }}>{tr('custLastAddress')}: <span style={{ color: INK }}>{c.lastAddress}</span></div>}
        {Number.isFinite(first) && <div style={{ fontSize: 12.5, color: MUTED }}>{t('Đơn đầu tiên', 'First order')}: <span style={{ color: INK }}>{fmtShort(new Date(first).toISOString(), lang)}</span></div>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 p-4">
        <div style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: LIGHT, fontWeight: 700 }}>{tr('custOrderHistory')}</div>
        {c.history.map(h => <History key={h.orderBatchId} h={h} lang={lang} tr={tr} />)}
      </div>
      {onNewOrder && (
        <div style={{ backgroundColor: CARD, borderTop: `1px solid ${LINE}`, padding: '10px 16px 18px' }}>
          <button onClick={onNewOrder} className="w-full" style={{ minHeight: 48, borderRadius: 13, backgroundColor: DARK, color: '#FBF7F0', fontSize: 14.5, fontWeight: 700 }}>+ {t('Tạo đơn cho khách này', 'New order for this customer')}</button>
        </div>
      )}
    </div>
  );
}

function History({ h, lang, tr }: { h: CustomerOrderHistoryItem; lang: 'vi' | 'en'; tr: (k: any) => string }) {
  const dim = h.cancelled || h.refunded;
  return (
    <div className="rounded-xl flex justify-between gap-3" style={{ backgroundColor: CARD, padding: '10px 12px', opacity: dim ? 0.6 : 1 }}>
      <span className="flex flex-col gap-0.5 min-w-0">
        <b style={{ fontSize: 13, color: DARK }}>{fmtShort(h.date, lang)} · {h.origin === 'online' ? (h.shopName ?? 'Online') : `🏪 ${h.shopName ?? ''}`}</b>
        <span style={{ fontSize: 12, color: MUTED }}>{h.itemsSummary}</span>
      </span>
      <span className="flex flex-col items-end gap-1 flex-none">
        <b style={{ fontSize: 13 }}>{h.amount != null ? fmtVnd(h.amount) : <i style={{ fontWeight: 400, color: LIGHT }}>{tr('custPriceUnknown')}</i>}</b>
        {h.refunded ? <Pill c={RED}>{tr('custRefunded')}</Pill>
          : h.refundAmount > 0 ? <Pill c={AMBER}>{tr('custPartiallyRefunded')}</Pill>
          : h.cancelled ? <Pill c={RED}>{tr('custCancelled')}</Pill>
          : h.paymentStatus ? <Pill c={h.paymentStatus === 'paid' ? GREEN : h.paymentStatus === 'partial' ? AMBER : RED}>{h.paymentStatus === 'paid' ? tr('paidFull') : h.paymentStatus === 'partial' ? tr('partial') : tr('unpaidFull')}</Pill>
          : null}
      </span>
    </div>
  );
}

function fmtShort(iso: string, lang: 'vi' | 'en' = 'vi'): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
