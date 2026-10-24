'use client';
// Delivery gaps — Lab side (preview 2026-10-13). Layout follows the validated mockup
// (Lab 1 / Lab 2): list on the left (closest to its 48h deadline first), decision on the right.
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, AlertTriangle, Loader2, FlaskConical } from 'lucide-react';
import type { DeliveryGap, LabCause } from '@/lib/reception-gaps';
import type { ReceptionPlan, PlannedStep, InValidationResult } from '@/lib/reception-odoo';

type Tab = 'decide' | 'shop' | 'return' | 'send' | 'closed';

// Sales orders (Moon Flower): no shop IN — effects are a return / extra delivery + draft invoice change.
const SO_EFFECT: Partial<Record<LabCause, { vi: string; fr: string }>> = {
  found_at_lab: { vi: '→ trả về kho Lab, giảm hoá đơn', fr: '→ back to Lab stock, invoice −' },
  damaged_returned: { vi: '→ trả về + hao hụt Lab, giảm hoá đơn', fr: '→ return + Lab loss, invoice −' },
  lost_transport: { vi: '→ trả về + hao hụt Lab, giảm hoá đơn', fr: '→ return + Lab loss, invoice −' },
  lab_sent_extra: { vi: '→ thêm vào giao hàng + hoá đơn', fr: '→ added to delivery + invoice' },
};

const CAUSES: Record<'missing' | 'extra' | 'damaged', { key: LabCause; vi: string; fr: string; effVi: string; effFr: string }[]> = {
  missing: [
    { key: 'found_at_lab', vi: 'Còn ở Lab, chưa gửi đi', fr: 'Found at the Lab, never left', effVi: '→ về lại kho Lab', effFr: '→ back to Lab stock' },
    { key: 'damaged_returned', vi: 'Hỏng, mang về Lab', fr: 'Damaged, brought back to the Lab', effVi: '→ hao hụt Lab', effFr: '→ Lab loss' },
    { key: 'lost_transport', vi: 'Mất khi vận chuyển', fr: 'Lost in transport', effVi: '→ hao hụt vận chuyển', effFr: '→ transport loss' },
    { key: 'shop_miscount', vi: 'Shop đếm sai', fr: 'The shop miscounted', effVi: '→ shop đếm lại', effFr: '→ the shop recounts' },
  ],
  extra: [
    { key: 'lab_sent_extra', vi: 'Lab gửi thừa', fr: 'The Lab sent too many', effVi: '→ kho Lab → kho shop', effFr: '→ Lab stock → shop stock' },
    { key: 'shop_miscount', vi: 'Shop đếm sai', fr: 'The shop miscounted', effVi: '→ shop đếm lại', effFr: '→ the shop recounts' },
  ],
  // Settled automatically from the shop's photo; the assistant only changes it to contest.
  damaged: [
    { key: 'damaged_returned', vi: 'Hỏng thật (ảnh)', fr: 'Really damaged (photo)', effVi: '→ trả về + hao hụt Lab', effFr: '→ return + Lab loss' },
    { key: 'shop_miscount', vi: 'Ảnh không cho thấy hỏng', fr: 'The photo shows no damage', effVi: '→ shop đếm lại', effFr: '→ the shop recounts' },
  ],
};

function hoursLeft(deadlineAt: string | null): number | null {
  if (!deadlineAt) return null;
  return Math.round((new Date(deadlineAt).getTime() - Date.now()) / 3600_000);
}

function stepText(s: PlannedStep, vi: boolean): string {
  switch (s.op) {
    case 'set_move_qty': return `${s.pickingName} · ${s.sku || s.product}: ${s.demand} → ${s.qty}`;
    case 'validate_no_backorder': return vi ? `Xác nhận ${s.pickingName} (không tạo backorder)` : `Validate ${s.pickingName} (no backorder)`;
    case 'move': return `${s.sku || s.product} ×${s.qty}: ${s.from} → ${s.to}`;
    case 'scrap': return `Scrap ${s.sku || s.product} ×${s.qty} @ ${s.location} (${s.reason})`;
    case 'note': return s.text;
  }
}

function PlanBox({ plan, vi }: { plan: ReceptionPlan; vi: boolean }) {
  return (
    <div className="rounded-xl p-3 text-xs space-y-1" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE', color: '#4C1D95' }}>
      <div className="font-bold flex items-center gap-1.5"><FlaskConical size={13} />
        {plan.mode === 'simulated' ? (vi ? 'Odoo: mô phỏng — không ghi gì' : 'Odoo: simulation — nothing is written') : 'Odoo: live'}
      </div>
      {plan.error && <div style={{ color: '#B42318' }}>{plan.error}</div>}
      {plan.steps.map((s, i) => <div key={i} className="font-mono">{stepText(s, vi)}</div>)}
    </div>
  );
}

const SKIP_LABEL: Record<string, { vi: string; fr: string }> = {
  lab_out_not_validated: { vi: 'Phiếu xuất Lab chưa xác nhận trên Odoo — xác nhận giao hàng trước.', fr: 'The Lab OUT is not validated in Odoo — validate the delivery first.' },
  no_shop_in: { vi: 'Không tìm thấy phiếu nhập shop trên Odoo.', fr: 'No shop receipt found in Odoo.' },
  several_shop_in: { vi: 'Có nhiều phiếu nhập shop — làm tay trên Odoo.', fr: 'Several shop receipts — do it by hand in Odoo.' },
  odoo_not_configured: { vi: 'Odoo chưa cấu hình.', fr: 'Odoo not configured.' },
};
function skipText(code: string, vi: boolean): string {
  const base = code.split(':')[0];
  const sku = code.includes(':') ? code.split(':').slice(1).join(':') : '';
  if (SKIP_LABEL[base]) return vi ? SKIP_LABEL[base].vi : SKIP_LABEL[base].fr;
  if (base === 'unmatched_product') return vi ? `Sản phẩm ${sku} có trên Odoo nhưng không có trong app — làm tay.` : `Product ${sku} in Odoo but not in the app — do it by hand.`;
  if (base === 'missing_move') return vi ? `Sản phẩm ${sku} không có trên phiếu nhập — làm tay.` : `Product ${sku} missing from the Odoo receipt — do it by hand.`;
  if (base === 'ambiguous_split') return vi ? `${sku} có nhiều dòng trên Odoo — làm tay.` : `${sku} has several lines in Odoo — do it by hand.`;
  return code;
}

function InBox({ data, vi, busy, onValidate, canSend }: { data: { result: InValidationResult; complete: boolean; done?: boolean }; vi: boolean; busy: boolean; onValidate: () => void; canSend: boolean }) {
  const r = data.result;
  return (
    <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB' }}>
      <div className="font-bold text-sm">{vi ? 'Nhập kho shop' : 'Shop receipt'} {r.pickingName ?? ''}</div>
      {r.alreadyDone ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{vi ? '✓ Đã xác nhận trên Odoo.' : '✓ Already validated in Odoo.'}</div>
      ) : data.done && r.ok ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{r.live ? (vi ? '✓ Đã xác nhận trên Odoo.' : '✓ Validated in Odoo.') : (vi ? 'Bản thử: không ghi Odoo.' : 'Preview: nothing written to Odoo.')}</div>
      ) : r.skipped || r.error ? (
        <div className="font-semibold" style={{ color: '#B42318' }}>{r.skipped ? skipText(r.skipped, vi) : r.error}</div>
      ) : null}
      {r.plan.length > 0 && !r.alreadyDone && (
        <div className="font-mono space-y-0.5">
          {r.plan.map(p => <div key={p.moveId}>{p.sku}: {p.expectedQty} → {p.deliverQty}</div>)}
        </div>
      )}
      {!r.alreadyDone && !data.done && !r.skipped && !r.error && (
        data.complete && !canSend ? (
          <div className="font-semibold" style={{ color: '#6B7280' }}>{vi ? 'Chỉ Lab manager / admin xác nhận trên Odoo.' : 'Only the Lab manager / an admin validates in Odoo.'}</div>
        ) : data.complete ? (
          <button onClick={onValidate} disabled={busy}
            className="mt-1 text-sm font-bold rounded-lg px-4 py-2 text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
            {vi ? 'Xác nhận nhập kho trên Odoo' : 'Validate the receipt in Odoo'}
          </button>
        ) : (
          <div style={{ color: '#6B7280' }}>{vi ? 'Shop chưa xác nhận hết các dòng.' : 'The shop has not confirmed every line yet.'}</div>
        )
      )}
      <div style={{ color: '#6B7280' }}>{vi ? 'Số nhập = hàng tốt (nhận − hỏng), tối đa số Bếp gửi. Hàng thiếu/hỏng ở lại transit chờ xử lý.' : 'Quantity = good ones (received − damaged), at most what was sent. Missing/damaged stay in transit.'}</div>
    </div>
  );
}

const ACTION_LABEL: Record<string, { vi: string; fr: string }> = {
  return: { vi: 'trả về Lab', fr: 'return to Lab' },
  return_scrap: { vi: 'trả về + hao hụt Lab', fr: 'return + Lab loss' },
  extra: { vi: 'giao thêm', fr: 'extra delivery' },
  transit_to_lab: { vi: 'trả về Lab (return)', fr: 'return to the Lab' },
  transit_to_lab_scrap: { vi: 'trả về Lab + hao hụt Lab', fr: 'return + Lab loss' },
  scrap_transit: { vi: 'trả về Lab + hao hụt vận chuyển', fr: 'return + transport loss' },
  lab_to_shop: { vi: 'kho Lab → kho shop', fr: 'Lab stock → shop stock' },
};
function SendBox({ deliveryOrderId, vi, onDone, canSend }: { deliveryOrderId: string; vi: boolean; onDone: () => void; canSend: boolean }) {
  const [st, setSt] = useState<import('@/lib/reception-gaps').OrderSendState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  async function load() {
    const { getOrderSendStateAction } = await import('./actions');
    const r = await getOrderSendStateAction(deliveryOrderId);
    if (r.state) setSt(r.state);
  }
  useEffect(() => { load(); }, [deliveryOrderId]);
  async function send() {
    setBusy(true); setMsg(null); setConfirming(false);
    const { sendOrderToOdooAction } = await import('./actions');
    const r = await sendOrderToOdooAction(deliveryOrderId);
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    const res = r.result!;
    setMsg({ ok: res.ok, text: res.ok ? `${res.live ? '' : (vi ? '[Bản thử] ' : '[Preview] ')}${res.done.join(' · ')}` : `${res.error}${res.done.length ? ' — ' + res.done.join(' · ') : ''}` });
    await load(); onDone();
  }
  if (!st) return <div className="text-xs text-gray-400">…</div>;
  return (
    <div className="w-full rounded-xl p-3 space-y-2 text-xs" style={{ backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB' }}>
      <div className="font-bold text-sm">{vi ? `${st.sourceType === 'sales_order' ? 'Đơn bán' : 'Đơn'} ${st.orderRef} — xác nhận cuối trên Odoo` : `${st.sourceType === 'sales_order' ? 'Sale' : 'Order'} ${st.orderRef} — final Odoo validation`}</div>
      <div className="space-y-1">
        {st.lines.map(l => (
          <div key={l.key} className="flex justify-between gap-2">
            <span className="truncate">{l.product} · {l.kind === 'extra' ? '+' : '−'}{l.qty}{l.kind === 'damaged' ? (vi ? ' hỏng' : ' damaged') : ''}{l.photoUrls.length ? ' 📷' : ''}</span>
            <span className="shrink-0 font-semibold" style={{ color: l.sent ? '#15803D' : l.status === 'closed' ? '#1A4731' : '#B45309' }}>
              {l.sent ? (vi ? '✓ đã gửi' : '✓ sent') : l.status !== 'closed' ? (vi ? 'chưa xử lý xong' : 'not settled yet') : l.action ? (vi ? ACTION_LABEL[l.action].vi : ACTION_LABEL[l.action].fr) : (vi ? 'không cần Odoo' : 'nothing in Odoo')}
            </span>
          </div>
        ))}
      </div>
      {msg && <div className="font-semibold" style={{ color: msg.ok ? '#15803D' : '#B42318' }}>{msg.text}</div>}
      {st.odooRefs.length > 0 && (
        <div className="rounded-lg px-2.5 py-2 space-y-0.5" style={{ backgroundColor: '#EAF2ED', color: '#1A4731' }}>
          <div className="font-bold">{vi ? 'Phiếu trên Odoo' : 'Odoo documents'}</div>
          {st.odooRefs.map(r => (
            <div key={r.at}>
              <div className="text-[11px] text-gray-500">{new Date(r.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{r.by ? ` · ${r.by}` : ''}</div>
              {r.done.map((d, i) => <div key={i} className="font-mono">{d}</div>)}
            </div>
          ))}
        </div>
      )}
      {st.sent ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{vi ? '✓ Đã gửi Odoo.' : '✓ Sent to Odoo.'}</div>
      ) : !canSend ? (
        <div className="font-semibold" style={{ color: st.ready ? '#1A4731' : '#6B7280' }}>
          {st.ready ? (vi ? '✓ Đã xử lý xong — chờ Lab manager / admin gửi Odoo.' : '✓ All settled — waiting for the Lab manager / an admin to send to Odoo.')
                    : (vi ? 'Lab manager / admin gửi Odoo khi mọi dòng đã xử lý.' : 'The Lab manager / an admin sends to Odoo once every line is settled.')}
        </div>
      ) : confirming ? (
        <div className="flex gap-2 items-center">
          <span className="font-semibold">{vi ? 'Gửi tất cả các dòng lên Odoo?' : 'Send all lines to Odoo?'}</span>
          <button onClick={send} disabled={busy} className="font-bold rounded-lg px-3 py-1.5 text-white" style={{ backgroundColor: '#1A4731' }}>{busy ? '…' : (vi ? 'Gửi' : 'Send')}</button>
          <button onClick={() => setConfirming(false)} className="font-semibold underline">{vi ? 'Huỷ' : 'Cancel'}</button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} disabled={!st.ready || busy}
          className="text-sm font-bold rounded-lg px-4 py-2 text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
          {vi ? 'Gửi Odoo xác nhận cuối' : 'Send to Odoo (final validation)'}
        </button>
      )}
      {!st.ready && !st.sent && <div style={{ color: '#6B7280' }}>{vi ? 'Chọn nguyên nhân cho từng dòng trước.' : 'Choose the cause of each line first.'}</div>}
      <div style={{ color: '#6B7280' }}>{st.sourceType === 'sales_order'
        ? (vi ? 'Odoo: 1 phiếu trả hàng cho cả đơn + scrap Lab + giao thêm; hoá đơn về nháp, sửa số lượng (kế toán xác nhận lại).' : 'Odoo: 1 return for the whole order + Lab scrap + extra delivery; invoice back to draft, quantities adjusted (accounting re-validates).')
        : (() => {
          // Only what THIS order will really do (Axel, 2026-10-18: a plain return showed "+ scrap").
          const acts = new Set(st.lines.filter(l => !l.sent && l.action).map(l => l.action as string));
          const parts: string[] = [vi ? 'nhập kho shop số hàng tốt' : 'shop receipt at the right quantity'];
          if (['transit_to_lab', 'transit_to_lab_scrap', 'scrap_transit'].some(a => acts.has(a))) parts.push(vi ? 'trả hàng (return) trên phiếu LAB/OUT' : 'return on the LAB/OUT delivery');
          if (['transit_to_lab_scrap', 'scrap_transit'].some(a => acts.has(a))) parts.push(vi ? 'scrap (hao hụt Lab)' : 'scrap (Lab loss)');
          if (acts.has('lab_to_shop')) parts.push(vi ? 'chuyển Lab → shop' : 'Lab → shop transfer');
          return `Odoo : ${parts.join(' + ')}.`;
        })()}</div>
    </div>
  );
}

export default function GapsView({ initialGaps, schemaReady, odooMode, canSendOdoo, extra, extraClosed, top }: { initialGaps: DeliveryGap[]; schemaReady: boolean; odooMode: 'simulated' | 'live'; canSendOdoo: boolean; extra?: React.ReactNode; extraClosed?: React.ReactNode; top?: React.ReactNode }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('decide');
  const [selected, setSelected] = useState<string | null>(null);
  const [cause, setCause] = useState<LabCause | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<ReceptionPlan | null>(null);
  const [inPlan, setInPlan] = useState<{ result: InValidationResult; complete: boolean; done?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  // Section ② detail (Axel, 2026-10-24): the tasks panel lists the gaps; this screen opens on "Do it".
  const [detailOpen, setDetailOpen] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const key = (e as CustomEvent).detail as string | null;
      setDetailOpen(true);
      if (key === 'closed') { setTab('closed'); setSelected(null); }
      else if (key && key !== 'offslip') { setTab('decide'); setSelected(key); setEditing(false); setCause(null); setMessage(''); setPlan(null); setInPlan(null); setErr(null); }
      setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };
    window.addEventListener('lp-open-gap', on);
    return () => window.removeEventListener('lp-open-gap', on);
  }, []);

  // Damaged with a photo is settled automatically (Lab loss) and goes straight to "send".
  // The physical return is optional: the "return" tab only lists what has not come back yet.
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const byTab = useMemo(() => ({
    decide: initialGaps.filter(g => g.status === 'open'),
    shop: initialGaps.filter(g => g.status === 'waiting_shop'),
    return: initialGaps.filter(g => (g.kind === 'damaged' || g.labCause === 'damaged_returned') && g.labCause !== 'shop_miscount' && g.status !== 'waiting_shop' && !g.returnConfirmedAt && g.deliveryDate >= since7), // last 7 days only (Axel, 2026-10-24)
    send: initialGaps.filter(g => g.status === 'closed' && g.odooMode !== 'sent' && g.labCause !== 'shop_miscount' && !(g.kind === 'extra' && g.labCause !== 'lab_sent_extra')),
    closed: initialGaps.filter(g => g.status === 'closed'),
  }), [initialGaps, since7]);
  const list = byTab[tab];
  const current = list.find(g => g.key === selected) ?? list[0] ?? null;
  const overdueCount = initialGaps.filter(g => g.overdue).length; // a damaged unit not back is no longer a to-do (2026-10-19)

  function pick(g: DeliveryGap) { setSelected(g.key); setEditing(false); setCause(null); setMessage(''); setPlan(null); setInPlan(null); setErr(null); }

  async function submit() {
    if (!current || !cause) return;
    setBusy(true); setErr(null);
    const { decideGapAction } = await import('./actions');
    const res = await decideGapAction({ checkLineId: current.checkLineId, kind: current.kind, cause, message: message.trim() || null });
    setBusy(false);
    if (res.error) { setErr(res.error === 'not_enabled' ? (vi ? 'Bản thử: chưa kích hoạt lưu (cần cập nhật cơ sở dữ liệu).' : 'Preview: saving not enabled yet (database update pending).') : res.error); return; }
    if (res.plan) setPlan(res.plan);
    setEditing(false);
    router.refresh();
  }

  async function showInPlan() {
    if (!current) return;
    setBusy(true); setErr(null);
    const { previewInValidationAction } = await import('./actions');
    const res = await previewInValidationAction(current.deliveryOrderId);
    setBusy(false);
    if (res.error) setErr(res.error); else if (res.result) setInPlan({ result: res.result, complete: !!res.complete });
  }

  async function validateIn() {
    if (!current) return;
    setBusy(true); setErr(null);
    const { validateInAction } = await import('./actions');
    const res = await validateInAction(current.deliveryOrderId);
    setBusy(false);
    if (res.error) { setErr(res.error); return; }
    if (res.result) setInPlan({ result: res.result, complete: true, done: true });
  }

  const tabs: { key: Tab; vi: string; fr: string }[] = [
    { key: 'decide', vi: 'Cần xử lý', fr: 'To decide' },
    { key: 'shop', vi: 'Chờ shop', fr: 'Waiting shop' },
    { key: 'return', vi: 'Hỏng chưa về Lab', fr: 'Damaged not back' },
    { key: 'send', vi: 'Chờ gửi Odoo', fr: 'To send to Odoo' },
    { key: 'closed', vi: 'Đã đóng', fr: 'Closed' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/delivery-check" className="w-9 h-9 flex items-center justify-center rounded-lg border border-gray-200 bg-white"><ArrowLeft size={16} /></Link>
        <div>
          <h1 className="font-serif text-2xl font-bold text-navy">{vi ? 'Việc cần làm · Lệch giao hàng' : 'Tasks · Delivery gaps'}</h1>
          <p className="text-ink-light text-sm">{vi ? 'Sản xuất → giao hàng · giao hàng → cửa hàng' : 'Production → delivery · delivery → shop'}</p>
        </div>
      </div>

      {/* Tasks panel (Axel, 2026-10-24): counter, ① production → delivery, waiting, done. */}
      {top}

      <button type="button" onClick={() => setDetailOpen(o => !o)} className="text-sm font-semibold underline text-ink-light">
        {detailOpen ? (vi ? 'Ẩn màn hình chi tiết' : 'Hide the detail screen') : (vi ? 'Mở màn hình chi tiết (tất cả tab)' : 'Open the detail screen (all tabs)')}
      </button>

      <div ref={detailRef} hidden={!detailOpen} className="space-y-4">

      <div className="rounded-xl px-4 py-2.5 text-xs flex items-start gap-2" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE', color: '#4C1D95' }}>
        <FlaskConical size={14} className="shrink-0 mt-0.5" />
        <span>
          {vi ? 'Odoo: nhập kho shop tự xác nhận khi đủ số. Có lệch: chọn nguyên nhân từng dòng (hàng hỏng có ảnh = tự xử lý), rồi bấm « Gửi Odoo xác nhận cuối » cho cả đơn — Odoo tự làm trả hàng, scrap, chuyển kho, hoá đơn. '
                : 'Odoo: the shop receipt is validated by itself when everything matches. Gap: cause line by line (damaged with photo = settled automatically), then « Gửi Odoo xác nhận cuối » for the whole order — return, scrap, transfers, invoice done by the app. '}
          {schemaReady ? '' : (vi ? 'Chưa lưu được quyết định (cơ sở dữ liệu chưa cập nhật) — các lệch được tính từ xác nhận của shop.' : 'Decisions cannot be saved yet (database not updated) — gaps computed from shop receipts.')}
        </span>
      </div>

      {/* Products received that were on no slip (Axel, 2026-10-16) — see OffslipPanel. */}
      {extra}

      {overdueCount > 0 && (
        <div className="rounded-xl px-4 py-2.5 text-sm font-bold flex items-center gap-2" style={{ backgroundColor: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          <AlertTriangle size={16} /> {overdueCount} {vi ? 'quá hạn (48h / 2 chuyến) — báo Axel' : 'late (48h / 2 deliveries) — alert Axel'}
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap">
        {tabs.map(t => (
          <button key={t.key} onClick={() => { setTab(t.key); setSelected(null); setPlan(null); setInPlan(null); }}
            className="text-xs font-semibold rounded-full px-3.5 py-1.5"
            style={{ border: `1px solid ${tab === t.key ? '#1f2937' : '#D1D5DB'}`, backgroundColor: tab === t.key ? '#F3F4F6' : 'white' }}>
            {vi ? t.vi : t.fr} · {byTab[t.key].length}
          </button>
        ))}
      </div>

      {tab === 'closed' && extraClosed}

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="lg:w-[380px] shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden">
          {!list.length && <div className="px-4 py-6 text-sm text-center text-gray-500">{vi ? 'Không có' : 'Nothing here'}</div>}
          {list.map(g => {
            const h = hoursLeft(g.deadlineAt);
            const sign = g.kind === 'extra' ? '+' : '−';
            const color = g.kind === 'extra' ? '#1F5FAD' : g.kind === 'damaged' ? '#92400E' : '#B42318';
            return (
              <button key={g.key} onClick={() => pick(g)} className="w-full text-left px-4 py-3 border-b border-gray-200 space-y-1"
                style={{ backgroundColor: current?.key === g.key ? '#F3F4F6' : 'white' }}>
                <div className="flex justify-between gap-2">
                  <span className="text-sm font-semibold truncate">{g.product}</span>
                  <span className="text-sm font-bold shrink-0" style={{ color }}>{g.kind === 'damaged' ? `${g.qty} ${vi ? 'hỏng' : 'damaged'}` : `${sign}${g.qty}`}</span>
                </div>
                <div className="flex justify-between gap-2 text-xs text-gray-500">
                  <span className="truncate">{g.shopName} · {vi ? 'gửi' : 'sent'} {g.sent}, {vi ? 'nhận' : 'received'} {g.received}</span>
                  {tab === 'decide' && h != null && (
                    <span className="font-semibold shrink-0" style={{ color: g.overdue ? '#B42318' : '#374151' }}>
                      {g.overdue ? (vi ? 'quá hạn' : 'late') : vi ? `còn ${h}h` : `${h}h left`}
                    </span>
                  )}
                  {tab === 'return' && (
                    <span className="font-semibold shrink-0" style={{ color: g.returnOverdue ? '#B42318' : '#374151' }}>
                      {g.deliveriesSince} {vi ? 'chuyến sau' : 'deliv. since'}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          <div className="px-4 py-2.5 text-xs text-gray-500">{vi ? 'Dòng trên cùng = sắp hết hạn 48h.' : 'Top = closest to its 48h deadline.'}</div>
        </div>

        {current && (
          <div className="flex-1 min-w-0 bg-white rounded-xl border border-gray-200 p-5 space-y-4">
            <div className="flex justify-between items-start gap-3">
              <div>
                <div className="text-lg font-bold">{current.product}</div>
                <div className="text-sm text-gray-500">{current.shopName} · {current.orderRef} · {current.deliveryDate.slice(8, 10)}/{current.deliveryDate.slice(5, 7)}</div>
              </div>
              <span className="text-xs font-bold rounded-full px-2.5 py-1 shrink-0"
                style={current.kind === 'extra' ? { backgroundColor: '#E7F0FA', color: '#1F5FAD' } : current.kind === 'damaged' ? { backgroundColor: '#FEF3C7', color: '#92400E' } : { backgroundColor: '#FDECEA', color: '#B42318' }}>
                {current.kind === 'extra' ? `${vi ? 'Thừa' : 'Extra'} +${current.qty}` : current.kind === 'damaged' ? `${vi ? 'Hỏng' : 'Damaged'} ${current.qty}` : `${vi ? 'Thiếu' : 'Missing'} −${current.qty}`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5">
                <div className="text-[11px] font-bold text-gray-500">{vi ? 'BẾP GỬI' : 'SENT'}</div>
                <div className="text-xl font-bold">×{current.sent}</div>
                <div className="text-xs text-gray-500">{current.checkedBy ?? '—'}{current.checkedAt ? ` · ${new Date(current.checkedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}</div>
              </div>
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5">
                <div className="text-[11px] font-bold text-gray-500">{vi ? 'SHOP NHẬN' : 'RECEIVED'}</div>
                <div className="text-xl font-bold" style={{ color: current.kind === 'extra' ? '#1F5FAD' : '#B42318' }}>×{current.received}{current.damaged > 0 ? ` (${current.damaged} ${vi ? 'hỏng' : 'damaged'})` : ''}</div>
                <div className="text-xs text-gray-500">{current.confirmedBy ?? '—'}{current.shopNote ? ` · “${current.shopNote}”` : ''}</div>
              </div>
            </div>
            {current.photoUrls.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {current.photoUrls.map(u => (
                  <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="" className="w-20 h-20 rounded-lg object-cover border border-gray-200" /></a>
                ))}
              </div>
            )}
            {current.shopCause && (
              <div className="text-xs text-gray-600">{vi ? 'Shop chọn:' : 'The shop says:'} <b>{current.shopCause === 'wrong_product' ? (vi ? 'Sai sản phẩm' : 'Wrong product') : (vi ? 'Thiếu hàng' : 'Missing')}</b></div>
            )}

            {(current.status === 'open' || editing) && (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-[11px] font-bold tracking-wide text-gray-500 mb-2">
                    {current.kind === 'missing' ? (vi ? `${current.qty} CÁI THIẾU ĐI ĐÂU?` : `WHERE ARE THE ${current.qty} MISSING?`) : current.kind === 'damaged' ? (vi ? 'ẢNH CÓ CHO THẤY HỎNG?' : 'DOES THE PHOTO SHOW THE DAMAGE?') : (vi ? 'CÁI THỪA TỪ ĐÂU RA?' : 'WHERE DOES THE EXTRA COME FROM?')}
                  </legend>
                  {CAUSES[current.kind].map(c => (
                    <label key={c.key} className="flex items-center gap-3 rounded-lg px-3.5 py-2.5 cursor-pointer"
                      style={{ border: cause === c.key ? '1.5px solid #1A4731' : '1px solid #E5E7EB', backgroundColor: cause === c.key ? '#EAF2ED' : 'white' }}>
                      <input type="radio" name="cause" checked={cause === c.key} onChange={() => setCause(c.key)} style={{ accentColor: '#1A4731' }} />
                      <span className="flex-1 text-sm font-semibold">{vi ? c.vi : c.fr}</span>
                      <span className="text-xs text-gray-500">{current.sourceType === 'sales_order' && SO_EFFECT[c.key] ? (vi ? SO_EFFECT[c.key]!.vi : SO_EFFECT[c.key]!.fr) : (vi ? c.effVi : c.effFr)}</span>
                    </label>
                  ))}
                </fieldset>
                <input value={message} onChange={e => setMessage(e.target.value)} maxLength={300}
                  placeholder={vi ? 'Lời nhắn cho shop (tuỳ chọn)' : 'Message to the shop (optional)'}
                  className="w-full text-sm rounded-lg px-3 py-2.5 border border-gray-300" />
              </>
            )}
            {current.kind === 'damaged' && current.labCause !== 'shop_miscount' && (
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700">
                {vi ? 'Hỏng khi nhận, có ảnh = hao hụt Lab, tự xử lý: « Gửi Odoo » sẽ trả về + scrap. Nhận lại hàng hỏng trong Nhập kho (LỖI LAB) là tuỳ chọn.'
                    : 'Abîmé à l’arrivée avec photo = perte Lab, réglé automatiquement : « Envoyer à Odoo » fait retour + scrap. Le retour physique en Nhập kho (LỖI LAB) est un plus.'}
                {current.returnConfirmedAt && <div className="font-semibold mt-1" style={{ color: '#15803D' }}>{vi ? '✓ Hàng hỏng đã về Lab' : '✓ Damaged items back at the Lab'}{current.returnConfirmedBy ? ` · ${current.returnConfirmedBy}` : ''}</div>}
                {current.returnOverdue && <div className="font-bold mt-1" style={{ color: '#B42318' }}>{vi ? `Chưa về sau ${current.deliveriesSince} chuyến — báo Axel` : `Not back after ${current.deliveriesSince} deliveries — alert Axel`}</div>}
              </div>
            )}
            {current.labCause && current.status !== 'open' && !editing && (
              <div className="text-sm text-gray-700 flex items-center gap-3 flex-wrap">
                <span>{vi ? 'Đã chọn:' : 'Decided:'} <b>{[...CAUSES.missing, ...CAUSES.extra, ...CAUSES.damaged].find(c => c.key === current.labCause)?.[vi ? 'vi' : 'fr']}</b>{current.decidedBy ? ` · ${current.decidedBy}` : ''}</span>
                {current.odooMode !== 'sent' && (
                  <button onClick={() => { setEditing(true); setCause(current.labCause); }} className="text-xs font-semibold underline text-gray-600">{vi ? 'Đổi' : 'Edit'}</button>
                )}
              </div>
            )}

            {err && <div className="text-sm font-semibold" style={{ color: '#B42318' }}>{err}</div>}
            {plan && <PlanBox plan={plan} vi={vi} />}
            {inPlan && <InBox data={inPlan} vi={vi} busy={busy} onValidate={validateIn} canSend={canSendOdoo} />}

            <div className="flex justify-between items-center gap-2 flex-wrap">
              <SendBox key={current.deliveryOrderId} deliveryOrderId={current.deliveryOrderId} vi={vi} onDone={() => router.refresh()} canSend={canSendOdoo} />
              {current.sourceType !== 'sales_order' && (
                <button onClick={showInPlan} disabled={busy} className="text-xs font-semibold underline text-gray-600 disabled:opacity-40">
                  {vi ? 'Chỉ nhập kho shop trên Odoo' : 'Validate the shop receipt only'}
                </button>
              )}
              {(current.status === 'open' || editing) && (
                <button onClick={submit} disabled={!cause || busy}
                  className="text-sm font-bold rounded-lg px-6 py-3 text-white disabled:opacity-40 flex items-center gap-2" style={{ backgroundColor: '#1A4731' }}>
                  {busy && <Loader2 size={14} className="animate-spin" />}{vi ? 'Xác nhận nguyên nhân' : 'Confirm the cause'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
