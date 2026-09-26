'use client';
import { useMemo, useState } from 'react';
import { Loader2, Check, X, Pencil, Trash2, Lock, Send, Minus, Plus, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { Card, Chip, Btn, ExprInput, inputStyle } from './ui';
import { evalQty, qtyBad, fmt, dmy, itemKg, unitLabel, localToday, GREEN, GOLD, MUTED, FAINT, LINE, type Client, type Derived, type LFn, type PackLog, type ProdLog, type Item, type Group } from './model';
import Reception from './Reception';
import { savePackagingAction, pushPackagingToOdooAction, updatePackagingAction, deletePackagingAction } from '@/lib/oem-actions';

// quantity fields accept "12+3" / "12×24+7" (model.ts evalQty); invalid → 0 here, and Save is blocked
const num = (s: string | undefined) => { const v = evalQty(s); return v !== null && !Number.isNaN(v) ? v : 0; };
const isBad = (s: string | undefined) => Number.isNaN(evalQty(s) as number);

// "Today" — the assistants' daily screen (Axel, 2026-09-25 redesign): only products with baked
// bulk are open, −/+ and quick amounts for phones, a loss button per product, a sticky save bar
// with a summary and a confirmation step, then the log grouped by day.
export default function Packaging({ client, items, d, pack, prod, canPack, canManage, odooOn, userId, reload, L }: {
  client: Client; items: Item[]; d: Derived; pack: PackLog[]; prod: ProdLog[]; canPack: boolean; canManage: boolean; odooOn: boolean;
  userId: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);
  const [date, setDate] = useState(localToday());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [sacks, setSacks] = useState<Record<string, string>>({});
  const [lossOpen, setLossOpen] = useState<Record<string, boolean>>({});
  const [lossBulk, setLossBulk] = useState<Record<string, string>>({});
  const [lossBag, setLossBag] = useState<Record<string, string>>({});
  const [showEmpty, setShowEmpty] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const avail = (g: string) => Math.max(0, d.bulkAvail[g] ?? 0);
  const usedKg = (g: Group, exceptSku?: string) =>
    g.items.reduce((s, i) => s + (i.sku === exceptSku ? 0 : itemKg(i, num(qty[i.sku])) ), 0) + num(lossBulk[g.key]);
  const withBulk = client.groups.filter(g => avail(g.key) > 0.0005);
  const empty = client.groups.filter(g => avail(g.key) <= 0.0005);
  const over = client.groups.filter(g => usedKg(g) > avail(g.key) + 0.0005);

  const packed = Object.entries(qty).filter(([s, v]) => bySku[s] && num(v) > 0);
  const scraps = [
    ...Object.entries(lossBulk).filter(([, v]) => num(v) > 0).map(([g, v]) => ({ kind: 'scrap_bulk' as const, sku: client.groups.find(x => x.key === g)!.items[0].sku, qty: num(v), g })),
    ...Object.entries(lossBag).filter(([s, v]) => bySku[s] && num(v) > 0).map(([s, v]) => ({ kind: 'scrap_finished' as const, sku: s, qty: num(v), g: bySku[s].group_key })),
  ];
  const bags = packed.filter(([s]) => bySku[s].unit === 'bag').reduce((a, [, v]) => a + num(v), 0);
  const kgTotal = packed.reduce((a, [s, v]) => a + itemKg(bySku[s], num(v)), 0);
  const isBag = (sku: string) => bySku[sku]?.unit === 'bag';
  // bags are whole numbers (Axel, 2026-09-26): 5.5 bags is refused; kg (cashews, broken bulk) keep decimals
  const anyBad = Object.entries(qty).some(([s, v]) => qtyBad(v, isBag(s))) || Object.values(lossBulk).some(v => qtyBad(v, false))
    || Object.entries(lossBag).some(([s, v]) => qtyBad(v, isBag(s)));
  const canSave = !saving && !over.length && !anyBad && (packed.length > 0 || scraps.length > 0);

  const setQ = (sku: string, v: number) => setQty(q => ({ ...q, [sku]: v > 0 ? String(Math.round(v * 1000) / 1000) : '' }));
  const maxFor = (g: Group, i: Item) => {
    const rem = Math.max(0, avail(g.key) - usedKg(g, i.sku));
    return i.unit === 'kg' ? Math.floor(rem * 10) / 10 : Math.floor((rem * 1000) / i.unit_weight_g);
  };

  const errText = (e: string) => {
    if (e.startsWith('bulk:')) { const [, g, a] = e.split(':'); const t = client.groups.find(x => x.key === g)?.title ?? g; return L(`Vượt quá bán thành phẩm của ${t} (${a} kg).`, `More than the bulk left for ${t} (${a} kg).`); }
    if (e === 'locked-odoo') return L('Đã lên Odoo — không sửa được.', 'Already in Odoo — cannot be changed.');
    if (e === 'locked-24h') return L('Chỉ người nhập sửa được trong 24 giờ.', 'Only its author can edit it, within 24 h.');
    if (e === 'locked-inventory') return L('Dòng từ kiểm kê — không sửa được.', 'Line created by an inventory count — cannot be changed.');
    if (e === 'integer') return L('Số gói phải là số nguyên.', 'Bags must be a whole number.');
    return e;
  };

  async function save() {
    setSaving(true); setMsg(null);
    const res = await savePackagingAction({
      pack_date: date,
      packed: packed.map(([sku, v]) => ({ sku, qty: num(v), bags_count: bySku[sku].unit === 'kg' ? (num(sacks[sku]) || null) : null })),
      scraps: scraps.map(s => ({ kind: s.kind, sku: s.sku, qty: s.qty })),
    });
    setSaving(false); setConfirm(false);
    if (res.error) { setMsg({ ok: false, text: errText(res.error) }); return; }
    const o = res.odoo;
    const extra = !o ? '' : o.off ? L(' (Odoo tắt — gửi sau)', ' (Odoo off — sent later)') : o.failed ? L(` · ${o.failed} lỗi Odoo`, ` · ${o.failed} Odoo error(s)`) : L(' · đã lên Odoo', ' · sent to Odoo');
    setMsg({ ok: !o?.failed, text: L('Đã lưu', 'Saved') + extra });
    setQty({}); setSacks({}); setLossBulk({}); setLossBag({}); setLossOpen({});
    await reload();
  }

  const card = (g: Group) => {
    const a = avail(g.key); const u = usedKg(g); const bad = u > a + 0.0005;
    return (
      <Card key={g.key} className="p-3.5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{g.title}</div>
            <div className="text-[11px] mt-0.5" style={{ color: FAINT }}>{g.skus.join(' · ')}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] uppercase font-bold tracking-wide" style={{ color: FAINT }}>{L('Bán TP', 'Bulk')}</div>
            <div className="text-base font-bold tabular-nums" style={{ color: bad ? '#DC2626' : GREEN }}>{fmt(Math.max(0, a - u), 1)} <span className="text-xs font-semibold" style={{ color: FAINT }}>/ {fmt(a, 1)} kg</span></div>
          </div>
        </div>
        {g.items.map(i => {
          const v = num(qty[i.sku]); const step = i.unit === 'kg' ? 1 : 10; const mx = maxFor(g, i);
          return (
            <div key={i.sku} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold w-14 shrink-0" style={{ color: '#374151' }}>{i.unit === 'kg' ? 'kg' : `${fmt(i.unit_weight_g, 0)} g`}</span>
                <button onClick={() => setQ(i.sku, Math.max(0, v - step))} className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: '#F3F4F6' }} aria-label="minus"><Minus size={16} /></button>
                <ExprInput big integer={i.unit === 'bag'} className="flex-1 min-w-0" value={qty[i.sku] ?? ''} unit={unitLabel(i, L)} onChange={v => setQty(q => ({ ...q, [i.sku]: v }))} />
                <button onClick={() => setQ(i.sku, v + step)} className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: '#F3F4F6' }} aria-label="plus"><Plus size={16} /></button>
                <span className="text-xs w-9 shrink-0" style={{ color: MUTED }}>{unitLabel(i, L)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-16">
                {(i.unit === 'kg' ? [5, 10] : [50, 100]).map(n => (
                  <button key={n} onClick={() => setQ(i.sku, v + n)} className="text-[11px] font-bold rounded-lg px-2.5 py-1" style={{ backgroundColor: '#F7F5F0', color: '#374151', border: `1px solid ${LINE}` }}>+{n}</button>
                ))}
                <button onClick={() => setQ(i.sku, mx)} disabled={mx <= 0} className="text-[11px] font-bold rounded-lg px-2.5 py-1 disabled:opacity-40" style={{ backgroundColor: '#FFF7E6', color: GOLD, border: '1px solid #F3E3C0' }}>
                  {L('Hết bán TP', 'All bulk')} ({fmt(mx, i.unit === 'kg' ? 1 : 0)})
                </button>
                {i.unit === 'kg' && (
                  <span className="flex items-center gap-1 text-[11px]" style={{ color: MUTED }}>
                    <input inputMode="numeric" placeholder="0" value={sacks[i.sku] ?? ''} onChange={e => setSacks(s => ({ ...s, [i.sku]: e.target.value.replace(/[^0-9]/g, '') }))}
                      className="w-12 h-7 rounded-lg px-2 text-sm text-center" style={inputStyle} /> {L('bao', 'sacks')}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!lossOpen[g.key] ? (
          <button onClick={() => setLossOpen(o => ({ ...o, [g.key]: true }))} className="text-[11px] font-semibold" style={{ color: FAINT }}>+ {L('Báo hao hụt', 'Report a loss')}</button>
        ) : (
          <div className="rounded-xl p-2.5 space-y-2" style={{ backgroundColor: '#FEF7F7', border: '1px solid #FBE3E3' }}>
            <div className="flex items-center gap-2 text-xs">
              <span className="flex-1" style={{ color: '#374151' }}>{L('Bán TP vỡ (trước khi gói)', 'Broken bulk (before packing)')}</span>
              <ExprInput className="w-36" value={lossBulk[g.key] ?? ''} unit="kg" onChange={v => setLossBulk(x => ({ ...x, [g.key]: v }))} />
              <span className="w-9" style={{ color: MUTED }}>kg</span>
            </div>
            {g.items.map(i => (
              <div key={i.sku} className="flex items-center gap-2 text-xs">
                <span className="flex-1" style={{ color: '#374151' }}>{L('Gói lỗi', 'Faulty')} {i.unit === 'kg' ? '' : `${fmt(i.unit_weight_g, 0)} g`} {L('(sau khi gói)', '(after packing)')}</span>
                <ExprInput className="w-36" integer={i.unit === 'bag'} value={lossBag[i.sku] ?? ''} unit={unitLabel(i, L)} onChange={v => setLossBag(x => ({ ...x, [i.sku]: v }))} />
                <span className="w-9" style={{ color: MUTED }}>{unitLabel(i, L)}</span>
              </div>
            ))}
          </div>
        )}
        {bad && <div className="text-xs font-semibold flex items-center gap-1" style={{ color: '#DC2626' }}><AlertTriangle size={12} />{L('Nhiều hơn bán TP Hưng đã nướng', 'More than the bulk Hưng has baked')}</div>}
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {canPack && <Reception client={client} prod={prod} reload={reload} L={L} />}
      {canPack && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs" style={{ color: MUTED }}>{L('Ngày đóng gói', 'Packing date')}</div>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="h-9 rounded-lg px-2 text-sm" style={inputStyle} />
          </div>
          {!withBulk.length && <Card className="p-5 text-center text-sm" ><span style={{ color: MUTED }}>{L('Chưa có bán thành phẩm đã nhận để đóng gói. Nhận các mẻ của Hưng ở trên trước.', 'No received bulk to pack. Receive Hưng’s batches above first.')}</span></Card>}
          <div className="grid gap-3 lg:grid-cols-2">{withBulk.map(card)}</div>
          {empty.length > 0 && (
            <div>
              <button onClick={() => setShowEmpty(v => !v)} className="flex items-center gap-1 text-xs font-semibold" style={{ color: FAINT }}>
                {showEmpty ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{L('Không có bán TP để gói', 'No bulk to pack')} ({empty.length})
              </button>
              {showEmpty && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {empty.map(g => <span key={g.key} className="text-[11px] rounded-lg px-2 py-1" style={{ backgroundColor: '#fff', color: MUTED, border: `1px solid ${LINE}` }}>{g.title}</span>)}
                </div>
              )}
            </div>
          )}
          {msg && <div className="text-sm font-bold rounded-xl px-3 py-2.5" style={msg.ok ? { backgroundColor: '#ECFDF5', color: '#047857' } : { backgroundColor: '#FEF2F2', color: '#DC2626' }}>{msg.ok ? '✓ ' : ''}{msg.text}</div>}

          {(packed.length > 0 || scraps.length > 0 || anyBad) && (
            <div className="sticky bottom-3 z-30">
              <div className="rounded-2xl px-4 py-3 flex items-center gap-3 shadow-lg" style={{ backgroundColor: GREEN, color: '#fff' }}>
                <div className="flex-1 min-w-0 text-sm">
                  <div className="font-bold tabular-nums">{packed.length} {L('SP', 'products')} · {fmt(bags, 0)} {L('gói', 'bags')}{kgTotal ? ` · ${fmt(kgTotal, 1)} kg` : ''}</div>
                  {scraps.length > 0 && <div className="text-[11px] opacity-80">{scraps.length} {L('hao hụt', 'loss line(s)')}</div>}
                  {anyBad && <div className="text-[11px] font-bold" style={{ color: '#FECACA' }}>{L('Có ô nhập không hợp lệ', 'A quantity is not valid')}</div>}
                </div>
                <button onClick={() => setConfirm(true)} disabled={!canSave} className="rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-40" style={{ backgroundColor: '#C9A84C', color: GREEN }}>
                  {L('Lưu', 'Save')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <DayLog pack={pack} bySku={bySku} client={client} canPack={canPack} canManage={canManage} odooOn={odooOn} userId={userId} reload={reload} errText={errText} L={L} />

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }} onClick={() => !saving && setConfirm(false)}>
          <div className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl p-4 pb-6 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="text-base font-bold">{L('Xác nhận', 'Confirm')} · {dmy(date)}</div>
              <button onClick={() => setConfirm(false)} className="w-9 h-9 rounded-full flex items-center justify-center" style={{ backgroundColor: '#F3F4F6' }}><X size={18} /></button>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${LINE}` }}>
              {packed.map(([s, v]) => (
                <div key={s} className="flex justify-between px-3 py-2 text-sm" style={{ borderTop: `1px solid ${LINE}` }}>
                  <span className="truncate">{bySku[s].product_name}</span><b className="tabular-nums">{fmt(num(v), bySku[s].unit === 'kg' ? 1 : 0)} {unitLabel(bySku[s], L)}</b>
                </div>
              ))}
              {scraps.map(x => (
                <div key={x.kind + x.sku} className="flex justify-between px-3 py-2 text-sm" style={{ borderTop: `1px solid ${LINE}`, color: '#DC2626' }}>
                  <span className="truncate">{x.kind === 'scrap_bulk' ? L('Bán TP vỡ', 'Broken bulk') : L('Gói lỗi', 'Faulty')} · {x.kind === 'scrap_bulk' ? client.groups.find(g => g.key === x.g)?.title : bySku[x.sku].product_name}</span>
                  <b className="tabular-nums">{fmt(x.qty, 1)} {x.kind === 'scrap_bulk' ? 'kg' : unitLabel(bySku[x.sku], L)}</b>
                </div>
              ))}
            </div>
            <div className="text-[11px]" style={{ color: FAINT }}>{odooOn ? L('Sẽ tạo lệnh sản xuất thành phẩm trên Odoo.', 'This creates the finished-product MO in Odoo.') : L('Odoo đang tắt — lưu trong app, gửi sau.', 'Odoo is off — saved in the app, sent later.')}</div>
            <button onClick={save} disabled={saving} className="w-full flex items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-bold text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
              {saving ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}{L('Xác nhận & lưu', 'Confirm & save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DayLog({ pack, bySku, client, canPack, canManage, odooOn, userId, reload, errText, L }: {
  pack: PackLog[]; bySku: Record<string, Item>; client: Client; canPack: boolean; canManage: boolean; odooOn: boolean; userId: string | null;
  reload: () => Promise<void>; errText: (e: string) => string; L: LFn;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ [localToday()]: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; qty: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const days = useMemo(() => {
    const m = new Map<string, PackLog[]>();
    for (const p of pack) { if (!m.has(p.pack_date)) m.set(p.pack_date, []); m.get(p.pack_date)!.push(p); }
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 60);
  }, [pack]);
  const mayEdit = (p: PackLog) => canPack && !p.odoo_mo_id && p.odoo_status !== 'done' && p.source !== 'inventory'
    && (canManage || (p.created_by === userId && Date.now() - new Date(p.created_at).getTime() < 24 * 3600 * 1000));

  async function run(id: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    setBusy(id); setMsg(null);
    const r = await fn();
    setBusy(null);
    if (r.error) setMsg(errText(r.error)); else { setEdit(null); setDel(null); }
    await reload();
  }
  const title = (p: PackLog) => p.kind === 'scrap_bulk' ? (client.groups.find(g => g.key === p.group_key)?.title ?? p.group_key) : (bySku[p.sku]?.product_name ?? p.sku);

  return (
    <div className="space-y-2">
      <div className="text-xs font-bold uppercase tracking-wide" style={{ color: MUTED }}>{L('Nhật ký đóng gói', 'Packaging log')}</div>
      {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
      {!days.length ? <Card className="p-5 text-center text-sm"><span style={{ color: MUTED }}>{L('Chưa có dữ liệu.', 'Nothing recorded yet.')}</span></Card> : days.map(([day, rows]) => {
        const isOpen = !!open[day];
        const bags = rows.filter(r => r.kind === 'packed' && bySku[r.sku]?.unit === 'bag').reduce((s, r) => s + Number(r.qty), 0);
        const kg = rows.filter(r => r.kind === 'packed' && bySku[r.sku]).reduce((s, r) => s + itemKg(bySku[r.sku], Number(r.qty)), 0);
        const errs = rows.filter(r => r.odoo_status === 'error').length;
        return (
          <Card key={day} className="overflow-hidden">
            <button onClick={() => setOpen(o => ({ ...o, [day]: !isOpen }))} className="w-full flex items-center gap-2 px-3.5 py-2.5 text-sm">
              {isOpen ? <ChevronDown size={14} style={{ color: FAINT }} /> : <ChevronRight size={14} style={{ color: FAINT }} />}
              <span className="font-bold">{day === localToday() ? L('Hôm nay', 'Today') : dmy(day)}</span>
              <span className="flex-1 text-right text-xs tabular-nums" style={{ color: MUTED }}>{fmt(bags, 0)} {L('gói', 'bags')} · {fmt(kg, 1)} kg</span>
              {errs > 0 && <Chip tone="red">{errs} Odoo</Chip>}
            </button>
            {isOpen && rows.map(p => {
              const it = bySku[p.sku]; const u = p.kind === 'scrap_bulk' ? 'kg' : it ? unitLabel(it, L) : '';
              return (
                <div key={p.id} className="px-3.5 py-2.5 space-y-1" style={{ borderTop: `1px solid ${LINE}` }}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold leading-tight" style={{ color: p.kind === 'packed' || p.kind === 'found' ? '#111827' : '#DC2626' }}>
                        {p.kind === 'scrap_bulk' ? `${L('Bán TP vỡ', 'Broken bulk')} · `
                          : p.kind === 'scrap_finished' ? (p.source === 'inventory' ? `${L('Thiếu khi kiểm kê', 'Missing at count')} · ` : `${L('Gói lỗi', 'Faulty')} · `)
                          : p.kind === 'found' ? `${L('Dư khi kiểm kê', 'Surplus at count')} · `
                          : p.source === 'inventory' ? `${L('Gói chưa ghi (kiểm kê)', 'Unrecorded packing (count)')} · ` : ''}{title(p)}
                      </div>
                      <div className="text-[11px]" style={{ color: FAINT }}>
                        {p.created_by_name || '—'} · {new Date(p.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{p.updated_by_name ? ` · ${L('sửa', 'edited')}` : ''}
                      </div>
                    </div>
                    {edit?.id === p.id ? (
                      <div className="flex items-center gap-1.5">
                        <input inputMode="decimal" value={edit.qty} onChange={e => setEdit({ ...edit, qty: e.target.value })} className="w-20 h-8 rounded-lg px-2 text-sm font-bold text-right" style={inputStyle} />
                        <button disabled={busy === p.id} onClick={() => run(p.id, () => updatePackagingAction(p.id, num(edit.qty), p.note))} style={{ color: '#059669' }}><Check size={18} /></button>
                        <button onClick={() => setEdit(null)} style={{ color: FAINT }}><X size={18} /></button>
                      </div>
                    ) : (
                      <div className="text-right">
                        <div className="text-sm font-bold tabular-nums">{fmt(Number(p.qty), u === 'kg' ? 1 : 0)} {u}</div>
                        {p.bags_count ? <div className="text-[11px]" style={{ color: FAINT }}>{p.bags_count} {L('bao', 'sacks')}</div> : null}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {p.kind === 'scrap_bulk' || p.kind === 'found' || p.odoo_status === 'skipped' ? null
                      : p.odoo_status === 'done' ? <Chip tone="green">✓ {p.odoo_ref ?? 'Odoo'}</Chip>
                      : p.odoo_status === 'error' ? <span title={p.odoo_error ?? ''}><Chip tone="red">{L('Lỗi Odoo', 'Odoo error')}</Chip></span>
                      : <Chip tone="amber">{L('Chờ Odoo', 'Odoo pending')}</Chip>}
                    {canPack && odooOn && (p.odoo_status === 'pending' || p.odoo_status === 'error') && p.kind !== 'scrap_bulk' && (
                      <button disabled={busy === p.id} onClick={() => run(p.id, () => pushPackagingToOdooAction(p.id))} className="inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: GREEN }}>
                        {busy === p.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}{L('Gửi Odoo', 'Send to Odoo')}
                      </button>
                    )}
                    <span className="flex-1" />
                    {edit?.id !== p.id && (mayEdit(p) ? (del === p.id ? (
                      <>
                        <Btn danger disabled={busy === p.id} onClick={() => run(p.id, () => deletePackagingAction(p.id))}>{L('Xoá', 'Delete')}</Btn>
                        <button onClick={() => setDel(null)} style={{ color: FAINT }}><X size={16} /></button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setEdit({ id: p.id, qty: String(p.qty) })} className="p-1" style={{ color: MUTED }}><Pencil size={15} /></button>
                        <button onClick={() => setDel(p.id)} className="p-1" style={{ color: '#DC2626' }}><Trash2 size={15} /></button>
                      </>
                    )) : canPack ? <span style={{ color: '#D1D5DB' }}><Lock size={13} /></span> : null)}
                  </div>
                </div>
              );
            })}
          </Card>
        );
      })}
      <div className="text-[11px]" style={{ color: FAINT }}>{L('Người nhập sửa được trong 24 giờ, sau đó chỉ admin. Dòng đã lên Odoo bị khoá.', 'Editable by its author for 24 h, then admin only. Lines already in Odoo are locked.')}</div>
    </div>
  );
}
