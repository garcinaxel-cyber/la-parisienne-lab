'use client';
import { useMemo, useRef, useState } from 'react';
import { Printer, Upload as Camera, Loader2, PackageCheck as PackageOpen, X } from 'lucide-react';
import { Chip, Btn } from './ui';
import { fmt, dmy, itemKg, GREEN, GOLD, MUTED, FAINT, LINE, MM_CLIENT, type Item, type ProdLog, type Delivery, type LFn } from './model';
import { createDeliveryNoteAction, voidDeliveryNoteAction, signDeliveryNoteAction } from '@/lib/oem-actions';

// Carton labels + delivery note for one Odoo delivery order (Axel, 2026-10-14). The assistant only
// sets how many bags go in a carton; serials, lots and dates come from the rules:
//   production date = delivery − 2 days, packing date = delivery − 1 day, best-before = delivery + 120 days.
// The production date must be a real baking day of the product (production log); an older one than
// the rule needs an admin / lab-manager OK with a reason (kept on the note).
export type Note = {
  id: string; note_no: string; client_name: string; order_ref: string; delivery_date: string; pack_date: string; best_before: string;
  status: 'ready' | 'signed' | 'void'; override_by_name: string | null; override_note: string | null;
  signed_photo_url: string | null; signed_at: string | null; signed_by_name: string | null; created_at: string; created_by_name: string | null; prepared_by: string | null;
};
export type Carton = { id: string; note_id: string; serial: string; line_no: number; sku: string; group_key: string; lot_no: string; prod_date: string; bags: number; bag_kg: number; net_kg: number };
export type CartonFormat = { client_name: string; sku: string; bags_per_carton: number; bag_kg: number };
export const NOTE_COLS = 'id, note_no, client_name, order_ref, delivery_date, pack_date, best_before, status, override_by_name, override_note, signed_photo_url, signed_at, signed_by_name, created_at, created_by_name, prepared_by';

const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ERR: Record<string, [string, string]> = {
  'needs-manager': ['Ngày sản xuất cũ hơn quy tắc — cần xác nhận.', 'Production date older than the rule — confirmation required.'],
  'needs-prepared-by': ['Nhập họ tên người chuẩn bị thùng.', 'Enter the name of who prepared the cartons.'],
  'needs-reason': ['Ghi lý do để xác nhận.', 'Write a reason to confirm.'],
  'no-client-info': ['Chưa có thông tin khách hàng (cài đặt).', 'Client details missing (settings).'],
  'already-signed': ['Phiếu đã ký — không huỷ được.', 'Note already signed — cannot be cancelled.'],
};

export default function OrderCartons({ orderRef, deliveryDate, lines, items, prod, notes, cartons, formats, canPack, reload, L }: {
  orderRef: string; deliveryDate: string; lines: Delivery[]; items: Item[]; prod: ProdLog[]; notes: Note[]; cartons: Carton[]; formats: CartonFormat[];
  canPack: boolean; canManage: boolean; reload: () => Promise<void>; L: LFn;
}) {
  const bySku = useMemo(() => Object.fromEntries(items.map(i => [i.sku, i])) as Record<string, Item>, [items]);
  const clientName = bySku[lines[0]?.sku]?.client_name || MM_CLIENT;
  const mine = notes.filter(n => n.order_ref === orderRef && n.delivery_date === deliveryDate);
  const live = mine.filter(n => n.status !== 'void');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ruleProd = addDays(deliveryDate, -2);
  const showErr = (e: string) => { const m = ERR[e] ?? (e.startsWith('not-a-production-date') ? ['Ngày này không có mẻ nướng nào trong sổ sản xuất.', 'No baking of this product on that day in the production log.'] : null); setErr(m ? L(m[0], m[1]) : e); };

  // one line per product of the order (kg)
  const orderLines = useMemo(() => lines.map(l => {
    const it = bySku[l.sku]; const q = Number(l.qty_planned ?? l.qty_expected ?? 0);
    return it ? { sku: l.sku, it, kg: itemKg(it, q) } : null;
  }).filter((x): x is { sku: string; it: Item; kg: number } => !!x && x.kg > 0), [lines, bySku]);
  // the rule date (delivery − 2 days) is always offered and is the default, even if the baking is not logged yet
  const prodDates = (g: string) => Array.from(new Set([ruleProd, ...prod.filter(p => p.group_key === g).map(p => p.prod_date)])).sort().reverse();

  const [cfg, setCfg] = useState<Record<string, { per: string; bag: string; date: string }>>({});
  const cfgOf = (sku: string, it: Item) => {
    if (cfg[sku]) return cfg[sku];
    const f = formats.find(x => x.client_name === clientName && x.sku === sku);
    return { per: String(f?.bags_per_carton ?? 2), bag: String(f?.bag_kg ?? (Number(it.sack_kg) || 5)), date: ruleProd };
  };
  const setC = (sku: string, it: Item, k: 'per' | 'bag' | 'date', v: string) => setCfg(s => ({ ...s, [sku]: { ...cfgOf(sku, it), [k]: v } }));
  const preview = orderLines.map(x => {
    const c = cfgOf(x.sku, x.it); const per = Math.round(Number(c.per)) || 0; const bag = Number(c.bag.replace(',', '.')) || 0;
    const full = per * bag; const n = full > 0 ? Math.ceil(x.kg / full - 1e-9) : 0; const rest = full > 0 ? Math.round((x.kg - full * Math.floor(x.kg / full + 1e-9)) * 1000) / 1000 : 0;
    return { ...x, c, per, bag, full, n, rest, old: !!c.date && c.date < ruleProd };
  });
  const anyOld = preview.some(p => p.old);
  const [why, setWhy] = useState('');
  // who prepared the cartons: typed by the person (app names are nicknames); remembered on this device
  const [by, setBy] = useState(() => { try { return localStorage.getItem('oem_prepared_by') ?? ''; } catch { return ''; } });
  const valid = preview.length > 0 && preview.every(p => p.per >= 1 && p.bag > 0 && p.c.date) && !!by.trim() && (!anyOld || !!why.trim());

  async function create() {
    setBusy('create'); setErr(null);
    const r = await createDeliveryNoteAction({ clientName, orderRef, deliveryDate, overrideNote: anyOld ? why : null, preparedBy: by.trim(),
      lines: preview.map(p => ({ sku: p.sku, kg: p.kg, bagsPerCarton: p.per, bagKg: p.bag, prodDate: p.c.date })) });
    setBusy(null);
    if (r.error) return showErr(r.error);
    try { localStorage.setItem('oem_prepared_by', by.trim()); } catch { /* ignore */ }
    setOpen(false); setWhy(''); await reload();
  }
  async function voidNote(id: string) {
    setBusy(id); setErr(null); const r = await voidDeliveryNoteAction(id); setBusy(null);
    if (r.error) return showErr(r.error); await reload();
  }
  const fileRef = useRef<HTMLInputElement>(null); const [signId, setSignId] = useState<string | null>(null);
  async function onPhoto(f: File | undefined) {
    if (!f || !signId) return;
    setBusy(signId); setErr(null);
    const fd = new FormData(); fd.set('id', signId); fd.set('file', await shrink(f));
    const r = await signDeliveryNoteAction(fd); setBusy(null); setSignId(null);
    if (r.error) return showErr(r.error); await reload();
  }

  if (!orderLines.length) return null;
  return (
    <div className="mt-3 rounded-xl p-3 space-y-2.5" style={{ backgroundColor: '#FBF8F2', border: `1px solid ${LINE}` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>{L('Tem thùng & phiếu giao hàng', 'Carton labels & delivery note')}</div>
        {canPack && !open && <Btn primary onClick={() => { setOpen(true); setErr(null); }}><PackageOpen size={13} />{live.length ? L('Tạo phiếu mới', 'New note') : L('Chuẩn bị thùng', 'Prepare cartons')}</Btn>}
      </div>
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{err}</div>}

      {live.map(n => {
        const cs = cartons.filter(c => c.note_id === n.id);
        const kg = cs.reduce((s, c) => s + Number(c.net_kg), 0); const bags = cs.reduce((s, c) => s + c.bags, 0);
        return (
          <div key={n.id} className="bg-white rounded-xl px-3 py-2.5 space-y-2" style={{ border: `1px solid ${LINE}` }}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <b>{n.note_no}</b>
              <span className="text-xs" style={{ color: MUTED }}>{cs.length} {L('thùng', 'cartons')} · {bags} {L('túi', 'bags')} · {fmt(kg, 1)} kg</span>
              {n.status === 'signed' ? <Chip tone="green">{L('Khách đã ký', 'Signed by client')} · {n.signed_at ? dmy(n.signed_at.slice(0, 10)) : ''}</Chip> : <Chip tone="amber">{L('Chờ chữ ký khách', 'Waiting for signature')}</Chip>}
              {n.override_by_name && <Chip tone="red">{L('Ngày SX cũ — xác nhận bởi', 'Old prod. date — OK by')} {n.override_by_name}</Chip>}
            </div>
            <div className="text-[11px]" style={{ color: FAINT }}>
              {L('Đóng gói', 'Packed')} {dmy(n.pack_date)} · HSD {dmy(n.best_before)} · {Array.from(new Set(cs.map(c => c.lot_no))).join(', ')}{n.prepared_by ? ` · ${L('Chuẩn bị', 'Prepared by')} ${n.prepared_by}` : ''}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <a href={`/oem-print?id=${n.id}&doc=labels`} target="_blank" rel="noreferrer"><Btn><Printer size={13} />{L('In tem thùng', 'Print labels')}</Btn></a>
              <a href={`/oem-print?id=${n.id}&doc=note`} target="_blank" rel="noreferrer"><Btn><Printer size={13} />{L('In phiếu giao hàng', 'Print delivery note')}</Btn></a>
              {canPack && n.status === 'ready' && <Btn disabled={busy === n.id} onClick={() => { setSignId(n.id); fileRef.current?.click(); }}>{busy === n.id ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}{L('Chụp phiếu đã ký', 'Photo of signed note')}</Btn>}
              {n.signed_photo_url && <a href={n.signed_photo_url} target="_blank" rel="noreferrer"><Btn>{L('Xem phiếu đã ký', 'See signed note')}</Btn></a>}
              {canPack && n.status === 'ready' && <Btn disabled={busy === n.id} onClick={() => { if (confirm(L('Huỷ phiếu này? Số serial sẽ không dùng lại.', 'Cancel this note? Its serials will not be reused.'))) voidNote(n.id); }}><X size={13} />{L('Huỷ', 'Cancel')}</Btn>}
            </div>
          </div>
        );
      })}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { onPhoto(e.target.files?.[0]); e.target.value = ''; }} />

      {open && (
        <div className="bg-white rounded-xl p-3 space-y-3" style={{ border: `1px solid ${LINE}` }}>
          <div className="grid grid-cols-3 gap-2">
            {[[L('Ngày sản xuất', 'Production date'), dmy(ruleProd), L('giao − 2 ngày', 'delivery − 2 days')], [L('Ngày đóng gói', 'Packing date'), dmy(addDays(deliveryDate, -1)), L('giao − 1 ngày', 'delivery − 1 day')], [L('Hạn sử dụng', 'Best before'), dmy(addDays(deliveryDate, 120)), L('giao + 120 ngày', 'delivery + 120 days')]].map(([a, b, c]) => (
              <div key={a} className="rounded-lg px-2.5 py-2" style={{ backgroundColor: '#FAF6EF' }}>
                <div className="text-[10px]" style={{ color: FAINT }}>{a}</div><div className="text-sm font-bold">{b}</div><div className="text-[10px]" style={{ color: GOLD }}>{c}</div>
              </div>
            ))}
          </div>
          {preview.map(p => {
            const ds = prodDates(p.it.group_key);
            return (
              <div key={p.sku} className="rounded-lg px-3 py-2.5 space-y-2" style={{ border: `1px solid ${LINE}` }}>
                <div className="flex justify-between gap-2 text-sm"><span className="min-w-0"><b className="block truncate">{p.it.product_name}</b><span className="text-[11px]" style={{ color: FAINT }}>{p.sku}</span></span><b className="shrink-0">{fmt(p.kg, 1)} kg</b></div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: MUTED }}>
                  {L('Quy cách thùng', 'Carton')}
                  <input inputMode="numeric" value={p.c.per} onChange={e => setC(p.sku, p.it, 'per', e.target.value.replace(/[^0-9]/g, ''))} className="w-12 h-8 rounded-lg text-center text-sm font-bold" style={{ border: '1px solid #D9CDB8', color: '#111827' }} />
                  {L('túi ×', 'bags ×')}
                  <input inputMode="decimal" value={p.c.bag} onChange={e => setC(p.sku, p.it, 'bag', e.target.value.replace(/[^0-9.,]/g, ''))} className="w-14 h-8 rounded-lg text-center text-sm font-bold" style={{ border: '1px solid #D9CDB8', color: '#111827' }} />
                  kg = <b style={{ color: '#111827' }}>{fmt(p.full, 2)} kg / {L('thùng', 'carton')}</b>
                  <span className="ml-auto font-bold" style={{ color: GREEN }}>→ {p.n} {L('thùng', 'cartons')}{p.rest > 0.0005 && p.n > 1 ? <span className="font-normal" style={{ color: FAINT }}> ({L('1 thùng lẻ', '1 part carton')} {fmt(p.rest, 2)} kg)</span> : null}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: MUTED }}>
                  {L('Ngày sản xuất (lô)', 'Production date (lot)')}
                  <select value={p.c.date} onChange={e => setC(p.sku, p.it, 'date', e.target.value)} className="h-8 rounded-lg px-2 text-sm font-bold" style={{ border: '1px solid #D9CDB8', color: '#111827' }}>
                    {!ds.length && <option value="">{L('— chưa có mẻ nướng —', '— no baking logged —')}</option>}
                    {ds.map(d => <option key={d} value={d}>{dmy(d)}{d === ruleProd ? ' ✓' : ''}</option>)}
                  </select>
                </div>
                {p.old && <div className="text-xs font-semibold rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#FFF7E6', color: '#B45309' }}>⚠ {L(`Lô ${dmy(p.c.date)} cũ hơn quy tắc (${dmy(ruleProd)}). Cần xác nhận — tên của bạn sẽ được ghi lại.`, `Lot ${dmy(p.c.date)} is older than the rule (${dmy(ruleProd)}). Confirmation required — your name will be recorded.`)}</div>}
              </div>
            );
          })}
          {anyOld && (
            <input value={why} onChange={e => setWhy(e.target.value)} maxLength={300} placeholder={L('Lý do xác nhận ngày sản xuất cũ (bắt buộc)', 'Reason for the older production date (required)')} className="w-full h-9 rounded-lg px-3 text-sm" style={{ border: '1px solid #D9CDB8' }} />
          )}
          <input value={by} onChange={e => setBy(e.target.value)} maxLength={80} placeholder={L('Người chuẩn bị — nhập họ tên (bắt buộc)', 'Prepared by — enter your full name (required)')} className="w-full h-9 rounded-lg px-3 text-sm" style={{ border: '1px solid #D9CDB8' }} />
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs" style={{ color: MUTED }}>{L('Tổng', 'Total')}: <b style={{ color: '#111827' }}>{preview.reduce((s, p) => s + p.n, 0)} {L('thùng', 'cartons')} · {fmt(preview.reduce((s, p) => s + p.kg, 0), 1)} kg</b></span>
            <span className="flex gap-1.5">
              <Btn onClick={() => setOpen(false)}>{L('Đóng', 'Close')}</Btn>
              <Btn primary disabled={!valid || busy === 'create'} onClick={create}>{busy === 'create' ? <Loader2 size={13} className="animate-spin" /> : null}{L('Tạo số serial & phiếu', 'Create serials & note')}</Btn>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// phone photos are big: shrink to ~1600 px JPEG before upload
async function shrink(f: File): Promise<File> {
  try {
    const img = await createImageBitmap(f); const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const b: Blob | null = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return b ? new File([b], 'note.jpg', { type: 'image/jpeg' }) : f;
  } catch { return f; }
}
