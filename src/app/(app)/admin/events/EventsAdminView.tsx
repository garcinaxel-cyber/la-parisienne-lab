'use client';
import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, AlertCircle } from 'lucide-react';
import { createEventAction, listEventsAction, closeEventAction, type CreateEventFormResult } from './actions';
import type { EventShop } from '@/lib/event-shops';

export default function EventsAdminView() {
  const [events, setEvents] = useState<EventShop[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateEventFormResult | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  async function load() {
    const res = await listEventsAction();
    setEvents(res.events ?? []);
  }
  useEffect(() => { load(); }, []);

  async function submit() {
    setCreating(true);
    setCreated(null);
    const res = await createEventAction({ name, warehouseCode: code });
    setCreated(res);
    setCreating(false);
    if (res.event) {
      setName('');
      setCode('');
      load();
    }
  }

  async function close(id: string) {
    setClosingId(id);
    await closeEventAction(id);
    await load();
    setClosingId(null);
  }

  const active = (events ?? []).filter(e => e.active);
  const closed = (events ?? []).filter(e => !e.active);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <CalendarDays size={22} className="text-navy" />
        <h1 className="text-xl font-bold">Event shops</h1>
      </div>

      <div className="bg-white rounded-2xl p-5 space-y-3" style={{ border: '1px solid #E5E7EB' }}>
        <div className="text-sm font-semibold">Tạo event mới</div>
        <p className="text-xs text-gray-500">
          Tạo kho trong Odoo trước (Kho vận → Cấu hình → Kho hàng), rồi nhập mã kho ở đây — app chỉ
          liên kết, không tự tạo kho.
        </p>

        <div className="space-y-2">
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Tên event</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="VD: Hội chợ Tết Vincom Long Biên"
              className="w-full text-sm rounded-lg px-3 py-2" style={{ border: '1px solid #E5E7EB' }} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Mã kho Odoo (tối đa 5 ký tự)</label>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 5))} placeholder="VD: EVTET"
              className="w-full text-sm rounded-lg px-3 py-2 uppercase" style={{ border: '1px solid #E5E7EB' }} />
          </div>
        </div>

        <button onClick={submit} disabled={creating || !name.trim() || !code.trim()}
          className="inline-flex items-center gap-2 text-sm font-bold rounded-lg px-4 py-2.5 text-white disabled:opacity-50"
          style={{ backgroundColor: '#1A4731' }}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          ＋ Tạo event (liên kết kho có sẵn)
        </button>

        {created?.error && (
          <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-red-700" style={{ backgroundColor: '#FEF2F2' }}>
            <AlertCircle size={14} className="shrink-0 mt-0.5" /> {created.error}
          </div>
        )}
        {created?.event && created?.pin && (
          <div className="rounded-xl px-4 py-3 text-center" style={{ background: '#FFFAEE', border: '1.5px dashed #C9A84C' }}>
            <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#92600A' }}>Mã PIN cho staff</div>
            <div className="text-3xl font-extrabold tracking-widest" style={{ color: '#1A4731' }}>{created.pin.split('').join(' ')}</div>
            <div className="text-xs text-gray-500 mt-1.5">
              ✓ Đã liên kết kho &quot;{created.event.warehouseCode}&quot;. Đưa mã PIN này cho nhân viên tại quầy — không cần tài khoản.
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
          Events đang mở
        </div>
        {!events ? (
          <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !active.length ? (
          <div className="px-4 py-4 text-xs text-gray-400">Chưa có event nào đang mở</div>
        ) : active.map((e, i) => (
          <div key={e.id} className="flex items-center gap-2.5 px-4 py-2.5 text-sm" style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
            <div className="font-semibold flex-1 min-w-0 truncate">{e.name}</div>
            <div className="text-xs text-gray-500 shrink-0">Kho {e.warehouseCode}</div>
            <button onClick={() => close(e.id)} disabled={closingId === e.id}
              className="text-xs font-bold rounded-lg px-2.5 py-1.5 shrink-0 disabled:opacity-50"
              style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#DC2626' }}>
              {closingId === e.id ? '…' : 'Đóng'}
            </button>
          </div>
        ))}
      </div>

      {closed.length > 0 && (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
            Đã đóng
          </div>
          {closed.map((e, i) => (
            <div key={e.id} className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-400" style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
              <div className="flex-1 min-w-0 truncate">{e.name}</div>
              <div className="text-xs shrink-0">Kho {e.warehouseCode}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
