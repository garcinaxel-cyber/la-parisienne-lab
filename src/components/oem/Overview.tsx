'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Bar, Card, Empty } from './ui';
import { fmt, dmy, itemKg, unitLabel, GREEN, MUTED, FAINT, type Client, type Derived, type LFn, type ProdLog, type PackLog, type Item } from './model';

// Daily operations → Overview. Three steps per client: ① baked (kg, Hung) ② packed ③ delivered
// (from the delivery check). "Ready to deliver" = packed − delivered − faulty bags.
export default function Overview({ clients, d, prod, pack, L }: { clients: Client[]; d: Derived; prod: ProdLog[]; pack: PackLog[]; L: LFn }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!clients.length) return <Empty text={L('Chưa có đơn hàng OEM.', 'No OEM order yet.')} />;
  return (
    <div className="space-y-6">
      {clients.map(c => {
        const items = c.groups.flatMap(g => g.items);
        const kgUnit = items.every(i => i.unit === 'kg');
        const target = c.groups.reduce((s, g) => s + (d.targetKg[g.key] ?? 0), 0);
        const baked = c.groups.reduce((s, g) => s + (d.producedKg[g.key] ?? 0), 0);
        const ordered = items.reduce((s, i) => s + i.qty_ordered, 0);
        const packed = items.reduce((s, i) => s + (d.packedQty[i.sku] ?? 0), 0);
        const delivered = items.reduce((s, i) => s + (d.deliveredQty[i.sku] ?? 0), 0);
        const ready = items.reduce((s, i) => s + Math.max(0, d.fgTheo[i.sku] ?? 0), 0);
        const u = kgUnit ? 'kg' : L('gói', 'bags');
        const kpis = [
          { n: '①', label: L('Đã nướng (Hưng)', 'Baked (Hưng)'), val: `${fmt(baked)} kg`, sub: `${fmt(target ? (baked / target) * 100 : 0)}% ${L('của', 'of')} ${fmt(target, 0)} kg`, pct: target ? (baked / target) * 100 : 0 },
          { n: '②', label: L('Đã đóng gói', 'Packed'), val: `${fmt(packed, kgUnit ? 1 : 0)} ${u}`, sub: `${fmt(ordered ? (packed / ordered) * 100 : 0)}% ${L('của đơn', 'of the order')}`, pct: ordered ? (packed / ordered) * 100 : 0 },
          { n: '③', label: L('Đã giao', 'Delivered'), val: `${fmt(delivered, kgUnit ? 1 : 0)} ${u}`, sub: L('từ kiểm tra giao hàng', 'from delivery check'), pct: ordered ? (delivered / ordered) * 100 : 0 },
          { n: '', label: L('Sẵn sàng giao', 'Ready to deliver'), val: `${fmt(ready, kgUnit ? 1 : 0)} ${u}`, sub: L('đã gói, chưa giao', 'packed, not yet delivered'), pct: -1 },
        ];
        return (
          <section key={c.name} className="space-y-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <div className="text-base font-bold" style={{ color: '#111827' }}>{c.name}</div>
              <div className="text-xs" style={{ color: MUTED }}>{fmt(ordered, 0)} {u} · {fmt(target, 0)} kg</div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {kpis.map(k => (
                <Card key={k.label} className="p-3 space-y-1.5">
                  <div className="text-[11px] font-semibold" style={{ color: MUTED }}>{k.n} {k.label}</div>
                  <div className="text-lg font-bold" style={{ color: k.pct < 0 ? '#B45309' : GREEN }}>{k.val}</div>
                  <div className="text-[11px]" style={{ color: FAINT }}>{k.sub}</div>
                  {k.pct >= 0 && <Bar pct={k.pct} h={1.5} />}
                </Card>
              ))}
            </div>

            <Card className="overflow-hidden">
              {c.groups.map((g, gi) => {
                const gt = d.targetKg[g.key] ?? 0; const gb = d.producedKg[g.key] ?? 0;
                const isOpen = open === g.key;
                return (
                  <div key={g.key} style={{ borderTop: gi ? '1px solid #F3F4F6' : undefined }}>
                    <button onClick={() => setOpen(isOpen ? null : g.key)} className="w-full text-left px-3 py-2.5 flex items-center gap-3">
                      {isOpen ? <ChevronDown size={14} style={{ color: FAINT }} /> : <ChevronRight size={14} style={{ color: FAINT }} />}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-sm font-bold" style={{ color: '#111827' }}>{g.name}</span>
                          <span className="text-[11px]" style={{ color: MUTED }}>
                            {L('Nướng', 'Baked')} <b style={{ color: '#111827' }}>{fmt(gb)}</b> / {fmt(gt, 0)} kg · {L('bán TP còn', 'bulk on hand')} <b style={{ color: '#111827' }}>{fmt(Math.max(0, d.bulkAvail[g.key] ?? 0))} kg</b>
                          </span>
                        </div>
                        <div className="mt-1.5"><Bar pct={gt ? (gb / gt) * 100 : 0} h={1.5} /></div>
                      </div>
                    </button>
                    <div className="px-3 pb-2.5 pl-9 space-y-1.5">
                      {g.items.map(i => <SkuRow key={i.sku} i={i} d={d} L={L} />)}
                      {g.items.length > 1 && (
                        <div className="text-[10px] italic" style={{ color: FAINT }}>{L('Bán thành phẩm dùng chung — chia 80 g / 100 g khi đóng gói.', 'Shared bulk — the 80 g / 100 g split is decided at packaging.')}</div>
                      )}
                      {isOpen && <DayDetail g={g.key} items={g.items} prod={prod} pack={pack} L={L} />}
                    </div>
                  </div>
                );
              })}
            </Card>
          </section>
        );
      })}
    </div>
  );
}

function SkuRow({ i, d, L }: { i: Item; d: Derived; L: LFn }) {
  const packed = d.packedQty[i.sku] ?? 0; const deliv = d.deliveredQty[i.sku] ?? 0;
  const dec = i.unit === 'kg' ? 1 : 0; const u = unitLabel(i, L);
  return (
    <div className="grid grid-cols-12 items-center gap-2 text-[11px]">
      <div className="col-span-12 sm:col-span-4 truncate" style={{ color: '#374151' }}>{i.product_name} <span style={{ color: FAINT }}>· {i.sku}</span></div>
      <div className="col-span-3 sm:col-span-2" style={{ color: MUTED }}>{L('Đặt', 'Ordered')} <b style={{ color: '#111827' }}>{fmt(i.qty_ordered, 0)}</b></div>
      <div className="col-span-3 sm:col-span-2" style={{ color: MUTED }}>{L('Gói', 'Packed')} <b style={{ color: '#111827' }}>{fmt(packed, dec)}</b></div>
      <div className="col-span-3 sm:col-span-2" style={{ color: MUTED }}>{L('Giao', 'Deliv.')} <b style={{ color: '#111827' }}>{fmt(deliv, dec)}</b></div>
      <div className="col-span-3 sm:col-span-2 flex items-center gap-1.5">
        <div className="flex-1"><Bar pct={i.qty_ordered ? (packed / i.qty_ordered) * 100 : 0} h={1.5} color="#B8893B" /></div>
        <span style={{ color: MUTED }}>{fmt(Math.max(0, i.qty_ordered - packed), dec)} {u}</span>
      </div>
    </div>
  );
}

function DayDetail({ g, items, prod, pack, L }: { g: string; items: Item[]; prod: ProdLog[]; pack: PackLog[]; L: LFn }) {
  const bySku: Record<string, Item> = {}; for (const i of items) bySku[i.sku] = i;
  const days: Record<string, { baked: number; packedKg: number; scrap: number }> = {};
  for (const l of prod) if (l.group_key === g) (days[l.prod_date] ??= { baked: 0, packedKg: 0, scrap: 0 }).baked += Number(l.weight_kg);
  for (const p of pack) if (p.group_key === g) {
    const e = (days[p.pack_date] ??= { baked: 0, packedKg: 0, scrap: 0 });
    if (p.kind === 'packed' && bySku[p.sku]) e.packedKg += itemKg(bySku[p.sku], Number(p.qty));
    if (p.kind === 'scrap_bulk') e.scrap += Number(p.qty);
  }
  const rows = Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 21);
  if (!rows.length) return <div className="text-[11px] pt-1" style={{ color: FAINT }}>{L('Chưa có dữ liệu theo ngày.', 'No day-by-day data yet.')}</div>;
  return (
    <div className="mt-1 rounded-lg overflow-hidden" style={{ border: '1px solid #F3F4F6' }}>
      <div className="grid grid-cols-4 text-[10px] font-bold uppercase px-2 py-1" style={{ backgroundColor: '#F9FAFB', color: FAINT }}>
        <span>{L('Ngày', 'Day')}</span><span className="text-right">{L('Nướng', 'Baked')}</span><span className="text-right">{L('Đóng gói', 'Packed')}</span><span className="text-right">{L('Hao hụt', 'Scrap')}</span>
      </div>
      {rows.map(([day, v]) => (
        <div key={day} className="grid grid-cols-4 text-[11px] px-2 py-1" style={{ borderTop: '1px solid #F3F4F6' }}>
          <span style={{ color: MUTED }}>{dmy(day)}</span>
          <span className="text-right">{v.baked ? `${fmt(v.baked)} kg` : '—'}</span>
          <span className="text-right">{v.packedKg ? `${fmt(v.packedKg)} kg` : '—'}</span>
          <span className="text-right">{v.scrap ? `${fmt(v.scrap)} kg` : '—'}</span>
        </div>
      ))}
    </div>
  );
}
