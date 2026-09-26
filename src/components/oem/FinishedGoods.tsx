'use client';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { Card, Title, Banner, Chip, Btn, ExprInput, inputCls, inputStyle } from './ui';
import { fmt, dmy, unitLabel, localToday, evalQty, qtyOk, qtyBad, MUTED, FAINT, GREEN, type Client, type Derived, type FgCount, type Item, type LFn } from './model';
import { saveFgCountAction, decideFgCountAction } from '@/lib/oem-actions';

// Inventory → Finished goods (v2, Axel 2026-09-26). The count is the truth:
//  - every product of the client must be counted (0 typed explicitly) before saving;
//  - bags are whole numbers;
//  - lower than theoretical → loss (re-made by Hung; Odoo scrap when sync is on);
//  - higher → packing that was never recorded (consumes the received bulk);
//  - a gap above 20 bags / 2 kg or 2 % waits for an admin (approve / recount).
// Typed numbers are kept on the phone (localStorage) until saved.
export default function FinishedGoods({ client, items, d, counts, canCount, isAdmin, reload, L }: {
  client: Client; items: Item[]; d: Derived; counts: FgCount[]; canCount: boolean; isAdmin: boolean;
  reload: () => Promise<void>; L: LFn;
}) {
  const draftKey = `oem-fg-draft:${client.name}`;
  const [date, setDate] = useState(localToday());
  const [val, setVal] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  useEffect(() => { try { const r = localStorage.getItem(draftKey); setVal(r ? JSON.parse(r) : {}); } catch { setVal({}); } }, [draftKey]);
  const update = (sku: string, v: string) => setVal(prev => { const n = { ...prev, [sku]: v }; try { localStorage.setItem(draftKey, JSON.stringify(n)); } catch {} return n; });

  const isBag = (i: Item) => i.unit === 'bag';
  const done = items.filter(i => qtyOk(val[i.sku], isBag(i))).length;
  const anyBad = items.some(i => qtyBad(val[i.sku], isBag(i)));
  const complete = done === items.length && items.length > 0;

  const live = counts.filter(c => c.status !== 'rejected');
  const last: Record<string, FgCount> = {};
  for (const c of live) if (!last[c.sku] || c.count_date > last[c.sku].count_date || (c.count_date === last[c.sku].count_date && c.created_at > last[c.sku].created_at)) last[c.sku] = c;
  const pending = counts.filter(c => c.status === 'pending_admin');
  const dates = Array.from(new Set(counts.map(c => c.count_date))).sort().reverse().slice(0, 6);
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);

  async function save() {
    setBusy(true); setMsg(null);
    const r = await saveFgCountAction({ count_date: date, client: client.name, counts: items.map(i => ({ sku: i.sku, qty: evalQty(val[i.sku]) as number })) });
    setBusy(false);
    if (r.error) {
      setMsg({ ok: false, t: r.error === 'incomplete' ? L('Phải đếm tất cả sản phẩm.', 'Every product must be counted.')
        : r.error === 'integer' ? L('Số gói phải là số nguyên.', 'Bags must be whole numbers.')
        : r.error === 'already-counted' ? L('Đã kiểm kê ngày này. Admin có thể yêu cầu đếm lại.', 'Already counted on this date. An admin can ask for a recount.') : r.error });
      return;
    }
    try { localStorage.removeItem(draftKey); } catch {}
    setVal({});
    setMsg({ ok: true, t: L(`Đã lưu. ${r.pending ? `${r.pending} chênh lệch chờ admin duyệt.` : ''}`, `Saved.${r.pending ? ` ${r.pending} gap(s) waiting for admin validation.` : ''}`) });
    await reload();
  }
  async function decide(id: string, dec: 'approve' | 'reject') {
    setDeciding(id);
    const r = await decideFgCountAction(id, dec);
    setDeciding(null);
    if (r.error) setMsg({ ok: false, t: r.error });
    await reload();
  }

  return (
    <div className="space-y-4">
      <Banner>{L('Đếm hàng thực tế. Số đếm là số đúng: thiếu = hao hụt (Hưng làm lại), dư = gói chưa ghi.',
        'Count what is physically there. The count is the truth: less = loss (Hưng re-makes it), more = packing that was not recorded.')}</Banner>

      {pending.length > 0 && (
        <Card className="overflow-hidden" >
          <div className="px-3.5 py-2 text-xs font-bold" style={{ backgroundColor: '#FFFBEB', color: '#92400E' }}>
            {L('Chênh lệch chờ admin duyệt', 'Gaps waiting for admin validation')} · {pending.length}
          </div>
          {pending.map(c => {
            const it = bySku[c.sku]; const u = it ? unitLabel(it, L) : ''; const dec = it?.unit === 'kg' ? 1 : 0;
            return (
              <div key={c.id} className="px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-sm" style={{ borderTop: '1px solid #EFE9DC' }}>
                <span className="flex-1 min-w-[160px]"><b>{it?.product_name ?? c.sku}</b><span className="block text-[11px]" style={{ color: FAINT }}>{dmy(c.count_date)} · {c.created_by_name} · {L('lý thuyết', 'theoretical')} {fmt(Number(c.qty_theoretical ?? 0), dec)} → {L('đếm', 'counted')} {fmt(Number(c.qty_counted), dec)} {u}</span></span>
                <Chip tone={Number(c.gap) < 0 ? 'red' : 'amber'}>{Number(c.gap) > 0 ? '+' : ''}{fmt(Number(c.gap), dec)} {u}</Chip>
                {isAdmin && (
                  <span className="flex gap-1.5">
                    <Btn primary disabled={deciding === c.id} onClick={() => decide(c.id, 'approve')}>{deciding === c.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}{L('Duyệt', 'Approve')}</Btn>
                    <Btn disabled={deciding === c.id} onClick={() => decide(c.id, 'reject')}><X size={12} />{L('Đếm lại', 'Recount')}</Btn>
                  </span>
                )}
              </div>
            );
          })}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-2" style={{ backgroundColor: '#FCFBF8' }}>
          <Title>{L('Tồn thành phẩm', 'Finished-goods stock')}</Title>
          {canCount && (
            <div className="flex items-center gap-2 text-xs" style={{ color: MUTED }}>
              {L('Ngày kiểm', 'Count date')} <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
          )}
        </div>
        {items.map(i => {
          const theo = d.fgTheo[i.sku] ?? 0; const lc = last[i.sku]; const dec = i.unit === 'kg' ? 1 : 0;
          return (
            <div key={i.sku} className="px-3.5 py-2.5 space-y-1.5" style={{ borderTop: '1px solid #EFE9DC' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-tight">{i.product_name}</div>
                  <div className="text-[11px] tabular-nums" style={{ color: FAINT }}>
                    {i.sku} · {L('gói', 'packed')} {fmt((d.packedQty[i.sku] ?? 0) + (d.foundQty[i.sku] ?? 0), dec)} · {L('giao', 'deliv.')} {fmt(d.deliveredQty[i.sku] ?? 0, dec)} · {L('hao hụt', 'loss')} {fmt(d.scrapFinished[i.sku] ?? 0, dec)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] uppercase font-bold" style={{ color: FAINT }}>{L('Lý thuyết', 'Theoretical')}</div>
                  <div className="text-base font-bold tabular-nums">{fmt(theo, dec)} <span className="text-xs font-semibold" style={{ color: FAINT }}>{unitLabel(i, L)}</span></div>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px]" style={{ color: FAINT }}>
                  {lc ? <>{L('Lần kiểm', 'Last count')} {dmy(lc.count_date)}: {fmt(Number(lc.qty_counted), dec)} {lc.status === 'pending_admin' ? <Chip tone="amber">{L('chờ duyệt', 'pending')}</Chip> : Math.abs(Number(lc.gap ?? 0)) > 0.0005 ? <Chip tone={Number(lc.gap) < 0 ? 'red' : 'amber'}>{Number(lc.gap) > 0 ? '+' : ''}{fmt(Number(lc.gap), dec)}</Chip> : <Chip tone="green">OK</Chip>}</> : L('Chưa kiểm', 'Never counted')}
                </span>
                {canCount && <ExprInput className="w-44" integer={i.unit === 'bag'} placeholder="—" value={val[i.sku] ?? ''} unit={unitLabel(i, L)} onChange={x => update(i.sku, x)} />}
              </div>
            </div>
          );
        })}
        {canCount && (
          <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5" style={{ borderTop: '1px solid #EFE9DC', backgroundColor: '#FCFBF8' }}>
            <span className="text-sm font-bold tabular-nums" style={{ color: complete ? GREEN : '#B45309' }}>{done} / {items.length} {L('đã đếm', 'counted')}</span>
            <Btn primary onClick={save} disabled={busy || !complete || anyBad}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu kiểm kê', 'Save count')}</Btn>
            <span className="text-[11px]" style={{ color: FAINT }}>{L('Phải đếm tất cả (nhập 0 nếu không còn).', 'Every product must be counted (type 0 if none).')}</span>
            {msg && <span className="text-xs font-semibold" style={{ color: msg.ok ? '#059669' : '#DC2626' }}>{msg.t}</span>}
          </div>
        )}
      </Card>

      {dates.length > 0 && (
        <div className="space-y-1.5">
          <Title>{L('Các lần kiểm gần đây', 'Recent counts')}</Title>
          <Card className="overflow-hidden">
            {dates.map(dt => {
              const rows = counts.filter(c => c.count_date === dt && c.status !== 'rejected');
              const gaps = rows.filter(r => Math.abs(Number(r.gap ?? 0)) > 0.0005).length;
              return (
                <div key={dt} className="flex items-center gap-3 px-3.5 py-2 text-xs" style={{ borderTop: '1px solid #EFE9DC' }}>
                  <span className="w-[70px]" style={{ color: MUTED }}>{dmy(dt)}</span>
                  <span className="flex-1">{rows.length} {L('sản phẩm', 'products')} · {Array.from(new Set(rows.map(r => r.created_by_name).filter(Boolean))).join(', ')}</span>
                  {gaps ? <Chip tone="amber">{gaps} {L('chênh lệch', 'gap(s)')}</Chip> : <Chip tone="green">OK</Chip>}
                </div>
              );
            })}
          </Card>
        </div>
      )}
    </div>
  );
}
