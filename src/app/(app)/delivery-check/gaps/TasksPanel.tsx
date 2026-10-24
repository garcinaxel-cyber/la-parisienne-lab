'use client';
// Tasks · Delivery gaps (Axel, 2026-10-24): one screen, colour = what to do.
// Red = to do now · Amber = waiting for someone else · Green = done (collapsed per family).
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { reasonLabel } from '@/lib/delivery-check-reasons';
import type { ProdTask, RecountTask, LeftoverTask, LeftoverDone } from '@/lib/delivery-tasks';
import { RotateCcw, ChevronDown, ChevronRight, ExternalLink, Camera } from 'lucide-react';

const RED = '#B42318', AMBER = '#B54708', GREEN = '#067647';

export type ReceptionTask = { key: string; product: string; shop: string; orderRef: string; deliveryDate: string; kind: string; qty: number; sent: number; received: number; deadlineAt: string | null };

export default function TasksPanel({ open, resolved, recounts, reception, offslipOpen, waitingShop, damagedNotBack, today, leftovers = [], leftoverDone = [] }: {
  open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[]; leftovers?: LeftoverTask[]; leftoverDone?: LeftoverDone[];
  reception: ReceptionTask[]; offslipOpen: number; waitingShop: number; damagedNotBack: number; today: string;
}) {
  const receptionOpen = reception.length + offslipOpen;
  const openGap = (key: string) => { try { window.dispatchEvent(new CustomEvent('lp-open-gap', { detail: key })); } catch {} };
  const hLeft = (d: string | null) => d ? Math.round((new Date(d).getTime() - Date.now()) / 3600_000) : null;
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [greenOpen, setGreenOpen] = useState<string | null>(null);
  const loErr = leftoverDone.filter(d => d.odooStatus === 'error');
  const prodRed = open.length + leftovers.length + loErr.length;
  const total = prodRed + receptionOpen;
  const [loPick, setLoPick] = useState<Record<string, string>>({});
  const [loPhoto, setLoPhoto] = useState<Record<string, string>>({});
  async function uploadPhoto(k: string, f: File | undefined) {
    if (!f) return;
    setBusy(k);
    const fd = new FormData(); fd.append('file', f);
    const { uploadLossPhotoAction } = await import('../actions');
    const r = await uploadLossPhotoAction(fd);
    setBusy(null);
    if (r.url) setLoPhoto(p => ({ ...p, [k]: r.url! })); else setMsg(m => ({ ...m, [k]: r.error ?? 'Upload error' }));
  }
  async function resolveLeftover(t: LeftoverTask) {
    const k = `${t.date}|${t.sku}`; const choice = loPick[k] as any;
    if (!choice) return;
    setBusy(k);
    const { resolveMadeWithoutOrderAction } = await import('./actions');
    const r = await resolveMadeWithoutOrderAction({ date: t.date, sku: t.sku, qty: t.leftover, product: t.product, choice, photoUrl: loPhoto[k] ?? null });
    setBusy(null);
    if (r.error) setMsg(m => ({ ...m, [k]: r.error! }));
    router.refresh();
  }
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit' });

  async function retry(t: ProdTask) {
    setBusy(t.id);
    const { followUpLineAction } = await import('../actions');
    const r = await followUpLineAction(t.id);
    setBusy(null);
    if (r.error || r.result?.odooStatus === 'error') setMsg(m => ({ ...m, [t.id]: r.error ?? r.result?.error ?? 'Odoo error' }));
    router.refresh();
  }
  async function recountDone(r: RecountTask) {
    setBusy(r.id);
    const { closeRecountAlertAction } = await import('./actions');
    const res = await closeRecountAlertAction(r.id, null);
    setBusy(null);
    if (res.error) setMsg(m => ({ ...m, [r.id]: res.error! }));
    router.refresh();
  }

  const families = Object.entries(resolved.reduce<Record<string, ProdTask[]>>((acc, t) => { (acc[t.family] ??= []).push(t); return acc; }, {}));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-2xl border p-4" style={{ borderColor: total ? '#FECDCA' : '#ABEFC6', backgroundColor: total ? '#FEF3F2' : '#ECFDF3' }}>
        <div className="text-5xl font-black leading-none" style={{ color: total ? RED : GREEN }}>{total}</div>
        <div>
          <div className="font-bold text-stone-800">{total ? (vi ? 'việc cần làm' : 'tasks to do') : (vi ? 'Không còn việc nào 🎉' : 'Nothing left to do')}</div>
          <div className="text-xs text-stone-500">{vi ? 'Đỏ = làm ngay · Vàng = chờ người khác · Xanh = đã xong' : 'Red = do it now · Amber = waiting for someone else · Green = done'}</div>
        </div>
      </div>

      {/* ① Production → delivery */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: prodRed ? RED : GREEN }}>
          ① {vi ? 'Sản xuất → giao hàng' : 'Production → delivery'} · {prodRed}
        </h2>
        {leftovers.map(t => {
          const k = `${t.date}|${t.sku}`; const pickd = loPick[k];
          const opt = (code: string, viL: string, enL: string, sub: string) => (
            <label key={code} className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: pickd === code ? '#1A4731' : '#E5E7EB' }}>
              <input type="radio" name={k} checked={pickd === code} onChange={() => setLoPick(p => ({ ...p, [k]: code }))} className="mt-1" />
              <span><b>{vi ? viL : enL}</b><span className="block text-xs text-stone-500">{sub}</span></span>
            </label>
          );
          return (
            <div key={k} className="rounded-xl border-l-4 bg-white p-3 shadow-sm space-y-2" style={{ borderLeftColor: RED }}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {t.date < today && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{fmt(t.date)}</span>}
                <span className="font-semibold text-stone-800">{t.product}</span>
                <span className="ml-auto font-mono text-sm" style={{ color: RED }}>+{t.leftover}</span>
              </div>
              <div className="text-xs text-stone-600">
                {vi ? `Bếp làm ${t.made} · đã giao ${t.delivered}${t.lost ? ` · báo hỏng ${t.lost}` : ''} → ${t.leftover} cái không có đơn. Ở đâu?`
                    : `Made ${t.made} · delivered ${t.delivered}${t.lost ? ` · reported broken ${t.lost}` : ''} → ${t.leftover} made without order. Where are they?`}
              </div>
              <div className="grid gap-1.5">
                {opt('to_stock', 'Còn ở Lab — cho vào kho', 'Still at the Lab — put in stock', vi ? 'App tự chuyển kho nếu chưa chuyển' : 'The app sends them to stock if not done')}
                {opt('lost', 'Bị hỏng / bỏ đi', 'Broken / thrown away', vi ? 'Chụp 1 ảnh — ghi vào hao hụt Lab' : 'Take 1 photo — goes to Lab scrap')}
                {opt('not_made', 'Bếp báo sai — thực tế không làm', 'Kitchen over-declared — never made', vi ? 'App tự sửa số bếp đã làm và Odoo' : 'The app corrects the kitchen count and Odoo')}
              </div>
              {pickd === 'lost' && (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: loPhoto[k] ? GREEN : RED, color: loPhoto[k] ? GREEN : RED }}>
                  <Camera size={14} />{loPhoto[k] ? (vi ? 'Đã có ảnh' : 'Photo added') : (vi ? 'Chụp 1 ảnh (bắt buộc)' : 'Take 1 photo (required)')}
                  <input type="file" accept="image/*" capture="environment" hidden onChange={e => uploadPhoto(k, e.target.files?.[0])} />
                </label>
              )}
              {msg[k] && <div className="text-xs" style={{ color: RED }}>{msg[k]}</div>}
              <button onClick={() => resolveLeftover(t)} disabled={!pickd || busy === k || (pickd === 'lost' && !loPhoto[k])}
                className="rounded-lg px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                {busy === k ? '…' : (vi ? 'Xác nhận' : 'Confirm')}
              </button>
            </div>
          );
        })}
        {loErr.map(d => (
          <div key={`e${d.date}${d.sku}`} className="rounded-xl border-l-4 bg-white p-3 text-sm shadow-sm" style={{ borderLeftColor: RED }}>
            <b>{d.product}</b> · {fmt(d.date)} · +{d.qty} · {d.resolution}
            <div className="text-xs" style={{ color: RED }}>Odoo: {d.odooError} — {vi ? 'báo quản lý Lab' : 'tell the Lab manager'}</div>
          </div>
        ))}
        {prodRed === 0 && <div className="text-sm text-stone-500">{vi ? 'Không có chênh lệch chưa xử lý.' : 'No unsettled difference.'}</div>}
        {open.map(t => (
          <div key={t.id} className="rounded-xl border-l-4 bg-white p-3 shadow-sm" style={{ borderLeftColor: RED }}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {t.deliveryDate < today && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{fmt(t.deliveryDate)}</span>}
              <span className="font-semibold text-stone-800">{t.product}</span>
              <span className="text-stone-500">{t.shop ?? ''} · {t.orderRef}</span>
              <span className="ml-auto font-mono text-sm"><b>{t.expected}</b> → <b style={{ color: RED }}>{t.checked}</b></span>
            </div>
            <div className="mt-1 text-xs text-stone-600">
              {t.reason ? reasonLabel(t.reason, vi) : (vi ? 'Chưa chọn lý do' : 'No reason chosen')}
              {t.note ? ` · “${t.note}”` : ''}
            </div>
            {(t.odooError || msg[t.id]) && <div className="mt-1 text-xs" style={{ color: RED }}>Odoo: {msg[t.id] ?? t.odooError}</div>}
            <div className="mt-2 flex flex-wrap gap-2">
              {t.reason && (
                <button onClick={() => retry(t)} disabled={busy === t.id} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: RED }}>
                  <RotateCcw size={13} className={busy === t.id ? 'animate-spin' : ''} />{vi ? 'Làm lại' : 'Do it again'}
                </button>
              )}
              <Link href={`/delivery-check/${t.deliveryDate}/${encodeURIComponent(t.orderRef)}`} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold text-stone-700">
                <ExternalLink size={13} />{vi ? 'Mở đơn' : 'Open order'}
              </Link>
            </div>
          </div>
        ))}
      </section>

      {/* Waiting for someone else */}
      {(recounts.length > 0 || waitingShop > 0 || damagedNotBack > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: AMBER }}>{vi ? 'Đang chờ người khác' : 'Waiting for someone else'}</h2>
          {waitingShop > 0 && <div className="rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>{waitingShop} {vi ? 'chênh lệch chờ cửa hàng trả lời (xem ② › Chờ shop)' : 'gaps waiting for the shop (see ② › Waiting shop)'}</div>}
          {damagedNotBack > 0 && <div className="rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>{damagedNotBack} {vi ? 'bánh hỏng chưa mang về Lab' : 'damaged items not back at the Lab yet'}</div>}
          {recounts.map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>
              <span>{vi ? 'Đếm lại kho' : 'Recount stock'}: <b>{r.product}</b> ({vi ? 'thiếu' : 'missing'} {r.missing}{r.orderRef ? ` · ${r.orderRef}` : ''})</span>
              {msg[r.id] && <span className="text-xs" style={{ color: RED }}>{msg[r.id]}</span>}
              <button onClick={() => recountDone(r)} disabled={busy === r.id} className="ml-auto rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: AMBER }}>
                {vi ? 'Đã đếm lại' : 'Recounted'}
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Done, collapsed per family */}
      {(families.length > 0 || leftoverDone.length > 0) && (
        <section className="space-y-1">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: GREEN }}>{vi ? 'Đã xử lý' : 'Done'} · {resolved.length + leftoverDone.length - loErr.length}</h2>
          {leftoverDone.filter(d => d.odooStatus !== 'error').length > 0 && (
            <div className="rounded-xl bg-emerald-50/60">
              <button onClick={() => setGreenOpen(g => g === '__lo' ? null : '__lo')} className="flex w-full items-center gap-2 px-3 py-2 text-sm" style={{ color: GREEN }}>
                {greenOpen === '__lo' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<b>{vi ? 'Làm dư không có đơn' : 'Made without order'}</b> · {leftoverDone.filter(d => d.odooStatus !== 'error').length}
              </button>
              {greenOpen === '__lo' && leftoverDone.filter(d => d.odooStatus !== 'error').map(d => (
                <div key={d.date + d.sku} className="px-8 pb-1 text-xs text-stone-600">{fmt(d.date)} · {d.product} · +{d.qty} · {d.resolution}{d.ref ? ` · ${d.ref}` : ''}</div>
              ))}
            </div>
          )}
          {families.map(([fam, list]) => (
            <div key={fam} className="rounded-xl bg-emerald-50/60">
              <button onClick={() => setGreenOpen(g => g === fam ? null : fam)} className="flex w-full items-center gap-2 px-3 py-2 text-sm" style={{ color: GREEN }}>
                {greenOpen === fam ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<b>{fam}</b> · {list.length}
              </button>
              {greenOpen === fam && list.map(t => (
                <div key={t.id} className="px-8 pb-1 text-xs text-stone-600">
                  {fmt(t.deliveryDate)} · {t.product} · {t.orderRef} · {t.expected}→{t.checked} · {reasonLabel(t.resolution === 'auto_transfer' ? null : t.resolution, vi) || (vi ? 'Tự chuyển kho' : 'Auto transfer')}{t.ref ? ` · ${t.ref}` : ''}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      {/* ② Delivery → shop: one red line per gap, "Do it" opens the decision screen below. */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: receptionOpen ? RED : GREEN }}>
          ② {vi ? 'Giao hàng → cửa hàng' : 'Delivery → shop'} · {receptionOpen}
        </h2>
        {receptionOpen === 0 && <div className="text-sm text-stone-500">{vi ? 'Cửa hàng nhận đúng số.' : 'Shops received the right quantities.'}</div>}
        {reception.map(g => {
          const h = hLeft(g.deadlineAt);
          return (
            <div key={g.key} className="rounded-xl border-l-4 bg-white p-3 shadow-sm" style={{ borderLeftColor: RED }}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {g.deliveryDate < today && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{fmt(g.deliveryDate)}</span>}
                <span className="font-semibold text-stone-800">{g.product}</span>
                <span className="text-stone-500">{g.shop} · {g.orderRef}</span>
                <span className="ml-auto font-mono text-sm">{vi ? 'gửi' : 'sent'} <b>{g.sent}</b> · {vi ? 'nhận' : 'recv.'} <b style={{ color: RED }}>{g.received}</b></span>
              </div>
              <div className="mt-1 text-xs text-stone-600">
                {g.kind === 'extra' ? (vi ? `Cửa hàng nhận dư ${g.qty}` : `Shop received ${g.qty} extra`) : (vi ? `Cửa hàng thiếu ${g.qty}` : `Shop is missing ${g.qty}`)}
                {h != null && <span style={{ color: h < 12 ? RED : undefined }}> · {h > 0 ? (vi ? `còn ${h}h` : `${h}h left`) : (vi ? 'quá hạn' : 'late')}</span>}
              </div>
              <button onClick={() => openGap(g.key)} className="mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: RED }}>
                {vi ? 'Xử lý' : 'Do it'}
              </button>
            </div>
          );
        })}
        {offslipOpen > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border-l-4 bg-white p-3 text-sm shadow-sm" style={{ borderLeftColor: RED }}>
            <span><b>{offslipOpen}</b> {vi ? 'sản phẩm cửa hàng nhận ngoài phiếu' : 'products received that were on no slip'}</span>
            <button onClick={() => openGap('offslip')} className="ml-auto rounded-lg px-3 py-1.5 text-xs font-semibold text-white" style={{ backgroundColor: RED }}>{vi ? 'Xử lý' : 'Do it'}</button>
          </div>
        )}
      </section>
    </div>
  );
}
