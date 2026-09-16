'use client';
import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, AlertCircle, QrCode, X } from 'lucide-react';
import { createEventAction, listEventsAction, closeEventAction, uploadEventQrAction, removeEventQrAction, type CreateEventFormResult } from './actions';
import type { EventShop } from '@/lib/event-shops';

// Same downsize-before-upload as the online-orders payment-proof upload (OnlineOrdersView.tsx) —
// a bank-app QR screenshot is typically 1-3 MB straight off a phone, ~100-250 KB after this.
async function compressImage(file: File, maxSide = 1200, quality = 0.8): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

export default function EventsAdminView() {
  const [events, setEvents] = useState<EventShop[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateEventFormResult | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [uploadingQrFor, setUploadingQrFor] = useState<string | null>(null);

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

  // Payment QR (Axel, 2026-09-14): one image per event, uploaded here ahead of time — the
  // mini-caisse (EventCaisseTab) shows it whenever staff records a "chuyển khoản" sale.
  async function uploadQr(id: string, file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    setUploadingQrFor(id);
    const fd = new FormData(); fd.append('file', await compressImage(file));
    await uploadEventQrAction(id, fd);
    setUploadingQrFor(null);
    load();
  }
  async function removeQr(id: string) {
    setUploadingQrFor(id);
    await removeEventQrAction(id);
    setUploadingQrFor(null);
    load();
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
        <div className="text-sm font-semibold">Create new event</div>
        <p className="text-xs text-gray-500">
          Create the warehouse in Odoo first (Inventory → Configuration → Warehouses), then enter
          its code here — the app only links to it, it never creates a warehouse itself.
        </p>

        <div className="space-y-2">
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Event name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="E.g.: Vincom Long Biên Tết Fair"
              className="w-full text-sm rounded-lg px-3 py-2" style={{ border: '1px solid #E5E7EB' }} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Odoo warehouse code (max 5 characters)</label>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 5))} placeholder="E.g.: EVTET"
              className="w-full text-sm rounded-lg px-3 py-2 uppercase" style={{ border: '1px solid #E5E7EB' }} />
          </div>
        </div>

        <button onClick={submit} disabled={creating || !name.trim() || !code.trim()}
          className="inline-flex items-center gap-2 text-sm font-bold rounded-lg px-4 py-2.5 text-white disabled:opacity-50"
          style={{ backgroundColor: '#1A4731' }}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          ＋ Create event (link existing warehouse)
        </button>

        {created?.error && (
          <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-red-700" style={{ backgroundColor: '#FEF2F2' }}>
            <AlertCircle size={14} className="shrink-0 mt-0.5" /> {created.error}
          </div>
        )}
        {created?.event && created?.pin && (
          <div className="rounded-xl px-4 py-3 text-center" style={{ background: '#FFFAEE', border: '1.5px dashed #C9A84C' }}>
            <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#92600A' }}>Staff PIN</div>
            <div className="text-3xl font-extrabold tracking-widest" style={{ color: '#1A4731' }}>{created.pin.split('').join(' ')}</div>
            <div className="text-xs text-gray-500 mt-1.5">
              ✓ Linked to warehouse &quot;{created.event.warehouseCode}&quot;. Give this PIN to staff at the counter — no account needed.
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
          Open events
        </div>
        {!events ? (
          <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !active.length ? (
          <div className="px-4 py-4 text-xs text-gray-400">No events currently open</div>
        ) : active.map((e, i) => (
          <div key={e.id} className="flex items-center gap-2.5 px-4 py-2.5 text-sm" style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
            <div className="font-semibold flex-1 min-w-0 truncate">{e.name}</div>
            <div className="text-xs text-gray-500 shrink-0">Warehouse {e.warehouseCode}</div>
            {e.qrCodeUrl ? (
              <div className="relative shrink-0">
                <img src={e.qrCodeUrl} alt="Bank transfer QR" className="w-9 h-9 rounded-md object-cover" style={{ border: '1px solid #E5E7EB' }} />
                <button onClick={() => removeQr(e.id)} disabled={uploadingQrFor === e.id}
                  title="Remove bank transfer QR" aria-label="Remove bank transfer QR"
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
                  style={{ background: '#DC2626', color: '#fff' }}>
                  <X size={10} />
                </button>
              </div>
            ) : (
              <label title="Upload bank transfer QR for this event" className="shrink-0 cursor-pointer inline-flex items-center gap-1 text-xs font-bold rounded-lg px-2.5 py-1.5"
                style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1D4ED8' }}>
                {uploadingQrFor === e.id ? <Loader2 size={12} className="animate-spin" /> : <QrCode size={12} />}
                QR
                <input type="file" accept="image/*" className="hidden" onChange={ev => uploadQr(e.id, ev.target.files?.[0])} />
              </label>
            )}
            <button onClick={() => close(e.id)} disabled={closingId === e.id}
              className="text-xs font-bold rounded-lg px-2.5 py-1.5 shrink-0 disabled:opacity-50"
              style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#DC2626' }}>
              {closingId === e.id ? '…' : 'Close'}
            </button>
          </div>
        ))}
      </div>

      {closed.length > 0 && (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
            Closed
          </div>
          {closed.map((e, i) => (
            <div key={e.id} className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-400" style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
              <div className="flex-1 min-w-0 truncate">{e.name}</div>
              <div className="text-xs shrink-0">Warehouse {e.warehouseCode}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
