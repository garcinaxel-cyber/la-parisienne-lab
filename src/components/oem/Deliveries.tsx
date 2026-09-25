'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Card, Chip, Banner, Empty, Title } from './ui';
import { fmt, dmy, unitLabel, MUTED, FAINT, MM_CLIENT, type Delivery, type Derived, type Item, type LFn } from './model';

// Daily operations → Deliveries. Nothing is entered here: one Odoo sales order per delivery goes
// through the usual Delivery check; this tab reads the result (lab_mm_deliveries()).
// "Ready" allocates the current finished-goods stock to the upcoming deliveries by date.
export default function Deliveries({ deliveries, items, d, showCheckLink, L }: { deliveries: Delivery[]; items: Item[]; d: Derived; showCheckLink: boolean; L: LFn }) {
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);
  const [open, setOpen] = useState<string | null>(null);

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
      <Title>{L('Giao hàng', 'Deliveries')}</Title>
      {!orders.length ? <Empty text={L('Chưa có đơn giao OEM nào. Đang chờ lịch giao hàng.', 'No OEM delivery order yet — waiting for the delivery schedule.')} /> : (
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
      <div className="text-[11px]" style={{ color: FAINT }}>
        {L('Mục tiêu theo từng lần giao sẽ được thêm khi có lịch giao hàng.', 'Per-delivery targets will be added once the delivery schedule is received.')}
      </div>
    </div>
  );
}
