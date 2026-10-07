'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Trash2, Pencil, Check, X, Plus } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { Empty } from './ui';
import { fmt, localToday, itemKg, GREEN, MM_CLIENT, type Item, type ProdLog, type Hist, type LFn } from './model';
import { NOTE_KEY, PROD_EDITORS_KEY, editorIds, type PlanRow } from './plan';

// Production log (Hung's kg entries, admin corrections) + order quantities / settings.
const kgOf = (it: Item) => itemKg(it, it.qty_ordered);

export function ProductionLog({ logs, items, groupName, canManage, userId, userName, reload, L }: {
  logs: ProdLog[]; items: Item[]; groupName: (k: string) => string; canManage: boolean;
  userId: string | null; userName: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [filter, setFilter] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editKg, setEditKg] = useState('');
  const [editNote, setEditNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // manual entry (admin correction)
  const [nDate, setNDate] = useState(localToday());
  const [nSku, setNSku] = useState('');
  const [nKg, setNKg] = useState('');
  const [nNote, setNNote] = useState('');

  const groups = useMemo(() => Array.from(new Map(items.map(i => [i.group_key, i.group_name])).entries()), [items]);
  // corrections and cancellations of baked batches (team lead from the station, or admin here)
  const [audit, setAudit] = useState<Audit[]>([]);
  const loadAudit = useCallback(async () => {
    const { data } = await supabase.from('lab_mm_production_audit')
      .select('id, action, group_key, prod_date, entry_by_name, old_kg, new_kg, reason, done_by_name, done_at').order('done_at', { ascending: false }).limit(60);
    setAudit((data ?? []) as Audit[]);
  }, [supabase]);
  useEffect(() => { loadAudit(); }, [loadAudit, logs]);
  const auditShown = audit.filter(a => items.some(i => i.group_key === a.group_key));
  // best effort: a failed trace never blocks the correction itself
  async function trace(l: ProdLog | undefined, action: 'edit' | 'cancel', newKg: number | null, reason: string | null) {
    if (!l) return;
    await supabase.from('lab_mm_production_audit').insert({
      log_id: l.id, action, group_key: l.group_key, sku: l.sku, prod_date: l.prod_date, plan_seq: l.plan_seq ?? null,
      entry_by_name: l.created_by_name, old_kg: l.weight_kg, new_kg: newKg, reason, done_by: userId, done_by_name: userName,
    });
  }
  const shown = filter ? logs.filter(l => l.group_key === filter) : logs;
  const total = shown.reduce((s, l) => s + l.weight_kg, 0);

  async function saveEdit(id: string) {
    const kg = Number(editKg.replace(',', '.'));
    if (!(kg > 0)) return;
    setBusy(true);
    const { error } = await supabase.from('lab_mm_production_log').update({ weight_kg: kg, note: editNote.trim() || null }).eq('id', id);
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    const before = logs.find(l => l.id === id);
    if (before && Math.abs(before.weight_kg - kg) >= 0.0005) await trace(before, 'edit', kg, editNote.trim() || null);
    setEditId(null); await reload();
  }
  async function del(id: string) {
    setBusy(true);
    const { error } = await supabase.from('lab_mm_production_log').delete().eq('id', id);
    setBusy(false); setConfirmDel(null);
    if (error) { setMsg(error.message); return; }
    await trace(logs.find(l => l.id === id), 'cancel', null, null);
    await reload();
  }
  async function add() {
    const it = items.find(i => i.sku === nSku);
    const kg = Number(nKg.replace(',', '.'));
    if (!it || !(kg > 0) || !nDate) return;
    setBusy(true);
    const { error } = await supabase.from('lab_mm_production_log').insert({
      prod_date: nDate, group_key: it.group_key, sku: it.sku, weight_kg: kg,
      note: nNote.trim() || null, created_by: userId, created_by_name: userName,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setNKg(''); setNNote(''); setMsg(L('Đã thêm.', 'Added.')); await reload();
  }

  return (
    <div className="space-y-3 max-w-3xl">
      {canManage && (
        <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: '1px solid #E5E7EB' }}>
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>{L('Thêm / điều chỉnh sản xuất', 'Add / correct production')}</div>
          <div className="text-[11px]" style={{ color: '#9CA3AF' }}>
            {L('Thường Hung nhập từ trạm (Sản xuất thêm, theo kg). Dùng ô này để sửa sai sót.', 'Hung normally enters this from his station (extra production, in kg). Use this for corrections only.')}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <input type="date" value={nDate} onChange={e => setNDate(e.target.value)} className="rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
            <select value={nSku} onChange={e => setNSku(e.target.value)} className="rounded-lg px-2 py-1.5 text-sm col-span-1 sm:col-span-1" style={{ border: '1px solid #D1D5DB' }}>
              <option value="">{L('Sản phẩm…', 'Product…')}</option>
              {items.map(i => <option key={i.sku} value={i.sku}>{i.group_name} · {i.sku}</option>)}
            </select>
            <input inputMode="decimal" placeholder="kg" value={nKg} onChange={e => setNKg(e.target.value)} className="rounded-lg px-2 py-1.5 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
            <input placeholder={L('Ghi chú', 'Note')} value={nNote} onChange={e => setNNote(e.target.value)} className="rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
          </div>
          <button onClick={add} disabled={busy || !nSku || !(Number(nKg.replace(',', '.')) > 0)}
            className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
            <Plus size={13} />{L('Thêm', 'Add')}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={filter} onChange={e => setFilter(e.target.value)} className="rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }}>
          <option value="">{L('Tất cả sản phẩm', 'All products')}</option>
          {groups.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </select>
        <div className="text-xs" style={{ color: '#6B7280' }}>{shown.length} {L('lần nhập', 'entries')} · <b style={{ color: '#111827' }}>{fmt(total)} kg</b></div>
      </div>
      {msg && <div className="text-xs font-semibold" style={{ color: /error|lỗi|violat|denied/i.test(msg) ? '#DC2626' : '#059669' }}>{msg}</div>}

      {!shown.length ? <Empty text={L('Chưa có sản xuất nào được ghi nhận.', 'No production logged yet.')} /> : (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          {shown.map(l => (
            <div key={l.id} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
              <div className="w-[76px] shrink-0 text-xs" style={{ color: '#6B7280' }}>{l.prod_date.slice(8, 10)}/{l.prod_date.slice(5, 7)}/{l.prod_date.slice(2, 4)}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{groupName(l.group_key)} {l.sku && <span className="text-[11px] font-normal" style={{ color: '#9CA3AF' }}>· {l.sku}</span>}</div>
                <div className="text-[11px] truncate" style={{ color: '#9CA3AF' }}>{l.created_by_name || '—'}{l.plan_seq != null ? ` · ${L('cho đơn/đợt', 'for order/delivery')} ${l.plan_seq}` : ''}{l.note ? ` · ${l.note}` : ''}</div>
                <div className="text-[11px] truncate" style={{ color: l.status === 'received' ? (Number(l.received_kg) < Number(l.weight_kg) ? '#B91C1C' : '#047857') : '#B45309' }}>
                  {l.status === 'received'
                    ? `${L('Đã nhận', 'Received')} ${fmt(Number(l.received_kg ?? 0), 2)} kg · ${l.received_by_name ?? ''}${Number(l.received_kg) < Number(l.weight_kg) ? ` · ${L('thiếu', 'short')} ${fmt(Number(l.weight_kg) - Number(l.received_kg ?? 0), 2)} kg${l.receive_note ? ` (${l.receive_note})` : ''}` : ''}`
                    : L('Chờ nhận', 'Waiting for reception')}
                </div>
              </div>
              {editId === l.id ? (
                <div className="flex items-center gap-1.5 shrink-0">
                  <input inputMode="decimal" value={editKg} onChange={e => setEditKg(e.target.value)} className="w-16 rounded px-1.5 py-1 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                  <input value={editNote} onChange={e => setEditNote(e.target.value)} placeholder={L('Ghi chú', 'Note')} className="w-28 rounded px-1.5 py-1 text-xs" style={{ border: '1px solid #D1D5DB' }} />
                  <button disabled={busy} onClick={() => saveEdit(l.id)} style={{ color: '#059669' }}><Check size={16} /></button>
                  <button onClick={() => setEditId(null)} style={{ color: '#9CA3AF' }}><X size={16} /></button>
                </div>
              ) : (
                <>
                  <div className="font-bold shrink-0">{fmt(l.weight_kg, 2)} kg</div>
                  {canManage && l.status !== 'received' && (confirmDel === l.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button disabled={busy} onClick={() => del(l.id)} className="text-[11px] font-bold rounded px-1.5 py-0.5 text-white" style={{ backgroundColor: '#DC2626' }}>{L('Xoá', 'Delete')}</button>
                      <button onClick={() => setConfirmDel(null)} style={{ color: '#9CA3AF' }}><X size={14} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => { setEditId(l.id); setEditKg(String(l.weight_kg)); setEditNote(l.note ?? ''); }} style={{ color: '#6B7280' }} aria-label="edit"><Pencil size={14} /></button>
                      <button onClick={() => setConfirmDel(l.id)} style={{ color: '#DC2626' }} aria-label="delete"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {auditShown.length > 0 && (
        <div className="space-y-1.5 pt-2">
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>{L('Lịch sử sửa / huỷ mẻ nướng', 'Corrections & cancellations')}</div>
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            {auditShown.map((a, i) => (
              <div key={a.id} className="px-3 py-2 text-sm" style={{ borderTop: i ? '1px solid #F3F4F6' : undefined }}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold truncate">{groupName(a.group_key)}</span>
                  <span className="font-bold shrink-0" style={{ color: a.action === 'cancel' ? '#B91C1C' : '#111827' }}>
                    {a.action === 'cancel' ? `${fmt(Number(a.old_kg), 2)} kg → ${L('đã huỷ', 'cancelled')}` : `${fmt(Number(a.old_kg), 2)} → ${fmt(Number(a.new_kg ?? 0), 2)} kg`}
                  </span>
                </div>
                <div className="text-[11px]" style={{ color: '#9CA3AF' }}>
                  {new Date(a.done_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {a.done_by_name || '—'}
                  {' · '}{L('mẻ của', 'batch by')} {a.entry_by_name || '—'}{a.prod_date ? ` (${a.prod_date.slice(8, 10)}/${a.prod_date.slice(5, 7)})` : ''}{a.reason ? ` · ${a.reason}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
type Audit = { id: string; action: 'edit' | 'cancel'; group_key: string; prod_date: string | null; entry_by_name: string | null; old_kg: number; new_kg: number | null; reason: string | null; done_by_name: string | null; done_at: string };

export function OrderSettings({ items, hist, odooOn, plan, settings, userId, userName, reload, L }: {
  items: Item[]; hist: Hist[]; odooOn: boolean; plan: PlanRow[]; settings: Record<string, string>; userId: string | null; userName: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const changed = items.filter(i => draft[i.sku] !== undefined && draft[i.sku] !== '' && Number(draft[i.sku]) !== i.qty_ordered && Number(draft[i.sku]) >= 0);
  // kg items: weight of one bulk sack/carton (empty = not decided yet → no weight check at packaging)
  const [sackDraft, setSackDraft] = useState<Record<string, string>>({});
  const sackOf = (v: string) => (v.trim() === '' ? null : Number(v));
  const sackChanged = items.filter(i => i.unit === 'kg' && sackDraft[i.sku] !== undefined && sackOf(sackDraft[i.sku]) !== (i.sack_kg == null ? null : Number(i.sack_kg)) && !(Number(sackDraft[i.sku]) < 0));

  async function save() {
    setBusy(true); setMsg(null);
    for (const i of changed) {
      const after = Number(draft[i.sku]);
      const h = await supabase.from('lab_mm_order_item_history').insert({ sku: i.sku, qty_before: i.qty_ordered, qty_after: after, changed_by: userId, changed_by_name: userName });
      if (h.error) { setMsg(h.error.message); setBusy(false); return; }
      const u = await supabase.from('lab_mm_order_items').update({ qty_ordered: after, updated_at: new Date().toISOString(), updated_by: userId, updated_by_name: userName }).eq('sku', i.sku);
      if (u.error) { setMsg(u.error.message); setBusy(false); return; }
    }
    for (const i of sackChanged) {
      const u = await supabase.from('lab_mm_order_items').update({ sack_kg: sackOf(sackDraft[i.sku]), updated_at: new Date().toISOString(), updated_by: userId, updated_by_name: userName }).eq('sku', i.sku);
      if (u.error) { setMsg(u.error.message); setBusy(false); return; }
    }
    setBusy(false); setDraft({}); setSackDraft({}); setMsg(L('Đã lưu.', 'Saved.')); await reload();
  }

  const nameOf = (sku: string) => items.find(i => i.sku === sku)?.product_name ?? sku;

  const [odooBusy, setOdooBusy] = useState(false);
  async function toggleOdoo() {
    setOdooBusy(true);
    await supabase.from('lab_mm_settings').upsert({ key: 'odoo_mo_enabled', value: odooOn ? 'false' : 'true', updated_at: new Date().toISOString(), updated_by_name: userName });
    setOdooBusy(false); await reload();
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-white rounded-2xl p-3 flex flex-wrap items-center gap-3" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex-1 min-w-[220px]">
          <div className="text-sm font-bold">{L('Đồng bộ Odoo khi đóng gói', 'Odoo sync at packaging')}</div>
          <div className="text-[11px]" style={{ color: '#6B7280' }}>
            {L('BẬT: mỗi lần lưu đóng gói tạo + hoàn tất lệnh sản xuất (MO) thành phẩm trên Odoo (nguồn "OEM <ngày>"); gói lỗi = phiếu hủy. TẮT: chỉ lưu trong app, các dòng "chờ" có thể gửi sau.',
               'ON: every packaging save creates + validates the finished-product MO in Odoo (origin "OEM <date>"); faulty bags = a scrap. OFF: saved in the app only, "pending" lines can be sent later.')}
          </div>
        </div>
        <button onClick={toggleOdoo} disabled={odooBusy} className="inline-flex items-center gap-2 text-xs font-bold rounded-full px-3 py-1.5 disabled:opacity-50"
          style={odooOn ? { backgroundColor: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' } : { backgroundColor: '#F3F4F6', color: '#6B7280', border: '1px solid #E5E7EB' }}>
          {odooBusy ? <Loader2 size={12} className="animate-spin" /> : <span className="w-2 h-2 rounded-full" style={{ backgroundColor: odooOn ? '#10B981' : '#9CA3AF' }} />}
          {odooOn ? L('Đang BẬT', 'ON') : L('Đang TẮT', 'OFF')}
        </button>
      </div>
      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-3 py-2 text-[11px]" style={{ color: '#6B7280', backgroundColor: '#F9FAFB' }}>
          {L('Số lượng đặt (gói hoặc kg). Mỗi thay đổi được lưu vào lịch sử. Sản phẩm bán theo kg: ghi số kg mỗi bao (để trống nếu chưa quyết định).', 'Ordered quantity (bags or kg). Every change is kept in the history. Products sold by the kg: enter the kg per sack (leave empty if not decided yet).')}
        </div>
        {items.map(i => (
          <div key={i.sku} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{i.product_name}</div>
              <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{i.sku} · {i.client_name || MM_CLIENT}</div>
              {i.unit === 'kg' && (
                <div className="flex items-center gap-1.5 mt-1 text-[11px]" style={{ color: '#6B7280' }}>
                  {L('Bao', 'Sack')}
                  <input inputMode="decimal" placeholder="—" value={sackDraft[i.sku] ?? (i.sack_kg == null ? '' : String(Number(i.sack_kg)))} onChange={e => setSackDraft(d => ({ ...d, [i.sku]: e.target.value.replace(/[^0-9.]/g, '') }))}
                    className="w-14 rounded-lg px-2 py-0.5 text-xs font-bold text-right" style={{ border: '1px solid #D1D5DB' }} />
                  {L('kg / bao', 'kg / sack')}
                </div>
              )}
            </div>
            <input inputMode="numeric" value={draft[i.sku] ?? String(i.qty_ordered)} onChange={e => setDraft(d => ({ ...d, [i.sku]: e.target.value.replace(/[^0-9.]/g, '') }))}
              className="w-24 rounded-lg px-2 py-1 text-sm font-bold text-right" style={{ border: '1px solid #D1D5DB' }} />
            <div className="w-10 text-xs" style={{ color: '#6B7280' }}>{i.unit === 'kg' ? 'kg' : L('gói', 'bags')}</div>
            <div className="w-20 text-right text-[11px]" style={{ color: '#9CA3AF' }}>{fmt(kgOf(i), 0)} kg</div>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
          <button onClick={save} disabled={busy || !(changed.length + sackChanged.length)} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')} {changed.length + sackChanged.length ? `(${changed.length + sackChanged.length})` : ''}
          </button>
          {changed.length + sackChanged.length > 0 && <button onClick={() => { setDraft({}); setSackDraft({}); }} className="text-xs" style={{ color: '#6B7280' }}>{L('Huỷ', 'Cancel')}</button>}
          {msg && <span className="text-xs font-semibold" style={{ color: /saved|lưu/i.test(msg) ? '#059669' : '#DC2626' }}>{msg}</span>}
        </div>
      </div>

      <PlanEditor plan={plan} userName={userName} reload={reload} L={L} />

      <NoteEditor items={items} settings={settings} userName={userName} reload={reload} L={L} />

      <EditorPicker settings={settings} userName={userName} reload={reload} L={L} />

      <div className="space-y-1.5">
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>{L('Lịch sử thay đổi', 'Change history')}</div>
        {!hist.length ? <Empty text={L('Chưa có thay đổi.', 'No change yet.')} /> : (
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            {hist.map(h => (
              <div key={h.id} className="flex items-center gap-3 px-3 py-2 text-xs" style={{ borderTop: '1px solid #F3F4F6' }}>
                <div className="w-28 shrink-0" style={{ color: '#6B7280' }}>{new Date(h.changed_at).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                <div className="min-w-0 flex-1 truncate">{nameOf(h.sku)}</div>
                <div className="shrink-0 font-semibold">{fmt(Number(h.qty_before), 0)} → {fmt(Number(h.qty_after), 0)}</div>
                <div className="w-24 shrink-0 truncate text-right" style={{ color: '#9CA3AF' }}>{h.changed_by_name || '—'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Delivery schedule (lab_mm_delivery_plan): date + % of the order per delivery, admin only.
function PlanEditor({ plan, userName, reload, L }: { plan: PlanRow[]; userName: string | null; reload: () => Promise<void>; L: LFn }) {
  const supabase = useMemo(() => createClient(), []);
  const [draft, setDraft] = useState<Record<string, { delivery_date?: string; pct?: string; label?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const val = (r: PlanRow) => ({ delivery_date: draft[r.id]?.delivery_date ?? (r.delivery_date ?? ''), pct: draft[r.id]?.pct ?? String(r.pct), label: draft[r.id]?.label ?? (r.label ?? '') });
  const changed = plan.filter(r => { const v = val(r); return v.delivery_date !== (r.delivery_date ?? '') || Number(v.pct) !== Number(r.pct) || v.label !== (r.label ?? ''); });
  const byClient = new Map<string, PlanRow[]>();
  for (const r of plan) { const c = r.client_name || MM_CLIENT; if (!byClient.has(c)) byClient.set(c, []); byClient.get(c)!.push(r); }
  const set = (id: string, k: 'delivery_date' | 'pct' | 'label', v: string) => setDraft(d => ({ ...d, [id]: { ...d[id], [k]: v } }));

  async function save() {
    setBusy(true); setMsg(null);
    for (const r of changed) {
      const v = val(r);
      const pct = Number(v.pct);
      if (!(pct >= 0 && pct <= 100)) { setMsg(L('Ngày hoặc % không hợp lệ.', 'Invalid date or %.')); setBusy(false); return; }
      const u = await supabase.from('lab_mm_delivery_plan').update({ delivery_date: v.delivery_date || null, pct, label: v.label || null, updated_at: new Date().toISOString(), updated_by_name: userName }).eq('id', r.id);
      if (u.error) { setMsg(u.error.message); setBusy(false); return; }
    }
    setBusy(false); setDraft({}); setMsg(L('Đã lưu.', 'Saved.')); await reload();
  }

  if (!plan.length) return null;
  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
      <div className="px-3 py-2 text-[11px]" style={{ color: '#6B7280', backgroundColor: '#F9FAFB' }}>
        {L('Lịch giao hàng: ngày + % đơn hàng mỗi đợt. Số gói mỗi đợt và hạn nướng của bếp Hưng được tính tự động.', 'Delivery schedule: date + % of the order per delivery. Bags per delivery and Team Hưng\'s bake-by dates are computed from it.')}
      </div>
      {Array.from(byClient.entries()).map(([c, rows]) => {
        const tot = rows.some(r => r.qty) ? 100 : rows.reduce((s, r) => s + Number(val(r).pct || 0), 0);
        return (
          <div key={c}>
            <div className="flex items-center justify-between px-3 py-1.5 text-xs font-bold" style={{ borderTop: '1px solid #F3F4F6' }}>
              <span>{c}</span><span style={{ color: Math.abs(tot - 100) > 0.01 ? '#DC2626' : '#059669' }}>{L('Tổng', 'Total')} {fmt(tot, 1)} %</span>
            </div>
            {rows.sort((a, b) => a.seq - b.seq).map(r => { const v = val(r); return (
              <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
                <span className="w-14 font-semibold">{L('Đợt', 'Del.')} {r.seq}</span>
                <input type="date" value={v.delivery_date} onChange={e => set(r.id, 'delivery_date', e.target.value)} className="rounded-lg px-2 py-1 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                {r.qty ? <span className="text-xs font-semibold" style={{ color: '#6B7280' }}>{Object.values(r.qty).map(q => fmt(Number(q), 0)).join(' / ')} kg</span> :
                <span className="inline-flex items-center gap-1"><input inputMode="decimal" value={v.pct} onChange={e => set(r.id, 'pct', e.target.value.replace(/[^0-9.]/g, ''))} className="w-16 rounded-lg px-2 py-1 text-sm font-bold text-right" style={{ border: '1px solid #D1D5DB' }} /><span className="text-xs" style={{ color: '#6B7280' }}>%</span></span>}
                <input value={v.label} onChange={e => set(r.id, 'label', e.target.value)} placeholder={L('Ghi chú (âm lịch…)', 'Note (lunar date…)')} className="flex-1 min-w-[110px] rounded-lg px-2 py-1 text-xs" style={{ border: '1px solid #D1D5DB' }} />
              </div>
            ); })}
          </div>
        );
      })}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
        <button onClick={save} disabled={busy || !changed.length} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')} {changed.length ? `(${changed.length})` : ''}
        </button>
        {changed.length > 0 && <button onClick={() => setDraft({})} className="text-xs" style={{ color: '#6B7280' }}>{L('Huỷ', 'Cancel')}</button>}
        {msg && <span className="text-xs font-semibold" style={{ color: /saved|lưu/i.test(msg) ? '#059669' : '#DC2626' }}>{msg}</span>}
      </div>
    </div>
  );
}

// Contract requirements per client (lab_mm_settings "client_note:<client>"), shown to Team Hưng on the
// OEM station screen: at the top of the client's plan and again when a batch is declared. Admin only.
function NoteEditor({ items, settings, userName, reload, L }: { items: Item[]; settings: Record<string, string>; userName: string | null; reload: () => Promise<void>; L: LFn }) {
  const supabase = useMemo(() => createClient(), []);
  const clients = Array.from(new Set(items.map(i => i.client_name || MM_CLIENT)));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cur = (c: string) => settings[NOTE_KEY + c] ?? '';
  const changed = clients.filter(c => draft[c] !== undefined && draft[c] !== cur(c));

  async function save() {
    setBusy(true); setMsg(null);
    for (const c of changed) {
      const u = await supabase.from('lab_mm_settings').upsert({ key: NOTE_KEY + c, value: draft[c].trim(), updated_at: new Date().toISOString(), updated_by_name: userName });
      if (u.error) { setMsg(u.error.message); setBusy(false); return; }
    }
    setBusy(false); setDraft({}); setMsg(L('Đã lưu.', 'Saved.')); await reload();
  }

  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
      <div className="px-3 py-2 text-[11px]" style={{ color: '#6B7280', backgroundColor: '#F9FAFB' }}>
        {L('Yêu cầu của hợp đồng — hiển thị cho bếp Hưng trên màn hình Đơn hàng OEM. Để trống = không hiển thị. Bản tiếng Anh (tuỳ chọn): viết sau một dòng chỉ có "---".',
           'Contract requirements — shown to Team Hưng on the OEM Orders station screen. Empty = nothing shown. Optional English version: write it after a line containing only "---".')}
      </div>
      {clients.map(c => (
        <div key={c} className="px-3 py-2 space-y-1" style={{ borderTop: '1px solid #F3F4F6' }}>
          <div className="text-xs font-bold">{c}</div>
          <textarea rows={4} value={draft[c] ?? cur(c)} onChange={e => setDraft(d => ({ ...d, [c]: e.target.value }))}
            className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
        </div>
      ))}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
        <button onClick={save} disabled={busy || !changed.length} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')}
        </button>
        {changed.length > 0 && <button onClick={() => setDraft({})} className="text-xs" style={{ color: '#6B7280' }}>{L('Huỷ', 'Cancel')}</button>}
        {msg && <span className="text-xs font-semibold" style={{ color: /saved|lưu/i.test(msg) ? '#059669' : '#DC2626' }}>{msg}</span>}
      </div>
    </div>
  );
}

// Who may fix a baked batch from the station before its reception (team lead only — Axel 2026-10-07).
// Stored in lab_mm_settings (admin-only write); the server action re-checks it on every correction.
function EditorPicker({ settings, userName, reload, L }: { settings: Record<string, string>; userName: string | null; reload: () => Promise<void>; L: LFn }) {
  const supabase = useMemo(() => createClient(), []);
  const [people, setPeople] = useState<{ id: string; name: string; team: string }[]>([]);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cur = editorIds(settings[PROD_EDITORS_KEY]);
  useEffect(() => {
    (async () => {
      const [p, t] = await Promise.all([
        supabase.from('profiles').select('id, full_name').eq('role', 'chef'),
        supabase.from('lab_profiles').select('id, team'),
      ]);
      const team: Record<string, string> = Object.fromEntries(((t.data ?? []) as any[]).map(r => [r.id, r.team ?? '']));
      setPeople(((p.data ?? []) as any[]).map(r => ({ id: r.id, name: r.full_name || '—', team: team[r.id] ?? '' }))
        .sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)));
    })();
  }, [supabase]);
  const sel = draft ?? cur;
  const changed = draft != null && (draft.length !== cur.length || draft.some(x => !cur.includes(x)));
  const toggle = (id: string) => setDraft(sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);

  async function save() {
    setBusy(true); setMsg(null);
    const u = await supabase.from('lab_mm_settings').upsert({ key: PROD_EDITORS_KEY, value: sel.join(','), updated_at: new Date().toISOString(), updated_by_name: userName });
    setBusy(false);
    if (u.error) { setMsg(u.error.message); return; }
    setDraft(null); setMsg(L('Đã lưu.', 'Saved.')); await reload();
  }

  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
      <div className="px-3 py-2 text-[11px]" style={{ color: '#6B7280', backgroundColor: '#F9FAFB' }}>
        {L('Ai được sửa hoặc huỷ mẻ nướng của nhóm mình trên màn hình trạm, trước khi trợ lý nhận. Những bếp khác chỉ nhập được, không sửa được.',
           'Who may edit or cancel a baked batch of their own team from the station screen, before an assistant receives it. Other chefs can only enter batches, not change them.')}
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-1.5" style={{ borderTop: '1px solid #F3F4F6' }}>
        {people.map(p => {
          const on = sel.includes(p.id);
          return (
            <button key={p.id} onClick={() => toggle(p.id)} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold"
              style={on ? { backgroundColor: GREEN, color: '#fff' } : { backgroundColor: '#F7F5F0', color: '#6B7280', border: '1px solid #EFE9DC' }}>
              {on ? '✓ ' : ''}{p.name}{p.team ? ` · ${p.team}` : ''}
            </button>
          );
        })}
        {!people.length && <span className="text-xs" style={{ color: '#9CA3AF' }}>…</span>}
      </div>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
        <button onClick={save} disabled={busy || !changed} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')}
        </button>
        {changed && <button onClick={() => setDraft(null)} className="text-xs" style={{ color: '#6B7280' }}>{L('Huỷ', 'Cancel')}</button>}
        {msg && <span className="text-xs font-semibold" style={{ color: /saved|lưu/i.test(msg) ? '#059669' : '#DC2626' }}>{msg}</span>}
      </div>
    </div>
  );
}
