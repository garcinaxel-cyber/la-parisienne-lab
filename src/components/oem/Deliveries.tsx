'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Card, Chip, Banner, Empty, Title } from './ui';
import { fmt, dmy, itemKg, localToday, unitLabel, MUTED, FAINT, GOLD, MM_CLIENT, type Delivery, type Derived, type Item, type LFn } from './model';
import type { Batch } from './plan';

// Daily operations → Deliveries. Nothing is entered here: one Odoo sales order per delivery goes
// through the usual Delivery check; this tab reads the result (lab_mm_deliveries()).
// "Ready" allocates the current finished-goods stock to the upcoming deliveries by date.
export default function Deliveries({ deliveries, items, d, batches, showCheckLink, L }: { deliveries: Delivery[]; items: Item[]; d: Derived; batches: Batch[]; showCheckLink: boolean; L: LFn }) {
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);
  const [open, setOpen] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<number | null>(null);

  // schedule status: a delivery is "done" when the validated deliveries cover its cumulative bags;
  // the first one not done is compared with the ready stock (finished goods not delivered yet).
  const planStatus = useMemo(() => {
    let firstOpen = true;
    return batches.map(b => {
      const done = items.every(i => (d.deliveredQty[i.sku] ?? 0) >= (b.cumQty[i.sku] ?? 0) - 0.0005);
      const missing = items.reduce((s, i) => s + Math.max(0, (b.cumQty[i.sku] ?? 0) - (d.deliveredQty[i.sku] ?? 0) - Math.max(0, d.fgTheo[i.sku] ?? 0)), 0);
      const isNext = !done && firstOpen; if (isNext) firstOpen = false;
      return { done, missing, isNext };
    });
  }, [batches, items, d]);
  const totalPct = batches.length ? batches[batches.length - 1].cumPct : 0;
  const anyKg = items.some(i => i.unit === 'kg');
  const today = localToday();

  const orders = useMemo(() => {
    const m = new Map<string, { key: string; ref: string; date: string; customer: string; lines: Delivery[] }>();
    for (const x of deliveries) {
      const k = `${x.order_ref}|${x.delivery_date}`;
      if (!m.has(k)) m.set(k, { key: k, ref: x.order_ref, date: x.delivery_date, customer: x.customer ?? '', lines: [] });
      m.get(k)!.lines.push(x);
    }
    return Array.from(m.values()).sort((a, b) => b.date.localeCompare(a.date));
  }, [deliveries]);

  // allocate stock to upcoming (not yet validated, not "not delivered") orders, earliest first
  const alloc = useMemo(() => {
    const stock: Record<string, number> = {}; for (const i of items) stock[i.sku] = Math.max(0, d.fgTheo[i.sku] ?? 0);
    const out: Record<string, Record<string, number>> = {};
    for (const o of [...orders].sort((a, b) => a.date.localeCompare(b.date))) {
      if (o.lines.some(l => l.order_status === 'validated' || l.not_delivered)) continue;
      out[o.key] = {};
      for (const l of o.lines) {
        const need = Number(l.qty_planned ?? l.qty_expected ?? 0);
        const take = Math.min(need, stock[l.sku] ?? 0);
        out[o.key][l.sku] = take; stock[l.sku] = (stock[l.sku] ?? 0) - take;
      }
    }
    return out;
  }, [orders, items, d]);

  const clientOf = (o: { lines: Delivery[] }) => bySku[o.lines[0]?.sku]?.client_name || MM_CLIENT;

  return (
    <div className="space-y-3">
      <Banner>
        {L('Mỗi lần giao = 1 đơn bán Odoo → kiểm tra trong "Kiểm tra giao hàng" như thường lệ. Tab này chỉ đọc kết quả, không nhập lại.',
           'One Odoo sales order per delivery → checked in the usual Delivery check. This tab only reads the result — nobody enters deliveries twice.')}
        {showCheckLink && <> <Link href="/delivery-check" className="inline-flex items-center gap-0.5 font-bold underline">{L('Mở kiểm tra giao hàng', 'Open delivery check')}<ExternalLink size={11} /></Link></>}
      </Banner>
      {batches.length > 0 && (
        <div className="space-y-1.5">
          <Title right={<span className="text-[11px] font-semibold" style={{ color: Math.abs(totalPct - 100) > 0.01 ? '#B91C1C' : FAINT }}>{fmt(totalPct, 1)} %</span>}>{L('Lịch giao hàng (kế hoạch)', 'Delivery schedule (plan)')}</Title>
          <Card className="overflow-hidden">
            {batches.map((b, k) => {
              const st = planStatus[k]; const isOpen = openPlan === k;
              const bags = items.reduce((s, i) => s + (i.unit === 'kg' ? 0 : b.qty[i.sku] ?? 0), 0);
              const late = !st.done && b.row.delivery_date < today;
              const chip = st.done ? <Chip tone="green">{L('Đã giao', 'Delivered')}</Chip>
                : st.isNext ? (st.missing <= 0.0005 ? <Chip tone="green">{L('Đủ hàng', 'Stock ready')}</Chip> : <Chip tone={late ? 'red' : 'amber'}>{L('Thiếu', 'Missing')} {fmt(st.missing, 0)} {anyKg ? '' : L('gói', 'bags')}</Chip>)
                : <Chip>{L('Nướng trước', 'Bake by')} {dmy(b.produceBy)}</Chip>;
              return (
                <div key={b.row.id} style={{ borderTop: k ? '1px solid #EFE9DC' : undefined, backgroundColor: st.isNext ? '#FFFBF2' : undefined }}>
                  <button onClick={() => setOpenPlan(isOpen ? null : k)} className="w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    {isOpen ? <ChevronDown size={14} style={{ color: FAINT }} /> : <ChevronRight size={14} style={{ color: FAINT }} />}
                    <span className="w-14 font-bold" style={{ color: st.isNext ? GOLD : '#111827' }}>{L('Đợt', 'Del.')} {b.row.seq}</span>
                    <span className="w-[74px]"><b>{dmy(b.row.delivery_date)}</b>{b.row.label && <span className="block text-[10px]" style={{ color: FAINT }}>{b.row.label}</span>}</span>
                    <span className="w-12 text-xs font-semibold tabular-nums" style={{ color: MUTED }}>{fmt(Number(b.row.pct), 1)} %</span>
                    <span className="flex-1 min-w-[110px] text-xs tabular-nums" style={{ color: MUTED }}>{anyKg ? '' : <><b style={{ color: '#111827' }}>{fmt(bags, 0)}</b> {L('gói', 'bags')} · </>}{fmt(b.kg, 0)} kg <span style={{ color: FAINT }}>· {L('cộng dồn', 'cum.')} {fmt(b.cumPct, 0)} %</span></span>
                    {chip}
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pl-9">
                      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #F3F4F6' }}>
                        <div className="grid grid-cols-12 text-[10px] font-bold uppercase px-2 py-1" style={{ backgroundColor: '#F9FAFB', color: FAINT }}>
                          <span className="col-span-6">{L('Sản phẩm', 'Product')}</span><span className="col-span-2 text-right">{L('Đợt này', 'This one')}</span>
                          <span className="col-span-2 text-right">kg</span><span className="col-span-2 text-right">{L('Cộng dồn', 'Cumul.')}</span>
                        </div>
                        {items.map(i => (
                          <div key={i.sku} className="grid grid-cols-12 text-[11px] px-2 py-1" style={{ borderTop: '1px solid #F3F4F6' }}>
                            <span className="col-span-6 truncate">{i.product_name}</span>
                            <span className="col-span-2 text-right font-semibold">{fmt(b.qty[i.sku] ?? 0, i.unit === 'kg' ? 1 : 0)} {unitLabel(i, L)}</span>
                            <span className="col-span-2 text-right">{fmt(itemKg(i, b.qty[i.sku] ?? 0), 1)}</span>
                            <span className="col-span-2 text-right" style={{ color: MUTED }}>{fmt(b.cumQty[i.sku] ?? 0, i.unit === 'kg' ? 1 : 0)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="text-[11px] mt-1.5" style={{ color: FAINT }}>
                        {L(`Bếp Hưng cần nướng xong trước ${dmy(b.produceBy)} (3 ngày trước khi giao: nhận, gói, kiểm).`, `Team Hưng must have baked it by ${dmy(b.produceBy)} (3 days before delivery: reception, packing, count).`)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </div>
      )}
      <div className="space-y-1.5">
        <Title>{L('Hàng sẵn sàng giao', 'Ready to deliver')}</Title>
        <Card className="overflow-hidden">
          {items.map((i, k) => {
            const r = Math.max(0, d.fgTheo[i.sku] ?? 0);
            return (
              <div key={i.sku} className="flex items-center justify-between gap-2 px-3.5 py-2 text-sm" style={{ borderTop: k ? '1px solid #EFE9DC' : undefined }}>
                <span className="min-w-0"><span className="block truncate font-semibold">{i.product_name}</span><span className="block text-[11px]" style={{ color: FAINT }}>{i.sku}</span></span>
                <b className="tabular-nums shrink-0" style={{ color: r > 0 ? '#111827' : FAINT }}>{fmt(r, i.unit === 'kg' ? 1 : 0)} {unitLabel(i, L)}</b>
              </div>
            );
          })}
        </Card>
      </div>
      <Title>{L('Các lần giao', 'Deliveries')}</Title>
      {!orders.length ? <Empty text={L('Chưa có đơn giao OEM nào trong kiểm tra giao hàng.', 'No OEM delivery order in the delivery check yet.')} /> : (
        <Card className="overflow-hidden">
          {orders.map((o, oi) => {
            const isOpen = open === o.key;
            const nd = o.lines.some(l => l.not_delivered);
            const validated = o.lines.some(l => l.order_status === 'validated');
            const checking = !validated && o.lines.some(l => l.order_status);
            const odooOk = o.lines.some(l => l.odoo_validated_at);
            const planned = o.lines.reduce((s, l) => s + Number(l.qty_planned ?? l.qty_expected ?? 0), 0);
            const delivered = o.lines.reduce((s, l) => s + Number(l.qty_checked ?? 0), 0);
            const ready = alloc[o.key] ? Object.values(alloc[o.key]).reduce((s, v) => s + v, 0) : null;
            const kg = o.lines.every(l => bySku[l.sku]?.unit === 'kg');
            const u = kg ? 'kg' : L('gói', 'bags');
            const status = nd ? <Chip tone="red">{L('Không giao', 'Not delivered')}</Chip>
              : validated ? <Chip tone="green">{L('Đã giao', 'Delivered')} · {o.lines[0]?.validated_by_name ?? ''}</Chip>
              : checking ? <Chip tone="blue">{L('Đang kiểm', 'Being checked')}</Chip>
              : ready != null && ready >= planned - 0.0005 ? <Chip tone="green">{L('Đủ hàng', 'Stock ready')}</Chip>
              : <Chip tone="amber">{L('Thiếu', 'Missing')} {fmt(planned - (ready ?? 0), kg ? 1 : 0)} {u}</Chip>;
            return (
              <div key={o.key} style={{ borderTop: oi ? '1px solid #F3F4F6' : undefined }}>
                <button onClick={() => setOpen(isOpen ? null : o.key)} className="w-full text-left px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {isOpen ? <ChevronDown size={14} style={{ color: FAINT }} /> : <ChevronRight size={14} style={{ color: FAINT }} />}
                  <span className="w-[70px] text-xs" style={{ color: MUTED }}>{dmy(o.date)}</span>
                  <span className="font-bold">{o.ref}</span>
                  <span className="text-xs flex-1 min-w-[120px] truncate" style={{ color: MUTED }}>{clientOf(o)}{o.customer && o.customer !== clientOf(o) ? ` · ${o.customer}` : ''}</span>
                  <span className="text-xs" style={{ color: MUTED }}>{L('Kế hoạch', 'Planned')} <b style={{ color: '#111827' }}>{fmt(planned, kg ? 1 : 0)}</b></span>
                  <span className="text-xs" style={{ color: MUTED }}>{validated ? L('Đã giao', 'Delivered') : L('Sẵn', 'Ready')} <b style={{ color: '#111827' }}>{fmt(validated ? delivered : (ready ?? 0), kg ? 1 : 0)}</b> {u}</span>
                  {status}{odooOk && <Chip tone="green">Odoo ✓</Chip>}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 pl-9">
                    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #F3F4F6' }}>
                      <div className="grid grid-cols-12 text-[10px] font-bold uppercase px-2 py-1" style={{ backgroundColor: '#F9FAFB', color: FAINT }}>
                        <span className="col-span-6">{L('Sản phẩm', 'Product')}</span><span className="col-span-2 text-right">{L('Kế hoạch', 'Planned')}</span>
                        <span className="col-span-2 text-right">{L('Sẵn', 'Ready')}</span><span className="col-span-2 text-right">{L('Đã kiểm', 'Checked')}</span>
                      </div>
                      {o.lines.map(l => {
                        const it = bySku[l.sku]; const p = Number(l.qty_planned ?? l.qty_expected ?? 0); const r = alloc[o.key]?.[l.sku];
                        return (
                          <div key={l.sku} className="grid grid-cols-12 text-[11px] px-2 py-1" style={{ borderTop: '1px solid #F3F4F6' }}>
                            <span className="col-span-6 truncate">{it?.product_name ?? l.sku}</span>
                            <span className="col-span-2 text-right">{fmt(p, 1)} {it ? unitLabel(it, L) : ''}</span>
                            <span className="col-span-2 text-right" style={{ color: r != null && r < p ? '#B45309' : undefined }}>{r != null ? fmt(r, 1) : '—'}</span>
                            <span className="col-span-2 text-right">{l.qty_checked != null ? fmt(Number(l.qty_checked), 1) : '—'}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
