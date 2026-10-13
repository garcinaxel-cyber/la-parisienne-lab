'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Loader2, AlertCircle, QrCode, X, Store } from 'lucide-react';
import { createEventAction, listEventsAction, closeEventAction, uploadEventQrAction, removeEventQrAction, enterEventAsStaffAction, regenerateEventPinAction, setEventDatesAction, setEventTargetAction, type CreateEventFormResult } from './actions';
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

export default function EventsAdminView({ canManage = false }: { canManage?: boolean }) {
  const router = useRouter();
  const [events, setEvents] = useState<EventShop[] | null>(null);
  const [code, setCode] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // The PIN is stored hashed and only ever shown at creation — if it was not written down there
  // was no way to get one back short of closing and recreating the event. This issues a new one.
  const [newPin, setNewPin] = useState<{ name: string; pin: string } | null>(null);
  const [pinBusyId, setPinBusyId] = useState<string | null>(null);
  async function regeneratePin(e: EventShop) {
    if (!window.confirm(`Issue a new PIN for "${e.name}"? The current PIN will stop working.`)) return;
    setPinBusyId(e.id);
    setOpenError(null);
    const res = await regenerateEventPinAction(e.id);
    setPinBusyId(null);
    if (res.error || !res.pin) { setOpenError(res.error ?? 'Could not issue a new PIN'); return; }
    setNewPin({ name: e.name, pin: res.pin });
  }

  // One click into the event's own screens (caisse, deliveries, losses, stock) — no PIN for an
  // admin or the lab manager (Axel, 2026-10-07: "je dois pouvoir rentrer dans l'event facilement").
  async function openEvent(id: string) {
    setOpeningId(id);
    setOpenError(null);
    const res = await enterEventAsStaffAction(id);
    if (res.error) { setOpenError(res.error); setOpeningId(null); return; }
    router.push(`/admin/events/${id}`);
  }
  // Event days — typed per event, saved explicitly. The event's Báo cáo tab lists these days only.
  const [dateDraft, setDateDraft] = useState<Record<string, { start: string; end: string }>>({});
  const [dateBusyId, setDateBusyId] = useState<string | null>(null);
  const datesOf = (e: EventShop) => dateDraft[e.id] ?? { start: e.startDate ?? '', end: e.endDate ?? '' };
  const fmtDay = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
  async function saveDates(e: EventShop) {
    const d = datesOf(e);
    setDateBusyId(e.id);
    setOpenError(null);
    const res = await setEventDatesAction(e.id, d.start || null, d.end || null);
    setDateBusyId(null);
    if (res.error) { setOpenError(res.error); return; }
    setDateDraft(prev => { const next = { ...prev }; delete next[e.id]; return next; });
    load();
  }
  // Sales target per day + opening hours (2026-10-10) — shown on the event's Sales screen only.
  // One field per event day; a day left empty has no target.
  const [targetDraft, setTargetDraft] = useState<Record<string, { days: Record<string, string>; open: string; close: string }>>({});
  const [targetBusyId, setTargetBusyId] = useState<string | null>(null);
  const eventDayList = (e: EventShop): string[] => {
    if (!e.startDate || !e.endDate || e.endDate < e.startDate) return [];
    const out: string[] = []; const d = new Date(e.startDate + 'T00:00:00Z');
    for (let i = 0; i < 31; i++) { const k = d.toISOString().slice(0, 10); if (k > e.endDate) break; out.push(k); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
  };
  const targetOf = (e: EventShop) => targetDraft[e.id] ?? {
    days: Object.fromEntries(Object.entries(e.dailyTargets ?? {}).map(([k, v]) => [k, String(Math.round(v / 1e6 * 10) / 10)])),
    open: e.openTime || '10:00', close: e.closeTime || '22:00',
  };
  async function saveTarget(e: EventShop) {
    const d = targetOf(e);
    const targets: Record<string, number> = {};
    for (const [day, raw] of Object.entries(d.days)) {
      if (!raw.trim()) continue;
      const m = Number(raw.replace(',', '.'));
      if (!Number.isFinite(m) || m <= 0) { setOpenError(`Target ${fmtDay(day)}: a number of millions, e.g. 50`); return; }
      targets[day] = Math.round(m * 1e6);
    }
    setTargetBusyId(e.id);
    setOpenError(null);
    const res = await setEventTargetAction(e.id, targets, d.open, d.close);
    setTargetBusyId(null);
    if (res.error) { setOpenError(res.error); return; }
    setTargetDraft(prev => { const next = { ...prev }; delete next[e.id]; return next; });
    load();
  }
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
    const res = await createEventAction({ warehouseCode: code });
    setCreated(res);
    setCreating(false);
    if (res.event) {
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

      {canManage && (
      <div className="bg-white rounded-2xl p-5 space-y-3" style={{ border: '1px solid #E5E7EB' }}>
        <div className="text-sm font-semibold">Create new event</div>
        <p className="text-xs text-gray-500">
          Create the warehouse in Odoo first (Inventory → Configuration → Warehouses), then enter
          its code here — the app only links to it, it never creates a warehouse itself. The event
          takes the warehouse&apos;s own name from Odoo, so its replenishment orders land in it.
        </p>

        <div className="space-y-2">
          <div>
            <label className="text-xs font-semibold text-gray-600 block mb-1">Odoo warehouse code (max 5 characters)</label>
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase().slice(0, 5))} placeholder="E.g.: EVTET"
              className="w-full text-sm rounded-lg px-3 py-2 uppercase" style={{ border: '1px solid #E5E7EB' }} />
          </div>
        </div>

        <button onClick={submit} disabled={creating || !code.trim()}
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
      )}

      {openError && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-red-700" style={{ backgroundColor: '#FEF2F2' }}>
          <AlertCircle size={14} className="shrink-0 mt-0.5" /> {openError}
        </div>
      )}
      {newPin && (
        <div className="rounded-xl px-4 py-3 text-center" style={{ background: '#FFFAEE', border: '1.5px dashed #C9A84C' }}>
          <div className="text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#92600A' }}>New staff PIN — {newPin.name}</div>
          <div className="text-3xl font-extrabold tracking-widest" style={{ color: '#1A4731' }}>{newPin.pin.split('').join(' ')}</div>
          <div className="text-xs text-gray-500 mt-1.5">The previous PIN no longer works. Shown once — note it now.</div>
        </div>
      )}

      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
          Open events
        </div>
        {!events ? (
          <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !active.length ? (
          <div className="px-4 py-4 text-xs text-gray-400">No events currently open</div>
        ) : active.map((e, i) => (
          <div key={e.id} style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 px-4 py-2.5 text-sm">
            <div className="font-semibold basis-full sm:basis-0 sm:flex-1 min-w-0 break-words sm:truncate">{e.name}</div>
            <div className="text-xs text-gray-500 shrink-0">Warehouse {e.warehouseCode}</div>
            <button onClick={() => openEvent(e.id)} disabled={openingId === e.id}
              className="inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 shrink-0 text-white disabled:opacity-60"
              style={{ backgroundColor: '#1A4731' }}>
              {openingId === e.id ? <Loader2 size={12} className="animate-spin" /> : <Store size={12} />}
              Open
            </button>
            {!canManage ? null : e.qrCodeUrl ? (
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
            {canManage && (
            <button onClick={() => regeneratePin(e)} disabled={pinBusyId === e.id}
              title="Issue a new staff PIN for this event"
              className="text-xs font-bold rounded-lg px-2.5 py-1.5 shrink-0 disabled:opacity-50"
              style={{ background: '#FFFAEE', border: '1px solid #E0D49A', color: '#8A6D14' }}>
              {pinBusyId === e.id ? '…' : 'New PIN'}
            </button>
            )}
            {canManage && (
            <button onClick={() => close(e.id)} disabled={closingId === e.id}
              className="text-xs font-bold rounded-lg px-2.5 py-1.5 shrink-0 disabled:opacity-50"
              style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#DC2626' }}>
              {closingId === e.id ? '…' : 'Close'}
            </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-gray-500">
            <span className="font-semibold">Event days</span>
            {canManage ? (
              <>
                <input type="date" value={datesOf(e).start} aria-label="First day of the event"
                  onChange={ev => setDateDraft(prev => ({ ...prev, [e.id]: { ...datesOf(e), start: ev.target.value } }))}
                  className="rounded-lg px-2 py-1 text-xs" style={{ border: '1px solid #E5E7EB' }} />
                <span>to</span>
                <input type="date" value={datesOf(e).end} aria-label="Last day of the event"
                  onChange={ev => setDateDraft(prev => ({ ...prev, [e.id]: { ...datesOf(e), end: ev.target.value } }))}
                  className="rounded-lg px-2 py-1 text-xs" style={{ border: '1px solid #E5E7EB' }} />
                {dateDraft[e.id] && (
                  <button onClick={() => saveDates(e)} disabled={dateBusyId === e.id}
                    className="text-xs font-bold rounded-lg px-2.5 py-1 text-white disabled:opacity-50" style={{ backgroundColor: '#1A4731' }}>
                    {dateBusyId === e.id ? '…' : 'Save'}
                  </button>
                )}
              </>
            ) : (
              <span>{e.startDate && e.endDate ? `${fmtDay(e.startDate)} to ${fmtDay(e.endDate)}` : 'not set'}</span>
            )}
            <span className="text-gray-400">Reports in the event show these days only.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs text-gray-500">
            <span className="font-semibold">Daily target</span>
            {canManage ? (
              eventDayList(e).length === 0 ? <span className="text-gray-400">set the event days first</span> : (
              <>
                {eventDayList(e).map(day => (
                  <label key={day} className="inline-flex items-center gap-1">
                    <span>{fmtDay(day)}</span>
                    <input type="text" inputMode="decimal" value={targetOf(e).days[day] ?? ''} placeholder="—" aria-label={`Sales target ${day} in millions`}
                      onChange={ev => setTargetDraft(prev => ({ ...prev, [e.id]: { ...targetOf(e), days: { ...targetOf(e).days, [day]: ev.target.value } } }))}
                      className="rounded-lg px-2 py-1 text-xs w-12 text-right" style={{ border: '1px solid #E5E7EB' }} />
                  </label>
                ))}
                <span>M ₫ · open</span>
                <input type="time" value={targetOf(e).open} aria-label="Opening time"
                  onChange={ev => setTargetDraft(prev => ({ ...prev, [e.id]: { ...targetOf(e), open: ev.target.value } }))}
                  className="rounded-lg px-2 py-1 text-xs" style={{ border: '1px solid #E5E7EB' }} />
                <span>close</span>
                <input type="time" value={targetOf(e).close} aria-label="Closing time"
                  onChange={ev => setTargetDraft(prev => ({ ...prev, [e.id]: { ...targetOf(e), close: ev.target.value } }))}
                  className="rounded-lg px-2 py-1 text-xs" style={{ border: '1px solid #E5E7EB' }} />
                {targetDraft[e.id] && (
                  <button onClick={() => saveTarget(e)} disabled={targetBusyId === e.id}
                    className="text-xs font-bold rounded-lg px-2.5 py-1 text-white disabled:opacity-50" style={{ backgroundColor: '#1A4731' }}>
                    {targetBusyId === e.id ? '…' : 'Save'}
                  </button>
                )}
              </>)
            ) : (
              <span>{Object.keys(e.dailyTargets ?? {}).length
                ? Object.entries(e.dailyTargets).sort().map(([k, v]) => `${fmtDay(k)} ${Math.round(v / 1e6 * 10) / 10}M`).join(' · ') + ` · ${e.openTime}–${e.closeTime}`
                : 'none'}</span>
            )}
            <span className="text-gray-400">Shown on the event's Sales screen for that day only (ring + pace). Empty = no target.</span>
          </div>
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
