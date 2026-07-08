'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, type Team, type AssignmentStatus } from '@/lib/types';
import { ChevronDown, ChevronRight, Clock, Package, CheckCircle2, AlertCircle, ArrowLeft } from 'lucide-react';

// The assistants' cockpit: one row per client order (sales order or replenishment request),
// with the Odoo status, delivery time, and per-line production progress.
export default function OrdersCommandView({ date, imports, assignments, orderLines, userRole }: {
  date: string; imports: any[]; assignments: any[]; orderLines: any[]; userRole: string | null;
}) {
  const { lang } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<'all' | 'sales_order' | 'replenishment'>('all');
  const [shopFilter, setShopFilter] = useState('');

  // Odoo status per order ref (stored in control_report by the Odoo sync)
  const odooStates: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const imp of imports) {
      const states = imp.control_report?.order_states;
      if (states) Object.assign(m, states);
    }
    return m;
  }, [imports]);

  // Assignment status lookup: import + team + variant + product name
  const asgByKey = useMemo(() => {
    const m: Record<string, { status: AssignmentStatus; qty_produced: number; qty_to_produce: number }> = {};
    for (const a of assignments) {
      m[`${a.import_id}||${a.team}||${a.variant_label}||${a.product_name_vi}`] = {
        status: a.status, qty_produced: a.qty_produced, qty_to_produce: a.qty_to_produce,
      };
    }
    return m;
  }, [assignments]);

  type OrderRow = {
    ref: string; source: string; shops: string[]; time: string | null;
    lines: { sku: string; name: string; variant: string; qty: number; team: string; status: AssignmentStatus | null }[];
  };

  const orders: OrderRow[] = useMemo(() => {
    const byRef = new Map<string, OrderRow>();
    for (const ol of orderLines) {
      if (!ol.order_ref || !ol.qty) continue;
      let row = byRef.get(ol.order_ref);
      if (!row) {
        row = { ref: ol.order_ref, source: ol.source_type, shops: [], time: null, lines: [] };
        byRef.set(ol.order_ref, row);
      }
      if (ol.shop_name && !row.shops.includes(ol.shop_name)) row.shops.push(ol.shop_name);
      if (ol.delivery_time && (!row.time || ol.delivery_time < row.time)) row.time = ol.delivery_time;
      const asg = asgByKey[`${ol.import_id}||${ol.team}||${ol.variant_label}||${ol.product_name_vi}`] ?? null;
      row.lines.push({
        sku: ol.product_sku ?? '', name: ol.product_name_vi ?? '', variant: ol.variant_label ?? '',
        qty: ol.qty, team: ol.team ?? '', status: asg?.status ?? null,
      });
    }
    return Array.from(byRef.values()).sort((a, b) => (a.time ?? '99') < (b.time ?? '99') ? -1 : 1);
  }, [orderLines, asgByKey]);

  const shops = useMemo(() => Array.from(new Set(orders.flatMap(o => o.shops))).sort(), [orders]);

  const filtered = orders.filter(o =>
    (sourceFilter === 'all' || o.source === sourceFilter) &&
    (!shopFilter || o.shops.includes(shopFilter))
  );

  const isReady = (l: OrderRow['lines'][number]) => l.status === 'done' || l.status === 'skip';
  const readyCount = (o: OrderRow) => o.lines.filter(isReady).length;
  const totalUnits = filtered.reduce((s, o) => s + o.lines.reduce((x, l) => x + l.qty, 0), 0);
  const readyOrders = filtered.filter(o => readyCount(o) === o.lines.length).length;
  const unconfirmed = filtered.filter(o => {
    const st = odooStates[o.ref];
    return st && st !== 'sale' && st !== 'approved';
  }).length;

  const odooBadge = (ref: string) => {
    const st = odooStates[ref];
    if (!st) return null;
    const confirmed = st === 'sale' || st === 'approved';
    return (
      <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 shrink-0 ${confirmed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
        {confirmed
          ? (lang === 'vi' ? 'Đã xác nhận' : 'Confirmed')
          : st === 'submitted' || st === 'sent'
            ? (lang === 'vi' ? 'Đã gửi' : 'Submitted')
            : (lang === 'vi' ? 'Nháp Odoo' : 'Odoo draft')}
      </span>
    );
  };

  const toggle = (ref: string) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(ref) ? next.delete(ref) : next.add(ref);
    return next;
  });

  const formatDate = new Date(date + 'T00:00:00').toLocaleDateString(
    lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="p-1 rounded-lg hover:bg-border-soft transition-colors">
          <ArrowLeft size={18} className="text-ink-light" />
        </Link>
        <h1 className="font-serif text-2xl font-bold text-navy capitalize">{formatDate}</h1>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: lang === 'vi' ? 'Đơn hàng' : 'Orders', value: filtered.length, icon: Package, color: 'text-navy' },
          { label: lang === 'vi' ? 'Số lượng' : 'Units', value: totalUnits, icon: Package, color: 'text-navy' },
          { label: lang === 'vi' ? 'Sẵn sàng' : 'Ready', value: `${readyOrders}/${filtered.length}`, icon: CheckCircle2, color: 'text-green-600' },
          { label: lang === 'vi' ? 'Chưa xác nhận Odoo' : 'Unconfirmed in Odoo', value: unconfirmed, icon: AlertCircle, color: unconfirmed > 0 ? 'text-amber-600' : 'text-ink-light' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-3 flex items-center gap-2.5">
            <Icon size={18} className={color} />
            <div>
              <div className="text-lg font-bold text-navy leading-tight">{value}</div>
              <div className="text-[11px] text-ink-light">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {([
          ['all', lang === 'vi' ? 'Tất cả' : 'All'],
          ['sales_order', lang === 'vi' ? 'Đơn bán' : 'Sales'],
          ['replenishment', lang === 'vi' ? 'Bổ sung kho' : 'Replenishment'],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setSourceFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              sourceFilter === key ? 'bg-navy text-white' : 'bg-white border border-border-soft text-ink-light hover:text-navy'
            }`}>{label}</button>
        ))}
        {shops.length > 1 && (
          <select value={shopFilter} onChange={e => setShopFilter(e.target.value)} className="input py-1 text-xs w-auto ml-auto">
            <option value="">{lang === 'vi' ? 'Tất cả cửa hàng' : 'All shops'}</option>
            {shops.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>

      {/* Order rows */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center text-ink-light text-sm">
          {lang === 'vi' ? 'Không có đơn nào cho ngày này' : 'No orders for this date'}
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-border-soft">
          {filtered.map(o => {
            const ready = readyCount(o);
            const pct = o.lines.length ? Math.round(ready / o.lines.length * 100) : 0;
            const isOpen = expanded.has(o.ref);
            return (
              <div key={o.ref}>
                <button onClick={() => toggle(o.ref)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-cream/50 transition-colors text-left">
                  {isOpen ? <ChevronDown size={15} className="text-ink-light shrink-0" /> : <ChevronRight size={15} className="text-ink-light shrink-0" />}
                  <span className="font-mono text-xs font-bold text-navy shrink-0">{o.ref}</span>
                  <span className="text-xs text-ink-light truncate flex-1">
                    {o.shops.join(', ')}
                    {o.time && <span className="ml-2 inline-flex items-center gap-1"><Clock size={11} />{o.time}</span>}
                  </span>
                  {odooBadge(o.ref)}
                  <span className={`text-xs shrink-0 ${pct === 100 ? 'text-green-600 font-semibold' : 'text-ink-light'}`}>
                    {ready}/{o.lines.length} {lang === 'vi' ? 'dòng' : 'lines'}
                  </span>
                  <div className="w-16 h-1.5 rounded-full bg-border-soft overflow-hidden shrink-0">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#16A34A' : '#B45309' }} />
                  </div>
                </button>

                {isOpen && (
                  <div className="bg-cream/40 px-4 pb-3 pt-1">
                    <div className="grid grid-cols-12 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-light">
                      <div className="col-span-5">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
                      <div className="col-span-2">{lang === 'vi' ? 'Biến thể' : 'Variant'}</div>
                      <div className="col-span-1 text-center">{lang === 'vi' ? 'SL' : 'Qty'}</div>
                      <div className="col-span-2">{lang === 'vi' ? 'Đội' : 'Team'}</div>
                      <div className="col-span-2 text-right">{lang === 'vi' ? 'Sản xuất' : 'Production'}</div>
                    </div>
                    {o.lines.map((l, i) => {
                      const teamMeta = TEAM_LABELS[l.team as Team];
                      const st = l.status ? STATUS_META[l.status] : null;
                      return (
                        <div key={i} className="grid grid-cols-12 py-1.5 text-sm items-center border-t border-border-soft/60">
                          <div className="col-span-5 min-w-0">
                            <span className="text-navy truncate block text-[13px]">{l.name}</span>
                          </div>
                          <div className="col-span-2 text-xs text-ink-light">{l.variant !== 'Standard' ? l.variant : '–'}</div>
                          <div className="col-span-1 text-center font-bold text-navy">×{l.qty}</div>
                          <div className="col-span-2">
                            {teamMeta
                              ? <span className="text-[11px] font-semibold" style={{ color: teamMeta.color }}>{lang === 'vi' ? teamMeta.vi : teamMeta.en}</span>
                              : <span className="text-[11px] text-ink-light">—</span>}
                          </div>
                          <div className="col-span-2 text-right">
                            {st
                              ? <span className="badge text-white text-[10px]" style={{ backgroundColor: st.color }}>{lang === 'vi' ? st.labelVi : st.labelEn}</span>
                              : <span className="text-[10px] text-ink-light">{lang === 'vi' ? 'Chưa giao đội' : 'Not assigned'}</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
