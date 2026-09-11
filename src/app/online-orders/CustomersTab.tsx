'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Search } from 'lucide-react';
import * as actions from './actions';
import type { CustomerRecord, CustomerOrderHistoryItem } from './actions';
import { NAVY, CREAM, INK, INK_LIGHT, BORDER, useL, fmtVnd } from './shared';

// "Base de données client" (Axel, 2026-09-11): merges customers from shop-placed orders (via the
// public /order/[token] link) and from the online-sales orders in Track/Stats, grouped by phone
// number — see getCustomerDatabaseAction for the full merge logic and its data-availability notes
// (no price, no payment/delivery status on shop-placed orders). Read-only: no write action here.

type Filter = 'all' | 'new' | 'returning';

export default function CustomersTab() {
  const { tr, lang } = useL();
  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null); // phoneKey

  useEffect(() => {
    actions.getCustomerDatabaseAction().then(res => setCustomers(res.customers ?? []));
  }, []);

  if (!customers) return <div className="text-center py-10" style={{ color: INK_LIGHT }}><Loader2 className="animate-spin inline" /></div>;

  const selectedCustomer = selected ? customers.find(c => c.phoneKey === selected) ?? null : null;
  if (selectedCustomer) {
    return <CustomerDetail customer={selectedCustomer} onBack={() => setSelected(null)} lang={lang} tr={tr} />;
  }

  const q = query.trim().toLowerCase();
  const filtered = customers
    .filter(c => (filter === 'new' ? c.orderCount === 1 : filter === 'returning' ? c.orderCount >= 2 : true))
    .filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.toLowerCase().includes(q));

  return (
    <div>
      <div className="relative mb-3">
        <Search size={14} style={{ color: INK_LIGHT, position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('custSearchPh')}
          className="w-full rounded-lg text-sm"
          style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', padding: '7px 10px 7px 30px', color: INK }} />
      </div>
      <div className="flex gap-2 mb-3 overflow-x-auto">
        {([['all', tr('fAll')], ['new', tr('custPillNew')], ['returning', tr('custPillReturning')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} style={{
            backgroundColor: filter === k ? NAVY : '#fff', color: filter === k ? '#FFFAEE' : INK,
            border: filter === k ? 'none' : `1px solid ${BORDER}`, fontSize: 12, fontWeight: 600, padding: '6px 13px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{label}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 8 }}>{filtered.length} {tr('custCountSuffix')}</div>
      {filtered.length === 0 && <div className="text-center py-10 text-sm" style={{ color: INK_LIGHT }}>{tr('custNoResults')}</div>}
      <div className="space-y-2.5">
        {filtered.map(c => <CustomerCard key={c.phoneKey} customer={c} onClick={() => setSelected(c.phoneKey)} tr={tr} />)}
      </div>
    </div>
  );
}

function ReturningBadge({ orderCount, tr }: { orderCount: number; tr: (k: any) => string }) {
  const isReturning = orderCount >= 2;
  const label = isReturning ? `${tr('returningCustomerBadge')} (${orderCount - 1} ${tr('priorOrdersSuffix')})` : tr('newCustomerBadge');
  return (
    <span style={{
      backgroundColor: isReturning ? '#DCFCE7' : CREAM, color: isReturning ? '#166534' : '#8a7326',
      fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{label}</span>
  );
}

function CustomerCard({ customer: c, onClick, tr }: { customer: CustomerRecord; onClick: () => void; tr: (k: any) => string }) {
  return (
    <button onClick={onClick} className="w-full text-left rounded-2xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <div className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', fontSize: 14, fontWeight: 700, color: NAVY }}>{c.name}</div>
        <ReturningBadge orderCount={c.orderCount} tr={tr} />
      </div>
      <div style={{ fontSize: 12, color: INK_LIGHT }}>{c.phone}</div>
      <div className="flex items-center justify-between" style={{ fontSize: 11, color: INK_LIGHT, marginTop: 2 }}>
        <span><b style={{ color: INK }}>{c.orderCount} {tr('orders')}</b>{c.totalAmount > 0 || !c.hasUnknownAmounts ? ` · ${fmtVnd(c.totalAmount)}${c.hasUnknownAmounts ? '+' : ''}` : ''}</span>
        <span>{fmtShortDate(c.lastOrderDate)}</span>
      </div>
    </button>
  );
}

function CustomerDetail({ customer: c, onBack, lang, tr }: { customer: CustomerRecord; onBack: () => void; lang: 'vi' | 'en'; tr: (k: any) => string }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <button onClick={onBack} aria-label={tr('custBackAria')} style={{ color: INK, flexShrink: 0 }}><ArrowLeft size={18} /></button>
        <div className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', fontSize: 15, fontWeight: 700, color: NAVY }}>{c.name}</div>
        <ReturningBadge orderCount={c.orderCount} tr={tr} />
      </div>

      <div className="rounded-2xl p-3 mb-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
        <Row label={tr('custPhoneLabel')} value={c.phone} />
        {c.lastAddress && <Row label={tr('custLastAddress')} value={c.lastAddress} swipe />}
        <div style={{ height: 1, backgroundColor: '#F3F4F6', margin: '6px 0' }} />
        <Row label={tr('custTotalOrdersLabel')} value={`${c.orderCount} ${tr('orders')} · ${fmtVnd(c.totalAmount)}${c.hasUnknownAmounts ? '+' : ''}`} strong />
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: 8 }}>{tr('custOrderHistory')}</div>
      <div className="space-y-2">
        {c.history.map(h => <HistoryCard key={h.orderBatchId} item={h} lang={lang} tr={tr} />)}
      </div>
    </div>
  );
}

function Row({ label, value, strong, swipe }: { label: string; value: string; strong?: boolean; swipe?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3" style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 11, color: INK_LIGHT, flexShrink: 0 }}>{label}</div>
      <div className={swipe ? 'overflow-x-auto whitespace-nowrap no-scrollbar text-right' : 'text-right'}
        style={{ WebkitOverflowScrolling: 'touch', fontSize: strong ? 12.5 : 12, fontWeight: strong ? 700 : 600, color: strong ? NAVY : '#1f2937' }}>
        {value}
      </div>
    </div>
  );
}

function HistoryCard({ item: h, lang, tr }: { item: CustomerOrderHistoryItem; lang: 'vi' | 'en'; tr: (k: any) => string }) {
  return (
    <div className="rounded-xl p-3" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff', opacity: h.cancelled ? 0.6 : 1 }}>
      <div className="flex items-center justify-between mb-1.5">
        <span style={{ fontSize: 11.5, fontWeight: 700, color: '#1f2937' }}>{fmtShortDate(h.date, lang)}</span>
        <span style={{
          fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
          backgroundColor: h.origin === 'online' ? '#EFF6FF' : '#FEF3C7', color: h.origin === 'online' ? '#1D4ED8' : '#92600A',
        }}>{h.origin === 'online' ? tr('custOriginOnline') : `🏪 ${h.shopName ?? ''}`}</span>
      </div>
      <div className="overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', fontSize: 12.5, color: NAVY, fontWeight: 600, marginBottom: 6 }}>
        {h.itemsSummary}
      </div>
      <div className="flex items-center justify-between">
        {h.amount != null ? (
          <span style={{ fontSize: 12, fontWeight: 700, color: '#1f2937' }}>{fmtVnd(h.amount)}</span>
        ) : (
          <span style={{ fontSize: 11, color: INK_LIGHT, fontStyle: 'italic' }}>{tr('custPriceUnknown')}</span>
        )}
        <div className="flex gap-1.5">
          {h.cancelled && (
            <span style={{ fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: '2px 7px', backgroundColor: '#FEE2E2', color: '#B91C1C' }}>{tr('custCancelled')}</span>
          )}
          {!h.cancelled && h.delivered != null && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: '2px 7px',
              backgroundColor: h.delivered ? '#DCFCE7' : CREAM, color: h.delivered ? '#166534' : '#8a7326',
            }}>
              {/* 'online' origin's delivered = shop→customer handover (shop_delivered); 'shop'
                  origin's = lab→shop only (no shop_delivered signal exists for a walk-in order) —
                  different meanings, different labels, see getCustomerDatabaseAction. */}
              {h.origin === 'online' ? (h.delivered ? tr('shopDelivered') : tr('shopNot')) : (h.delivered ? tr('labDelivered') : tr('labNot'))}
            </span>
          )}
          {!h.cancelled && h.paymentStatus && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: '2px 7px',
              backgroundColor: h.paymentStatus === 'paid' ? '#DCFCE7' : '#FEE2E2', color: h.paymentStatus === 'paid' ? '#166534' : '#B91C1C',
            }}>{h.paymentStatus === 'paid' ? tr('paidFull') : h.paymentStatus === 'partial' ? tr('partial') : tr('unpaidFull')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtShortDate(iso: string, lang: 'vi' | 'en' = 'vi'): string {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
