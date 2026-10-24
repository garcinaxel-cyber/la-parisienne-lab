'use client';
// Tasks · Delivery gaps (Axel, 2026-10-24 — mockup tasks-tab-do-it-open). One screen, colour = what
// to do: red = do it now (each card has "Do it →", which opens the answer right under it), amber =
// waiting for someone else (nothing to do), green = done today (collapsed).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { reasonLabel } from '@/lib/delivery-check-reasons';
import GapResolver from '@/components/GapResolver';
import type { ProdTask, RecountTask, LeftoverTask, LeftoverDone } from '@/lib/delivery-tasks';
import { ChevronDown, ChevronRight, Camera } from 'lucide-react';

const RED = '#B42318', AMBER = '#B54708', GREEN = '#067647', NAVY = '#1A4731';

export type ReceptionTask = { key: string; product: string; shop: string; orderRef: string; deliveryDate: string; kind: string; qty: number; sent: number; received: number; deadlineAt: string | null };

export default function TasksPanel({ open, resolved, recounts, reception, offslipOpen, today, leftovers = [], leftoverDone = [],
  shopsNotConfirmed = [], damaged = { shops: 0, items: 0 }, receptionDoneToday = 0 }: {
  open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[]; leftovers?: LeftoverTask[]; leftoverDone?: LeftoverDone[];
  reception: ReceptionTask[]; offslipOpen: number; today: string;
  shopsNotConfirmed?: { shop: string; orders: number }[]; damaged?: { shops: number; items: number }; receptionDoneToday?: number;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [greenOpen, setGreenOpen] = useState<string | null>(null);
  const [loPick, setLoPick] = useState<Record<string, string>>({});
  const [loPhoto, setLoPhoto] = useState<Record<string, string>>({});

  const loErr = leftoverDone.filter(d => d.odooStatus === 'error');
  const prodRed = open.length + leftovers.length + loErr.length;
  const receptionOpen = reception.length + offslipOpen;
  const total = prodRed + receptionOpen;
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit' });
  const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const hLeft = (d: string | null) => d ? Math.round((new Date(d).getTime() - Date.now()) / 3600_000) : null;
  const isToday = (iso: string | null) => !!iso && new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) === today;
  const openGap = (key: string) => { try { window.dispatchEvent(new CustomEvent('lp-open-gap', { detail: key })); } catch {} };

  async function retry(t: ProdTask) {
    setBusy(t.id);
    const { followUpLineAction } = await import('../actions');
    const r = await followUpLineAction(t.id);
    setBusy(null);
    if (r.error || r.result?.odooStatus === 'error') setMsg(m => ({ ...m, [t.id]: r.error ?? r.result?.error ?? 'Odoo error' }));
    router.refresh();
  }
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
    setOpenKey(null);
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

  // One red task card, mockup style: small caps label, bold title, one grey line, "Do it →".
  const card = (key: string, label: string, title: string, line: string, onDo: () => void, body?: React.ReactNode, late?: string | null, doLabel?: string) => {
    const isOpen = openKey === key && !!body;
    return (
      <div key={key} className="rounded-xl bg-white shadow-sm" style={{ border: `1px solid ${isOpen ? RED : '#F3D0CC'}`, borderLeft: `4px solid ${RED}` }}>
        <div className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-stone-500">
              {late && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">{late}</span>}{label}
            </div>
            <div className="font-bold text-stone-900">{title}</div>
            <div className="truncate text-xs text-stone-500">{line}</div>
          </div>
          {isOpen
            ? <button onClick={() => setOpenKey(null)} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700">▾ {vi ? 'Đóng' : 'Close'}</button>
            : <button onClick={onDo} className="inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold text-white" style={{ backgroundColor: NAVY }}>{doLabel ?? (vi ? 'Xử lý' : 'Do it')} <ChevronRight size={14} /></button>}
        </div>
        {msg[key] && <div className="px-3 pb-2 text-xs" style={{ color: RED }}>{msg[key]}</div>}
        {isOpen && <div className="border-t border-stone-100 p-3">{body}</div>}
      </div>
    );
  };

  const doneProd = resolved.filter(t => isToday(t.resolvedAt));
  const doneLo = leftoverDone.filter(d => d.odooStatus !== 'error');
  const autoT = doneProd.filter(t => t.resolution === 'auto_transfer').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-2xl border p-4" style={{ borderColor: total ? '#FECDCA' : '#ABEFC6', backgroundColor: total ? '#FEF3F2' : '#ECFDF3' }}>
        <div className="text-5xl font-black leading-none" style={{ color: total ? RED : GREEN }}>{total}</div>
        <div>
          <div className="font-bold text-stone-800">{total ? (vi ? 'việc cần làm' : 'tasks to do') : (vi ? 'Không còn việc nào' : 'Nothing left to do')}</div>
          <div className="text-xs text-stone-500">{vi ? 'Đỏ = làm ngay · Vàng = chờ người khác · Xanh = đã xong' : 'Red = do it now · Amber = waiting for someone else · Green = done'}</div>
        </div>
      </div>

      {/* ① Production → delivery */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold" style={{ color: prodRed ? RED : GREEN }}>
          ① {vi ? 'Sản xuất → giao hàng' : 'Production → delivery'} <span className="font-normal text-stone-500">· {vi ? 'Lab giao ≠ Lab làm' : 'Lab made ≠ Lab delivered'}</span>
        </h2>
        {prodRed === 0 && <div className="text-sm text-stone-500">{vi ? 'Không có chênh lệch chưa xử lý.' : 'No unsettled difference.'}</div>}

        {open.map(t => {
          const short = t.checked < t.expected;
          const diff = Math.abs(t.checked - t.expected);
          const odooErr = t.odooStatus === 'error';
          const label = odooErr ? (vi ? 'KIỂM GIAO HÀNG · ODOO LỖI' : 'DELIVERY CHECK · ODOO ERROR')
            : short ? (vi ? 'KIỂM GIAO HÀNG · THIẾU' : 'DELIVERY CHECK · MISSING') : (vi ? 'KIỂM GIAO HÀNG · DƯ' : 'DELIVERY CHECK · MORE THAN ORDERED');
          const title = odooErr ? (vi ? 'Odoo chưa nhận — làm lại' : 'Odoo refused — do it again')
            : short ? (vi ? `${diff} cái thiếu — cái còn lại ở đâu?` : `Say where the missing ${diff > 1 ? 'items are' : 'item is'}`)
            : (vi ? `${diff} cái thêm — lấy từ đâu?` : `Say where the extra ${diff > 1 ? 'items come' : 'item comes'} from`);
          const line = `${t.orderRef} · ${t.shop ?? ''} · ${t.product} — ${t.expected} → ${t.checked}${t.reason ? ` · ${reasonLabel(t.reason, vi)}` : ''}${odooErr && t.odooError ? ` · ${t.odooError}` : ''}`;
          return card(t.id, label, title, line,
            () => odooErr ? retry(t) : setOpenKey(t.id),
            odooErr ? undefined : (
              <GapResolver lineId={t.id} expected={t.expected} qty={t.checked} vi={vi}
                onSaved={() => { setOpenKey(null); router.refresh(); }} onRecount={() => setOpenKey(null)} />
            ),
            t.deliveryDate < today ? fmt(t.deliveryDate) : null,
            odooErr ? (busy === t.id ? '…' : (vi ? 'Làm lại' : 'Retry')) : undefined);
        })}

        {leftovers.map(t => {
          const k = `${t.date}|${t.sku}`; const pickd = loPick[k];
          const opt = (code: string, viL: string, enL: string, sub: string) => (
            <label key={code} className="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: pickd === code ? NAVY : '#E5E7EB' }}>
              <input type="radio" name={k} checked={pickd === code} onChange={() => setLoPick(p => ({ ...p, [k]: code }))} className="mt-1" />
              <span><b>{vi ? viL : enL}</b><span className="block text-xs text-stone-500">{sub}</span></span>
            </label>
          );
          return card(k,
            vi ? 'LÀM DƯ · KHÔNG CÓ ĐƠN' : 'MADE · NO ORDER TO DELIVER',
            vi ? `Quyết định ${t.leftover} cái làm dư` : `Decide what to do with ${t.leftover > 1 ? `these ${t.leftover} items` : 'this item'}`,
            vi ? `${t.product} — bếp làm ${t.made}, đã giao ${t.delivered}${t.lost ? `, báo hỏng ${t.lost}` : ''}`
               : `${t.product} — made ${t.made}, delivered ${t.delivered}${t.lost ? `, reported broken ${t.lost}` : ''}`,
            () => setOpenKey(k),
            <div className="space-y-2">
              <div className="grid gap-1.5">
                {opt('to_stock', 'Còn ở Lab — cho vào kho', 'Still at the Lab — keep in Lab stock', vi ? 'App tự chuyển kho nếu chưa chuyển' : 'The app sends it to stock if not done')}
                {opt('lost', 'Bị hỏng / bỏ đi', 'Broken / thrown away', vi ? 'Chụp 1 ảnh — ghi vào hao hụt Lab' : 'Take 1 photo — goes to Lab scrap')}
                {opt('not_made', 'Bếp báo sai — thực tế không làm', 'Kitchen over-declared — never made', vi ? 'App tự sửa số bếp đã làm và Odoo' : 'The app corrects the kitchen count and Odoo')}
              </div>
              {pickd === 'lost' && (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: loPhoto[k] ? GREEN : RED, color: loPhoto[k] ? GREEN : RED }}>
                  <Camera size={14} />{loPhoto[k] ? (vi ? 'Đã có ảnh' : 'Photo added') : (vi ? 'Chụp 1 ảnh (bắt buộc)' : 'Take 1 photo (required)')}
                  <input type="file" accept="image/*" capture="environment" hidden onChange={e => uploadPhoto(k, e.target.files?.[0])} />
                </label>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={() => setOpenKey(null)} className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700">{vi ? 'Huỷ' : 'Cancel'}</button>
                <button onClick={() => resolveLeftover(t)} disabled={!pickd || busy === k || (pickd === 'lost' && !loPhoto[k])}
                  className="rounded-lg px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>{busy === k ? '…' : (vi ? 'Xác nhận' : 'Confirm')}</button>
              </div>
            </div>,
            t.date < today ? fmt(t.date) : null);
        })}

        {loErr.map(d => card(`e${d.date}${d.sku}`, vi ? 'LÀM DƯ · ODOO LỖI' : 'MADE · NO ORDER · ODOO ERROR',
          vi ? 'Odoo chưa nhận — báo quản lý Lab' : 'Odoo refused — tell the Lab manager',
          `${d.product} · ${fmt(d.date)} · +${d.qty} · ${d.odooError ?? ''}`, () => {}, undefined, null, '—'))}
      </section>

      {/* ② Delivery → shop */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold" style={{ color: receptionOpen ? RED : GREEN }}>
          ② {vi ? 'Giao hàng → cửa hàng' : 'Delivery → shop'} <span className="font-normal text-stone-500">· {vi ? 'Lab giao ≠ cửa hàng nhận' : 'Lab delivered ≠ shop received'}</span>
        </h2>
        {receptionOpen === 0 && <div className="text-sm text-stone-500">{vi ? 'Cửa hàng nhận đúng số.' : 'Shops received the right quantities.'}</div>}
        {reception.map(g => {
          const h = hLeft(g.deadlineAt);
          return card(g.key,
            `${vi ? 'LỆCH NHẬN HÀNG' : 'SHOP RECEIPT GAP'}${h != null ? ` · ${h > 0 ? (vi ? `CÒN ${h}H` : `${h}H LEFT`) : (vi ? 'QUÁ HẠN' : 'LATE')}` : ''}`,
            vi ? 'Xử lý lệch nhận hàng của cửa hàng' : 'Settle a shop receipt gap',
            `${g.orderRef} · ${g.shop} · ${g.qty} ${g.product} ${g.kind === 'extra' ? (vi ? 'dư khi nhận' : 'extra at reception') : (vi ? 'thiếu khi nhận' : 'missing at reception')}`,
            () => openGap(g.key), undefined, g.deliveryDate < today ? fmt(g.deliveryDate) : null);
        })}
        {offslipOpen > 0 && card('offslip', vi ? 'NGOÀI PHIẾU' : 'OFF-SLIP',
          vi ? 'Chọn lý do sản phẩm không có trên phiếu' : 'Choose why an item was off the slip',
          vi ? `${offslipOpen} sản phẩm cửa hàng nhận nhưng không có trên phiếu` : `${offslipOpen} item(s) received but not on the slip`,
          () => openGap('offslip'))}
      </section>

      {/* Waiting for someone else */}
      {(shopsNotConfirmed.length > 0 || damaged.items > 0 || recounts.length > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold" style={{ color: AMBER }}>● {vi ? 'Đang chờ người khác — không cần làm gì' : 'Waiting for someone else — nothing to do'}</h2>
          {shopsNotConfirmed.length > 0 && (
            <div className="rounded-xl bg-white p-3 shadow-sm" style={{ borderLeft: `4px solid ${AMBER}` }}>
              <div className="font-bold text-stone-900">{vi ? 'Chờ cửa hàng xác nhận nhận hàng' : 'Waiting for shops to confirm receipt'}</div>
              <div className="text-xs text-stone-500">{shopsNotConfirmed.map(s => `${s.shop} ${s.orders} ${vi ? 'đơn' : (s.orders > 1 ? 'orders' : 'order')}`).join(' · ')}</div>
            </div>
          )}
          {damaged.items > 0 && (
            <div className="rounded-xl bg-white p-3 shadow-sm" style={{ borderLeft: `4px solid ${AMBER}` }}>
              <div className="font-bold text-stone-900">{vi ? 'Hàng hỏng chưa mang về Lab' : 'Damaged items not back at the Lab yet'}</div>
              <div className="text-xs text-stone-500">{damaged.shops} {vi ? 'cửa hàng' : (damaged.shops > 1 ? 'shops' : 'shop')} · {damaged.items} {vi ? 'dòng' : (damaged.items > 1 ? 'items' : 'item')} · {vi ? '7 ngày gần nhất' : 'last 7 days'}</div>
            </div>
          )}
          {recounts.map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm" style={{ borderLeft: `4px solid ${AMBER}` }}>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-stone-900">{vi ? 'Cần đếm lại kho' : 'Stock recount requested'}</div>
                <div className="text-xs text-stone-500">{r.product} — {vi ? `báo hết hàng khi kiểm giao hàng ${hm(r.raisedAt)}` : `out of stock reported at delivery check ${hm(r.raisedAt)}`}{r.orderRef ? ` · ${r.orderRef}` : ''}</div>
                {msg[r.id] && <div className="text-xs" style={{ color: RED }}>{msg[r.id]}</div>}
              </div>
              <button onClick={() => recountDone(r)} disabled={busy === r.id} className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50" style={{ borderColor: AMBER, color: AMBER }}>
                {vi ? 'Đã đếm lại' : 'Recounted'}
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Done today */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold" style={{ color: GREEN }}>● {vi ? 'Đã xong hôm nay' : 'Done today'}</h2>
        {([
          ['p', `① ${vi ? 'Sản xuất → giao hàng' : 'Production → delivery'} · ${doneProd.length + doneLo.length} ${vi ? 'xong' : 'done'}`,
            autoT ? (vi ? `gồm ${autoT} lần tự chuyển kho` : `incl. ${autoT} forgotten transfer${autoT > 1 ? 's' : ''} added automatically`) : '',
            [...doneProd.map(t => `${t.orderRef} · ${t.product} · ${t.expected}→${t.checked} · ${t.resolution === 'auto_transfer' ? (vi ? 'tự chuyển kho' : 'auto transfer') : reasonLabel(t.resolution, vi)}${t.ref ? ` · ${t.ref}` : ''}`),
             ...doneLo.map(d => `${fmt(d.date)} · ${d.product} · +${d.qty} · ${d.resolution}${d.ref ? ` · ${d.ref}` : ''}`)]],
          ['r', `② ${vi ? 'Giao hàng → cửa hàng' : 'Delivery → shop'} · ${receptionDoneToday} ${vi ? 'xong' : 'done'}`, '', []],
        ] as [string, string, string, string[]][]).map(([k, label, extra, items]) => (
          <div key={k} className="rounded-xl bg-white shadow-sm" style={{ borderLeft: `4px solid ${GREEN}` }}>
            <button onClick={() => k === 'r' ? openGap('closed') : setGreenOpen(g => g === k ? null : k)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
              <span className="font-bold" style={{ color: GREEN }}>✓ {label}</span>
              <span className="ml-auto text-xs text-stone-500">{extra}</span>
              {greenOpen === k ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {greenOpen === k && items.map((x, i) => <div key={i} className="px-8 pb-1 text-xs text-stone-600">{x}</div>)}
          </div>
        ))}
      </section>
    </div>
  );
}
