'use client';
import { useMemo, useState } from 'react';
import { Loader2, Trash2, Pencil, Check, X, Plus } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { Empty } from './ui';
import { fmt, localToday, itemKg, GREEN, MM_CLIENT, type Item, type ProdLog, type Hist, type LFn } from './model';

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
  const shown = filter ? logs.filter(l => l.group_key === filter) : logs;
  const total = shown.reduce((s, l) => s + l.weight_kg, 0);

  async function saveEdit(id: string) {
    const kg = Number(editKg.replace(',', '.'));
    if (!(kg > 0)) return;
    setBusy(true);
    const { error } = await supabase.from('lab_mm_production_log').update({ weight_kg: kg, note: editNote.trim() || null }).eq('id', id);
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setEditId(null); await reload();
  }
  async function del(id: string) {
    setBusy(true);
    const { error } = await supabase.from('lab_mm_production_log').delete().eq('id', id);
    setBusy(false); setConfirmDel(null);
    if (error) { setMsg(error.message); return; }
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
                <div className="text-[11px] truncate" style={{ color: '#9CA3AF' }}>{l.created_by_name || '—'}{l.note ? ` · ${l.note}` : ''}</div>
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
    </div>
  );
}

export function OrderSettings({ items, hist, odooOn, userId, userName, reload, L }: {
  items: Item[]; hist: Hist[]; odooOn: boolean; userId: string | null; userName: string | null; reload: () => Promise<void>; L: LFn;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const changed = items.filter(i => draft[i.sku] !== undefined && draft[i.sku] !== '' && Number(draft[i.sku]) !== i.qty_ordered && Number(draft[i.sku]) >= 0);

  async function save() {
    setBusy(true); setMsg(null);
    for (const i of changed) {
      const after = Number(draft[i.sku]);
      const h = await supabase.from('lab_mm_order_item_history').insert({ sku: i.sku, qty_before: i.qty_ordered, qty_after: after, changed_by: userId, changed_by_name: userName });
      if (h.error) { setMsg(h.error.message); setBusy(false); return; }
      const u = await supabase.from('lab_mm_order_items').update({ qty_ordered: after, updated_at: new Date().toISOString(), updated_by: userId, updated_by_name: userName }).eq('sku', i.sku);
      if (u.error) { setMsg(u.error.message); setBusy(false); return; }
    }
    setBusy(false); setDraft({}); setMsg(L('Đã lưu.', 'Saved.')); await reload();
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
          {L('Số lượng đặt (gói hoặc kg). Mỗi thay đổi được lưu vào lịch sử.', 'Ordered quantity (bags, or kg for cashews). Every change is kept in the history.')}
        </div>
        {items.map(i => (
          <div key={i.sku} className="flex items-center gap-3 px-3 py-2 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{i.product_name}</div>
              <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{i.sku} · {i.client_name || MM_CLIENT}</div>
            </div>
            <input inputMode="numeric" value={draft[i.sku] ?? String(i.qty_ordered)} onChange={e => setDraft(d => ({ ...d, [i.sku]: e.target.value.replace(/[^0-9.]/g, '') }))}
              className="w-24 rounded-lg px-2 py-1 text-sm font-bold text-right" style={{ border: '1px solid #D1D5DB' }} />
            <div className="w-10 text-xs" style={{ color: '#6B7280' }}>{i.unit === 'kg' ? 'kg' : L('gói', 'bags')}</div>
            <div className="w-20 text-right text-[11px]" style={{ color: '#9CA3AF' }}>{fmt(kgOf(i), 0)} kg</div>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: '1px solid #F3F4F6' }}>
          <button onClick={save} disabled={busy || !changed.length} className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40" style={{ backgroundColor: GREEN }}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{L('Lưu', 'Save')} {changed.length ? `(${changed.length})` : ''}
          </button>
          {changed.length > 0 && <button onClick={() => setDraft({})} className="text-xs" style={{ color: '#6B7280' }}>{L('Huỷ', 'Cancel')}</button>}
          {msg && <span className="text-xs font-semibold" style={{ color: /saved|lưu/i.test(msg) ? '#059669' : '#DC2626' }}>{msg}</span>}
        </div>
      </div>

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
