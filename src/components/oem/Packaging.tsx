'use client';
import { useMemo, useState } from 'react';
import { Loader2, Check, Plus, X, Pencil, Trash2, Lock, Send } from 'lucide-react';
import { Card, Title, Banner, Chip, Btn, Empty, inputCls, inputStyle } from './ui';
import { fmt, dmy, itemKg, unitLabel, localToday, GREEN, MUTED, FAINT, type Client, type Derived, type LFn, type PackLog, type Item } from './model';
import { savePackagingAction, pushPackagingToOdooAction, updatePackagingAction, deletePackagingAction } from '@/lib/oem-actions';

type ScrapLine = { id: number; kind: 'scrap_bulk' | 'scrap_finished'; sku: string; qty: string };
const num = (s: string | undefined) => Number((s ?? '').replace(',', '.')) || 0;

// Daily operations → Packaging. Assistants enter what was packed today (bags; kg + sacks for
// cashews) and any scrap. Save is blocked if it would use more bulk than Hung has logged.
export default function Packaging({ clients, items, d, pack, canPack, canManage, odooOn, userId, reload, L }: {
  clients: Client[]; items: Item[]; d: Derived; pack: PackLog[]; canPack: boolean; canManage: boolean; odooOn: boolean;
  userId: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);
  const [date, setDate] = useState(localToday());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [sacks, setSacks] = useState<Record<string, string>>({});
  const [scraps, setScraps] = useState<ScrapLine[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // kg of bulk each group would use with the current form
  const needKg = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [sku, v] of Object.entries(qty)) { const it = bySku[sku]; if (it && num(v) > 0) m[it.group_key] = (m[it.group_key] ?? 0) + itemKg(it, num(v)); }
    for (const s of scraps) { const it = bySku[s.sku]; if (it && s.kind === 'scrap_bulk' && num(s.qty) > 0) m[it.group_key] = (m[it.group_key] ?? 0) + num(s.qty); }
    return m;
  }, [qty, scraps, bySku]);
  const over = Object.entries(needKg).filter(([g, kg]) => kg > Math.max(0, d.bulkAvail[g] ?? 0) + 0.0005).map(([g]) => g);
  const packedLines = Object.entries(qty).filter(([, v]) => num(v) > 0);
  const scrapLines = scraps.filter(s => s.sku && num(s.qty) > 0);
  const canSave = !saving && !over.length && (packedLines.length > 0 || scrapLines.length > 0);

  const errText = (e: string) => {
    if (e.startsWith('bulk:')) { const [, g, a] = e.split(':'); const name = items.find(i => i.group_key === g)?.group_name ?? g; return L(`Vượt quá bán thành phẩm còn lại của ${name} (${a} kg).`, `More than the bulk left for ${name} (${a} kg).`); }
    if (e === 'locked-odoo') return L('Đã gửi lên Odoo — không sửa được.', 'Already sent to Odoo — cannot be changed.');
    if (e === 'locked-24h') return L('Chỉ người nhập sửa được trong 24 giờ, sau đó chỉ admin.', 'Editable by its author for 24 h, then admin only.');
    return e;
  };

  async function save() {
    setSaving(true); setMsg(null);
    const res = await savePackagingAction({
      pack_date: date,
      packed: packedLines.map(([sku, v]) => ({ sku, qty: num(v), bags_count: bySku[sku]?.unit === 'kg' ? (num(sacks[sku]) || null) : null })),
      scraps: scrapLines.map(s => ({ kind: s.kind, sku: s.sku, qty: num(s.qty) })),
      note,
    });
    setSaving(false);
    if (res.error) { setMsg({ ok: false, text: errText(res.error) }); return; }
    const o = res.odoo;
    const odooTxt = !o ? '' : o.off ? L(' Odoo đang tắt — sẽ gửi sau.', ' Odoo sync is off — will be sent later.')
      : o.failed ? L(` ${o.failed} dòng lỗi Odoo — xem nhật ký.`, ` ${o.failed} line(s) failed in Odoo — see the log.`) : o.sent ? L(' Đã tạo trên Odoo.', ' Created in Odoo.') : '';
    setMsg({ ok: !o?.failed, text: L('Đã lưu.', 'Saved.') + odooTxt });
    setQty({}); setSacks({}); setScraps([]); setNote('');
    await reload();
  }

  return (
    <div className="space-y-4">
      {canPack && (
        <Card className="p-3 sm:p-4 space-y-3">
          <Title right={<input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputCls} style={inputStyle} />}>
            {L('Đóng gói hôm nay', "Today's packaging")}
          </Title>
          <div className="text-[11px]" style={{ color: FAINT }}>{L('Ngày và người nhập được lưu tự động.', 'Date and author are saved automatically.')}</div>

          {clients.map(c => (
            <div key={c.name} className="space-y-2">
              <div className="text-[11px] font-bold" style={{ color: GREEN }}>{c.name}</div>
              <div className="grid gap-2 md:grid-cols-2">
                {c.groups.map(g => {
                  const avail = Math.max(0, d.bulkAvail[g.key] ?? 0);
                  const used = needKg[g.key] ?? 0;
                  const bad = over.includes(g.key);
                  return (
                    <div key={g.key} className="rounded-xl p-2.5 space-y-1.5" style={{ border: `1px solid ${bad ? '#FCA5A5' : '#F3F4F6'}`, backgroundColor: bad ? '#FEF2F2' : '#FCFBF8' }}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-bold truncate">{g.name}</span>
                        <span className="text-[11px] shrink-0 text-right" style={{ color: bad ? '#DC2626' : MUTED }}>
                          {avail <= 0.0005
                            ? <>{L('Chưa nướng gì', 'Nothing baked yet')}</>
                            : <>{L('Bán TP còn', 'Bulk available')}: <b>{fmt(avail, 2)} kg</b></>}
                          {used > 0 && <> · {L('sau khi nhập', 'after this entry')}: <b>{fmt(avail - used, 2)} kg</b></>}
                        </span>
                      </div>
                      {g.items.map(i => (
                        <div key={i.sku} className="flex items-center gap-2">
                          <span className="text-xs flex-1 truncate" style={{ color: '#374151' }}>
                            {i.unit === 'kg' ? 'kg' : `${fmt(i.unit_weight_g, 0)} g`}
                            {i.unit !== 'kg' && avail > 0.0005 && <span style={{ color: FAINT }}> · {L('tối đa', 'max')} ≈ {fmt(Math.floor((avail * 1000) / i.unit_weight_g), 0)} {L('gói', 'bags')}</span>}
                          </span>
                          <input inputMode="decimal" placeholder="0" value={qty[i.sku] ?? ''} onChange={e => setQty(q => ({ ...q, [i.sku]: e.target.value.replace(/[^0-9.,]/g, '') }))}
                            className="w-20 rounded-lg px-2 py-1 text-sm font-bold text-right" style={inputStyle} />
                          <span className="w-8 text-[11px]" style={{ color: MUTED }}>{unitLabel(i, L)}</span>
                          {i.unit === 'kg' && (
                            <>
                              <input inputMode="numeric" placeholder="0" value={sacks[i.sku] ?? ''} onChange={e => setSacks(s => ({ ...s, [i.sku]: e.target.value.replace(/[^0-9]/g, '') }))}
                                className="w-12 rounded-lg px-2 py-1 text-sm text-right" style={inputStyle} />
                              <span className="text-[11px]" style={{ color: MUTED }}>{L('bao', 'sacks')}</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="space-y-1.5">
            <div className="text-[11px] font-bold" style={{ color: MUTED }}>{L('Hao hụt (nếu có)', 'Scrap (optional)')}</div>
            {scraps.map(s => {
              const it = bySku[s.sku];
              return (
                <div key={s.id} className="flex flex-wrap items-center gap-1.5">
                  <select value={s.kind} onChange={e => setScraps(a => a.map(x => x.id === s.id ? { ...x, kind: e.target.value as any } : x))} className={inputCls} style={inputStyle}>
                    <option value="scrap_bulk">{L('Bán TP vỡ (kg) — trước khi gói', 'Broken bulk (kg) — before packing')}</option>
                    <option value="scrap_finished">{L('Gói lỗi — sau khi gói', 'Faulty bag — after packing')}</option>
                  </select>
                  <select value={s.sku} onChange={e => setScraps(a => a.map(x => x.id === s.id ? { ...x, sku: e.target.value } : x))} className={inputCls} style={inputStyle}>
                    <option value="">{L('Sản phẩm…', 'Product…')}</option>
                    {items.map(i => <option key={i.sku} value={i.sku}>{s.kind === 'scrap_bulk' ? `${i.group_name} (${i.sku})` : i.product_name}</option>)}
                  </select>
                  <input inputMode="decimal" placeholder="0" value={s.qty} onChange={e => setScraps(a => a.map(x => x.id === s.id ? { ...x, qty: e.target.value.replace(/[^0-9.,]/g, '') } : x))}
                    className="w-20 rounded-lg px-2 py-1 text-sm font-bold text-right" style={inputStyle} />
                  <span className="text-[11px]" style={{ color: MUTED }}>{s.kind === 'scrap_bulk' ? 'kg' : it ? unitLabel(it, L) : ''}</span>
                  <button onClick={() => setScraps(a => a.filter(x => x.id !== s.id))} style={{ color: FAINT }}><X size={14} /></button>
                </div>
              );
            })}
            <button onClick={() => setScraps(a => [...a, { id: Date.now(), kind: 'scrap_bulk', sku: '', qty: '' }])} className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: GREEN }}>
              <Plus size={13} />{L('Thêm hao hụt', 'Add scrap')}
            </button>
          </div>

          <input value={note} onChange={e => setNote(e.target.value)} placeholder={L('Ghi chú (tuỳ chọn)', 'Note (optional)')} className={`w-full ${inputCls}`} style={inputStyle} />
          <div className="flex flex-wrap items-center gap-2">
            <Btn primary onClick={save} disabled={!canSave}>{saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')}</Btn>
            {over.length > 0 && <span className="text-xs font-semibold" style={{ color: '#DC2626' }}>{L('Không lưu được: nhiều hơn bán thành phẩm Hưng đã nướng', 'Cannot save: more than the bulk Hưng has baked')} ({over.map(g => items.find(i => i.group_key === g)?.group_name ?? g).join(', ')}).</span>}
            {msg && <span className="text-xs font-semibold" style={{ color: msg.ok ? '#059669' : '#DC2626' }}>{msg.text}</span>}
          </div>
          <Banner>
            {odooOn
              ? L('Mỗi lần lưu tạo lệnh sản xuất (MO) thành phẩm trên Odoo. Gói lỗi = phiếu hủy trên Odoo.', 'Each save creates the finished-product manufacturing order (MO) in Odoo. Faulty bags = an Odoo scrap.')
              : L('Đồng bộ Odoo đang TẮT (Cài đặt). Các dòng được lưu ở trạng thái "chờ" và có thể gửi sau.', 'Odoo sync is OFF (Settings). Entries are saved as "pending" and can be sent later.')}
          </Banner>
        </Card>
      )}

      <PackLogList pack={pack} bySku={bySku} canPack={canPack} canManage={canManage} odooOn={odooOn} userId={userId} reload={reload} errText={errText} L={L} />
    </div>
  );
}

function PackLogList({ pack, bySku, canPack, canManage, odooOn, userId, reload, errText, L }: {
  pack: PackLog[]; bySku: Record<string, Item>; canPack: boolean; canManage: boolean; odooOn: boolean; userId: string | null;
  reload: () => Promise<void>; errText: (e: string) => string; L: LFn;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; qty: string; note: string } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const rows = filter ? pack.filter(p => p.group_key === filter) : pack;
  const groups = Array.from(new Map(Object.values(bySku).map(i => [i.group_key, i.group_name])).entries());
  const mayEdit = (p: PackLog) => canPack && !p.odoo_mo_id && p.odoo_status !== 'done'
    && (canManage || (p.created_by === userId && Date.now() - new Date(p.created_at).getTime() < 24 * 3600 * 1000));

  async function run(id: string, fn: () => Promise<{ ok?: boolean; error?: string }>) {
    setBusy(id); setMsg(null);
    const r = await fn();
    setBusy(null);
    if (r.error) setMsg(errText(r.error)); else { setEdit(null); setDel(null); }
    await reload();
  }

  const odooChip = (p: PackLog) => {
    if (p.kind === 'scrap_bulk' || p.odoo_status === 'skipped') return <Chip>{L('không Odoo', 'no Odoo')}</Chip>;
    if (p.odoo_status === 'done') return <Chip tone="green">✓ {p.odoo_ref ?? 'Odoo'}</Chip>;
    if (p.odoo_status === 'error') return <span title={p.odoo_error ?? ''}><Chip tone="red">{L('Lỗi Odoo', 'Odoo error')}{p.odoo_ref ? ` · ${p.odoo_ref}` : ''}</Chip></span>;
    return <Chip tone="amber">{L('Chờ Odoo', 'Odoo pending')}</Chip>;
  };

  return (
    <div className="space-y-2">
      <Title right={
        <select value={filter} onChange={e => setFilter(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">{L('Tất cả', 'All products')}</option>
          {groups.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
      }>{L('Nhật ký đóng gói', 'Packaging log')}</Title>
      {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
      {!rows.length ? <Empty text={L('Chưa có dữ liệu đóng gói.', 'No packaging recorded yet.')} /> : (
        <Card className="overflow-hidden">
          {rows.slice(0, 300).map(p => {
            const it = bySku[p.sku];
            const u = p.kind === 'scrap_bulk' ? 'kg' : it ? unitLabel(it, L) : '';
            const label = p.kind === 'scrap_bulk' ? `${it?.group_name ?? p.group_key} — ${L('bán TP vỡ', 'broken bulk')}` : (it?.product_name ?? p.sku);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
                <div className="w-[70px] shrink-0 text-xs" style={{ color: MUTED }}>{dmy(p.pack_date)}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate flex items-center gap-1.5">
                    {label}
                    {p.kind === 'scrap_finished' && <Chip tone="red">{L('gói lỗi', 'faulty bag')}</Chip>}
                    {p.kind === 'scrap_bulk' && <Chip tone="red">{L('hao hụt', 'scrap')}</Chip>}
                  </div>
                  <div className="text-[11px] truncate" style={{ color: FAINT }}>
                    {p.created_by_name || '—'} · {new Date(p.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    {p.updated_by_name ? ` · ${L('sửa bởi', 'edited by')} ${p.updated_by_name}` : ''}{p.note ? ` · ${p.note}` : ''}
                  </div>
                </div>
                {edit?.id === p.id ? (
                  <div className="flex items-center gap-1.5">
                    <input inputMode="decimal" value={edit.qty} onChange={e => setEdit({ ...edit, qty: e.target.value })} className="w-16 rounded px-1.5 py-1 text-sm font-bold" style={inputStyle} />
                    <input value={edit.note} onChange={e => setEdit({ ...edit, note: e.target.value })} placeholder={L('Ghi chú', 'Note')} className="w-28 rounded px-1.5 py-1 text-xs" style={inputStyle} />
                    <button disabled={busy === p.id} onClick={() => run(p.id, () => updatePackagingAction(p.id, num(edit.qty), edit.note))} style={{ color: '#059669' }}><Check size={16} /></button>
                    <button onClick={() => setEdit(null)} style={{ color: FAINT }}><X size={16} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{fmt(Number(p.qty), u === 'kg' ? 2 : 0)} {u}{p.bags_count ? <span className="text-[11px] font-normal" style={{ color: MUTED }}> · {p.bags_count} {L('bao', 'sacks')}</span> : null}</span>
                    {odooChip(p)}
                    {canPack && odooOn && (p.odoo_status === 'pending' || p.odoo_status === 'error') && p.kind !== 'scrap_bulk' && (
                      <button disabled={busy === p.id} onClick={() => run(p.id, () => pushPackagingToOdooAction(p.id))} title={L('Gửi lên Odoo', 'Send to Odoo')} style={{ color: GREEN }}>
                        {busy === p.id ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      </button>
                    )}
                    {mayEdit(p) ? (del === p.id ? (
                      <>
                        <Btn danger disabled={busy === p.id} onClick={() => run(p.id, () => deletePackagingAction(p.id))}>{L('Xoá', 'Delete')}</Btn>
                        <button onClick={() => setDel(null)} style={{ color: FAINT }}><X size={14} /></button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => setEdit({ id: p.id, qty: String(p.qty), note: p.note ?? '' })} style={{ color: MUTED }}><Pencil size={14} /></button>
                        <button onClick={() => setDel(p.id)} style={{ color: '#DC2626' }}><Trash2 size={14} /></button>
                      </>
                    )) : canPack ? <span title={L('Khoá', 'Locked')} style={{ color: '#D1D5DB' }}><Lock size={13} /></span> : null}
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
      <div className="text-[11px]" style={{ color: FAINT }}>
        {L('Người nhập sửa được trong 24 giờ, sau đó chỉ admin. Dòng đã lên Odoo bị khoá.', 'Editable by its author for 24 h, then admin only. Entries already in Odoo are locked.')}
      </div>
    </div>
  );
}
