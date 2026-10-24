'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Store, Clock, Save, CheckCircle2, FileText, MapPin, Truck } from 'lucide-react';

// "Birthday cakes from Odoo" (Axel, 2026-10-24): shops keep ordering birthday cakes in their daily
// Odoo REP; the assistant only completes the cake details here. The message the shop typed in the
// Odoo line note is pre-filled — she checks it and saves. "No message" is an explicit choice so the
// red badge only counts cakes nobody has looked at yet.
export type OdooCake = {
  id: string; order_ref: string; name: string; shop: string | null;
  delivery_date: string; delivery_time: string | null; qty: number;
  message: string; messageSaved: boolean; ready_time: string; delivered_by: string; delivery_address: string;
};
type Edit = { message: string; ready_time: string; delivered_by: string; delivery_address: string };

export const NO_MESSAGE = '(không ghi chữ)';
const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];

export default function OdooCakesTab({ cakes, today }: { cakes: OdooCake[]; today: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const ed = (c: OdooCake): Edit => edits[c.id] ?? { message: c.message, ready_time: c.ready_time, delivered_by: c.delivered_by, delivery_address: c.delivery_address };
  const upd = (c: OdooCake, p: Partial<Edit>) => setEdits(s => ({ ...s, [c.id]: { ...ed(c), ...p } }));
  const dirty = (c: OdooCake) => {
    const e = ed(c);
    return !c.messageSaved || e.message !== c.message || e.ready_time !== c.ready_time || e.delivered_by !== c.delivered_by || e.delivery_address !== c.delivery_address;
  };

  async function save(c: OdooCake) {
    const e = ed(c);
    if (!e.message.trim()) { setErr(vi ? 'Ghi chữ trên bánh, hoặc chọn "Không ghi chữ".' : 'Write the message, or tick "No message".'); return; }
    setErr(null); setSaving(c.id);
    const { saveBirthdayDetailAction } = await import('../birthday-cakes/actions');
    const res = await saveBirthdayDetailAction(c.id, { message: e.message.trim(), readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null, deliveryAddress: e.delivery_address || null });
    setSaving(null);
    if (res.error) { setErr(res.error); return; }
    setEdits(s => { const n = { ...s }; delete n[c.id]; return n; });
    router.refresh();
  }

  const upcoming = cakes.filter(c => c.delivery_date >= today).sort((a, b) => (a.delivery_date + (a.delivery_time ?? '')).localeCompare(b.delivery_date + (b.delivery_time ?? '')));
  const history = cakes.filter(c => c.delivery_date < today).sort((a, b) => b.delivery_date.localeCompare(a.delivery_date));
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' });

  const card = (c: OdooCake, readOnly: boolean) => {
    const e = ed(c);
    const noMsg = e.message === NO_MESSAGE;
    const fromNote = !c.messageSaved && !!c.message && e.message === c.message;
    return (
      <div key={c.id} className={`rounded-xl border p-3 space-y-2 ${!c.messageSaved && !readOnly ? 'border-red-300 bg-red-50/40' : 'border-stone-200 bg-white'}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-stone-800">{c.qty > 1 ? `${c.qty} × ` : ''}{c.name}</span>
          <span className="inline-flex items-center gap-1 text-stone-500"><Store size={13} />{c.shop ?? '—'}</span>
          <span className="inline-flex items-center gap-1 text-stone-500"><Clock size={13} />{fmt(c.delivery_date)}{c.delivery_time ? ` · ${c.delivery_time.slice(0, 5)}` : ''}</span>
          <span className="inline-flex items-center gap-1 text-xs text-stone-400"><FileText size={12} />{c.order_ref}</span>
          {c.messageSaved
            ? <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 size={13} />{vi ? 'Đã lưu' : 'Saved'}</span>
            : <span className="ml-auto text-xs font-semibold text-red-700">{vi ? 'Chưa có chữ' : 'No message yet'}</span>}
        </div>
        {readOnly ? (
          <div className="text-sm text-stone-700">“{c.message || '—'}”{c.ready_time ? ` · ${vi ? 'xong lúc' : 'ready'} ${c.ready_time}` : ''}{c.delivered_by ? ` · ${c.delivered_by}` : ''}</div>
        ) : (
          <>
            <div className="space-y-1">
              <input value={noMsg ? '' : e.message} disabled={noMsg} onChange={ev => upd(c, { message: ev.target.value })}
                placeholder={vi ? 'Chữ ghi trên bánh' : 'Message on the cake'}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm disabled:bg-stone-100" />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {fromNote && <span className="text-amber-700">{vi ? 'Lấy từ ghi chú Odoo — kiểm tra rồi bấm Lưu' : 'From the Odoo note — check it, then Save'}</span>}
                <label className="inline-flex items-center gap-1 text-stone-600">
                  <input type="checkbox" checked={noMsg} onChange={ev => upd(c, { message: ev.target.checked ? NO_MESSAGE : (c.message === NO_MESSAGE ? '' : c.message) })} />
                  {vi ? 'Không ghi chữ' : 'No message'}
                </label>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className="flex min-w-0 items-center gap-1 text-xs text-stone-500"><Clock size={13} />
                <input type="time" value={e.ready_time} onChange={ev => upd(c, { ready_time: ev.target.value })} className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="flex min-w-0 items-center gap-1 text-xs text-stone-500"><Truck size={13} />
                <select value={e.delivered_by} onChange={ev => upd(c, { delivered_by: ev.target.value })} className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
                  <option value="">{vi ? 'Ai giao?' : 'Delivered by?'}</option>
                  {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="flex min-w-0 items-center gap-1 text-xs text-stone-500"><MapPin size={13} />
                <input value={e.delivery_address} onChange={ev => upd(c, { delivery_address: ev.target.value })} placeholder={vi ? 'Địa chỉ (nếu giao khách)' : 'Address (if to customer)'} className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm" />
              </label>
            </div>
            {dirty(c) && (
              <button onClick={() => save(c)} disabled={saving === c.id}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
                <Save size={14} />{saving === c.id ? '…' : (vi ? 'Lưu' : 'Save')}
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-500">{vi
        ? 'Cửa hàng vẫn đặt bánh sinh nhật trong đơn REP Odoo hằng ngày. Ở đây chỉ cần ghi chữ, giờ xong và người giao.'
        : 'Shops still order birthday cakes in their daily Odoo REP. Here you only add the message, ready time and who delivers.'}</p>
      {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      {upcoming.length === 0 && <div className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">{vi ? 'Không có bánh sinh nhật sắp giao.' : 'No upcoming birthday cake.'}</div>}
      {upcoming.map(c => card(c, false))}
      <button onClick={() => setShowHistory(h => !h)} className="text-sm font-semibold text-stone-600 underline">
        {vi ? `Lịch sử · 7 ngày (${history.length})` : `History · 7 days (${history.length})`}
      </button>
      {showHistory && history.map(c => card(c, true))}
    </div>
  );
}
