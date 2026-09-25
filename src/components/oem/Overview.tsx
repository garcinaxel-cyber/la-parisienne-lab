'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Card } from './ui';
import { fmt, dmy, itemKg, unitLabel, GREEN, GOLD, MUTED, FAINT, LINE, type Client, type Derived, type LFn, type ProdLog, type PackLog, type Item, type Group } from './model';

// "Progress" — one card per product with a single 3-segment bar over the order (kg):
// delivered (dark green) · packed, not yet delivered (gold) · baked, not yet packed (light green).
const C_DELIV = '#1A4731', C_PACK = GOLD, C_BAKED = '#A7C4B5', C_REST = '#F1ECE1';

export default function Overview({ client, d, prod, pack, L }: { client: Client; d: Derived; prod: ProdLog[]; pack: PackLog[]; L: LFn }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = client.groups.flatMap(g => g.items);
  const kgUnit = items.every(i => i.unit === 'kg');
  const u = kgUnit ? 'kg' : L('gói', 'bags');
  const dec = kgUnit ? 1 : 0;
  const target = client.groups.reduce((s, g) => s + (d.targetKg[g.key] ?? 0), 0);
  const baked = client.groups.reduce((s, g) => s + (d.producedKg[g.key] ?? 0), 0);
  const ordered = items.reduce((s, i) => s + i.qty_ordered, 0);
  const packed = items.reduce((s, i) => s + (d.packedQty[i.sku] ?? 0), 0);
  const delivered = items.reduce((s, i) => s + (d.deliveredQty[i.sku] ?? 0), 0);
  const ready = items.reduce((s, i) => s + Math.max(0, d.fgTheo[i.sku] ?? 0), 0);

  const tiles = [
    { label: L('Đã nướng', 'Baked'), val: fmt(baked, 0), unit: 'kg', sub: `${fmt(target ? (baked / target) * 100 : 0, 0)}% · ${fmt(target, 0)} kg`, color: '#5E8C74' },
    { label: L('Đã gói', 'Packed'), val: fmt(packed, dec), unit: u, sub: `${fmt(ordered ? (packed / ordered) * 100 : 0, 0)}% · ${fmt(ordered, 0)} ${u}`, color: GOLD },
    { label: L('Đã giao', 'Delivered'), val: fmt(delivered, dec), unit: u, sub: `${fmt(ordered ? (delivered / ordered) * 100 : 0, 0)}%`, color: C_DELIV },
    { label: L('Sẵn sàng giao', 'Ready'), val: fmt(ready, dec), unit: u, sub: L('đã gói, chưa giao', 'packed, not delivered'), color: '#374151' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {tiles.map(t => (
          <Card key={t.label} className="p-3.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: MUTED }}><span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color }} />{t.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums leading-none" style={{ color: '#111827' }}>{t.val} <span className="text-xs font-semibold" style={{ color: FAINT }}>{t.unit}</span></div>
            <div className="mt-1 text-[11px] tabular-nums" style={{ color: FAINT }}>{t.sub}</div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: MUTED }}>
        {[[C_DELIV, L('Đã giao', 'Delivered')], [C_PACK, L('Đã gói', 'Packed')], [C_BAKED, L('Đã nướng, chưa gói', 'Baked, not packed')], [C_REST, L('Còn phải làm', 'To do')]].map(([c, l]) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm" style={{ backgroundColor: c, border: c === C_REST ? `1px solid ${LINE}` : undefined }} />{l}</span>
        ))}
      </div>

      <div className="grid gap-2.5 lg:grid-cols-2">
        {client.groups.map(g => <GroupCard key={g.key} g={g} d={d} open={open === g.key} toggle={() => setOpen(open === g.key ? null : g.key)} prod={prod} pack={pack} L={L} />)}
      </div>
    </div>
  );
}

function GroupCard({ g, d, open, toggle, prod, pack, L }: { g: Group; d: Derived; open: boolean; toggle: () => void; prod: ProdLog[]; pack: PackLog[]; L: LFn }) {
  const T = d.targetKg[g.key] ?? 0;
  const delivKg = g.items.reduce((s, i) => s + itemKg(i, d.deliveredQty[i.sku] ?? 0), 0);
  const packKg = g.items.reduce((s, i) => s + itemKg(i, d.packedQty[i.sku] ?? 0), 0);
  const bulk = Math.max(0, d.bulkAvail[g.key] ?? 0);
  const pct = (x: number) => (T ? Math.max(0, Math.min(100, (x / T) * 100)) : 0);
  const segs = [
    { w: pct(delivKg), c: C_DELIV },
    { w: pct(Math.max(0, packKg - delivKg)), c: C_PACK },
    { w: pct(bulk), c: C_BAKED },
  ];
  const packedPct = T ? (packKg / T) * 100 : 0;
  return (
    <Card className="overflow-hidden">
      <button onClick={toggle} className="w-full text-left p-3.5 space-y-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{g.title}</div>
            <div className="text-[11px] mt-0.5" style={{ color: FAINT }}>{g.skus.join(' · ')}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-lg font-bold tabular-nums" style={{ color: packedPct >= 100 ? '#059669' : '#111827' }}>{fmt(packedPct, 0)}%</span>
            {open ? <ChevronDown size={14} style={{ color: FAINT }} /> : <ChevronRight size={14} style={{ color: FAINT }} />}
          </div>
        </div>
        <div className="flex h-3 rounded-full overflow-hidden" style={{ backgroundColor: C_REST }}>
          {segs.map((s, i) => s.w > 0 && <div key={i} style={{ width: `${s.w}%`, backgroundColor: s.c }} />)}
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums" style={{ color: MUTED }}>
          <span>{L('Nướng', 'Baked')} <b style={{ color: '#111827' }}>{fmt(d.producedKg[g.key] ?? 0, 0)}</b>/{fmt(T, 0)} kg</span>
          <span>{L('Bán TP chờ gói', 'Bulk to pack')} <b style={{ color: '#111827' }}>{fmt(bulk, 1)}</b> kg</span>
          <span className="text-right">{L('Giao', 'Deliv.')} <b style={{ color: '#111827' }}>{fmt(delivKg, 0)}</b> kg</span>
        </div>
      </button>
      <div className="px-3.5 pb-3 space-y-1.5">
        {g.items.map(i => <SkuLine key={i.sku} i={i} d={d} L={L} />)}
        {open && <DayDetail g={g} prod={prod} pack={pack} L={L} />}
      </div>
    </Card>
  );
}

function SkuLine({ i, d, L }: { i: Item; d: Derived; L: LFn }) {
  const packed = d.packedQty[i.sku] ?? 0; const dec = i.unit === 'kg' ? 1 : 0;
  return (
    <div className="flex items-center justify-between gap-2 text-xs rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#FAF8F3' }}>
      <span className="truncate" style={{ color: '#374151' }}>{i.product_name}</span>
      <span className="shrink-0 tabular-nums" style={{ color: MUTED }}>
        <b style={{ color: '#111827' }}>{fmt(packed, dec)}</b> / {fmt(i.qty_ordered, 0)} {unitLabel(i, L)}
        <span style={{ color: FAINT }}> · {L('còn', 'left')} {fmt(Math.max(0, i.qty_ordered - packed), dec)}</span>
      </span>
    </div>
  );
}

function DayDetail({ g, prod, pack, L }: { g: Group; prod: ProdLog[]; pack: PackLog[]; L: LFn }) {
  const bySku: Record<string, Item> = {}; for (const i of g.items) bySku[i.sku] = i;
  const days: Record<string, { baked: number; packedKg: number; scrap: number }> = {};
  for (const l of prod) if (l.group_key === g.key) (days[l.prod_date] ??= { baked: 0, packedKg: 0, scrap: 0 }).baked += Number(l.weight_kg);
  for (const p of pack) if (p.group_key === g.key) {
    const e = (days[p.pack_date] ??= { baked: 0, packedKg: 0, scrap: 0 });
    if (p.kind === 'packed' && bySku[p.sku]) e.packedKg += itemKg(bySku[p.sku], Number(p.qty));
    if (p.kind === 'scrap_bulk') e.scrap += Number(p.qty);
  }
  const rows = Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 21);
  if (!rows.length) return <div className="text-[11px] pt-1" style={{ color: FAINT }}>{L('Chưa có dữ liệu theo ngày.', 'No day-by-day data yet.')}</div>;
  return (
    <div className="mt-2 rounded-lg overflow-hidden" style={{ border: `1px solid ${LINE}` }}>
      <div className="grid grid-cols-4 text-[10px] font-bold uppercase px-2.5 py-1.5" style={{ backgroundColor: '#FAF8F3', color: FAINT }}>
        <span>{L('Ngày', 'Day')}</span><span className="text-right">{L('Nướng', 'Baked')}</span><span className="text-right">{L('Gói', 'Packed')}</span><span className="text-right">{L('Hao hụt', 'Loss')}</span>
      </div>
      {rows.map(([day, v]) => (
        <div key={day} className="grid grid-cols-4 text-[11px] px-2.5 py-1.5 tabular-nums" style={{ borderTop: `1px solid ${LINE}` }}>
          <span style={{ color: MUTED }}>{dmy(day)}</span>
          <span className="text-right">{v.baked ? `${fmt(v.baked)} kg` : '—'}</span>
          <span className="text-right">{v.packedKg ? `${fmt(v.packedKg)} kg` : '—'}</span>
          <span className="text-right">{v.scrap ? `${fmt(v.scrap)} kg` : '—'}</span>
        </div>
      ))}
    </div>
  );
}
