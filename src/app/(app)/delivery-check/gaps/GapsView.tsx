'use client';
// Delivery gaps — Lab side (preview 2026-10-13). Layout follows the validated mockup
// (Lab 1 / Lab 2): list on the left (closest to its 48h deadline first), decision on the right.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, AlertTriangle, Loader2, FlaskConical } from 'lucide-react';
import type { DeliveryGap, LabCause } from '@/lib/reception-gaps';
import type { ReceptionPlan, PlannedStep, InValidationResult } from '@/lib/reception-odoo';

type Tab = 'decide' | 'shop' | 'return' | 'send' | 'closed';

// Sales orders (Moon Flower): no shop IN — effects are a return / extra delivery + draft invoice change.
const SO_EFFECT: Partial<Record<LabCause, { vi: string; fr: string }>> = {
  found_at_lab: { vi: '→ trả về kho Lab, giảm hoá đơn', fr: '→ retour stock Lab, facture −' },
  damaged_returned: { vi: '→ trả về + hao hụt Lab, giảm hoá đơn', fr: '→ retour + perte Lab, facture −' },
  lost_transport: { vi: '→ trả về + hao hụt Lab, giảm hoá đơn', fr: '→ retour + perte Lab, facture −' },
  lab_sent_extra: { vi: '→ thêm vào giao hàng + hoá đơn', fr: '→ ajout livraison + facture' },
};

const CAUSES: Record<'missing' | 'extra' | 'damaged', { key: LabCause; vi: string; fr: string; effVi: string; effFr: string }[]> = {
  missing: [
    { key: 'found_at_lab', vi: 'Còn ở Lab, chưa gửi đi', fr: 'Retrouvé au Lab, jamais parti', effVi: '→ về lại kho Lab', effFr: '→ retour stock Lab' },
    { key: 'damaged_returned', vi: 'Hỏng, mang về Lab', fr: 'Abîmé, ramené au Lab', effVi: '→ hao hụt Lab', effFr: '→ perte Lab' },
    { key: 'lost_transport', vi: 'Mất khi vận chuyển', fr: 'Perdu pendant le transport', effVi: '→ hao hụt vận chuyển', effFr: '→ perte transport' },
    { key: 'shop_miscount', vi: 'Shop đếm sai', fr: 'Le shop a mal compté', effVi: '→ shop đếm lại', effFr: '→ le shop recompte' },
  ],
  extra: [
    { key: 'lab_sent_extra', vi: 'Lab gửi thừa', fr: 'Le Lab en a envoyé en trop', effVi: '→ kho Lab → kho shop', effFr: '→ stock Lab → stock shop' },
    { key: 'shop_miscount', vi: 'Shop đếm sai', fr: 'Le shop a mal compté', effVi: '→ shop đếm lại', effFr: '→ le shop recompte' },
  ],
  // Settled automatically from the shop's photo; the assistant only changes it to contest.
  damaged: [
    { key: 'damaged_returned', vi: 'Hỏng thật (ảnh)', fr: 'Bien abîmé (photo)', effVi: '→ trả về + hao hụt Lab', effFr: '→ retour + perte Lab' },
    { key: 'shop_miscount', vi: 'Ảnh không cho thấy hỏng', fr: 'La photo ne montre pas de casse', effVi: '→ shop đếm lại', effFr: '→ le shop recompte' },
  ],
};

function hoursLeft(deadlineAt: string | null): number | null {
  if (!deadlineAt) return null;
  return Math.round((new Date(deadlineAt).getTime() - Date.now()) / 3600_000);
}

function stepText(s: PlannedStep, vi: boolean): string {
  switch (s.op) {
    case 'set_move_qty': return `${s.pickingName} · ${s.sku || s.product}: ${s.demand} → ${s.qty}`;
    case 'validate_no_backorder': return vi ? `Xác nhận ${s.pickingName} (không tạo backorder)` : `Valider ${s.pickingName} (sans reliquat)`;
    case 'move': return `${s.sku || s.product} ×${s.qty}: ${s.from} → ${s.to}`;
    case 'scrap': return `Scrap ${s.sku || s.product} ×${s.qty} @ ${s.location} (${s.reason})`;
    case 'note': return s.text;
  }
}

function PlanBox({ plan, vi }: { plan: ReceptionPlan; vi: boolean }) {
  return (
    <div className="rounded-xl p-3 text-xs space-y-1" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE', color: '#4C1D95' }}>
      <div className="font-bold flex items-center gap-1.5"><FlaskConical size={13} />
        {plan.mode === 'simulated' ? (vi ? 'Odoo: mô phỏng — không ghi gì' : 'Odoo : simulation — rien n’est écrit') : 'Odoo: live'}
      </div>
      {plan.error && <div style={{ color: '#B42318' }}>{plan.error}</div>}
      {plan.steps.map((s, i) => <div key={i} className="font-mono">{stepText(s, vi)}</div>)}
    </div>
  );
}

const SKIP_LABEL: Record<string, { vi: string; fr: string }> = {
  lab_out_not_validated: { vi: 'Phiếu xuất Lab chưa xác nhận trên Odoo — xác nhận giao hàng trước.', fr: 'Le OUT du Lab n’est pas validé sur Odoo — valider la livraison d’abord.' },
  no_shop_in: { vi: 'Không tìm thấy phiếu nhập shop trên Odoo.', fr: 'Aucune réception shop trouvée sur Odoo.' },
  several_shop_in: { vi: 'Có nhiều phiếu nhập shop — làm tay trên Odoo.', fr: 'Plusieurs réceptions shop — à faire à la main sur Odoo.' },
  odoo_not_configured: { vi: 'Odoo chưa cấu hình.', fr: 'Odoo non configuré.' },
};
function skipText(code: string, vi: boolean): string {
  const base = code.split(':')[0];
  const sku = code.includes(':') ? code.split(':').slice(1).join(':') : '';
  if (SKIP_LABEL[base]) return vi ? SKIP_LABEL[base].vi : SKIP_LABEL[base].fr;
  if (base === 'unmatched_product') return vi ? `Sản phẩm ${sku} có trên Odoo nhưng không có trong app — làm tay.` : `Produit ${sku} sur Odoo mais pas dans l’app — à faire à la main.`;
  if (base === 'missing_move') return vi ? `Sản phẩm ${sku} không có trên phiếu nhập — làm tay.` : `Produit ${sku} absent de la réception Odoo — à faire à la main.`;
  if (base === 'ambiguous_split') return vi ? `${sku} có nhiều dòng trên Odoo — làm tay.` : `${sku} a plusieurs lignes sur Odoo — à faire à la main.`;
  return code;
}

function InBox({ data, vi, busy, onValidate, canSend }: { data: { result: InValidationResult; complete: boolean; done?: boolean }; vi: boolean; busy: boolean; onValidate: () => void; canSend: boolean }) {
  const r = data.result;
  return (
    <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ backgroundColor: '#F9FAFB', border: '1px solid #E5E7EB' }}>
      <div className="font-bold text-sm">{vi ? 'Nhập kho shop' : 'Réception shop'} {r.pickingName ?? ''}</div>
      {r.alreadyDone ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{vi ? '✓ Đã xác nhận trên Odoo.' : '✓ Déjà validée sur Odoo.'}</div>
      ) : data.done && r.ok ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{r.live ? (vi ? '✓ Đã xác nhận trên Odoo.' : '✓ Validée sur Odoo.') : (vi ? 'Bản thử: không ghi Odoo.' : 'Preview : rien écrit sur Odoo.')}</div>
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
          <div className="font-semibold" style={{ color: '#6B7280' }}>{vi ? 'Chỉ Lab manager / admin xác nhận trên Odoo.' : 'Seuls la Lab manager / un admin valident sur Odoo.'}</div>
        ) : data.complete ? (
          <button onClick={onValidate} disabled={busy}
            className="mt-1 text-sm font-bold rounded-lg px-4 py-2 text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
            {vi ? 'Xác nhận nhập kho trên Odoo' : 'Valider la réception sur Odoo'}
          </button>
        ) : (
          <div style={{ color: '#6B7280' }}>{vi ? 'Shop chưa xác nhận hết các dòng.' : 'Le shop n’a pas encore confirmé toutes les lignes.'}</div>
        )
      )}
      <div style={{ color: '#6B7280' }}>{vi ? 'Số nhập = hàng tốt (nhận − hỏng), tối đa số Bếp gửi. Hàng thiếu/hỏng ở lại transit chờ xử lý.' : 'Quantité = bons (reçu − abîmés), au max l’envoyé. Manquants/abîmés restent en transit.'}</div>
    </div>
  );
}

const ACTION_LABEL: Record<string, { vi: string; fr: string }> = {
  return: { vi: 'trả về Lab', fr: 'retour Lab' },
  return_scrap: { vi: 'trả về + hao hụt Lab', fr: 'retour + perte Lab' },
  extra: { vi: 'giao thêm', fr: 'livraison en plus' },
  transit_to_lab: { vi: 'transit → kho Lab', fr: 'transit → stock Lab' },
  transit_to_lab_scrap: { vi: 'về Lab + hao hụt Lab', fr: 'retour Lab + perte Lab' },
  scrap_transit: { vi: 'hao hụt vận chuyển', fr: 'perte transport' },
  lab_to_shop: { vi: 'kho Lab → kho shop', fr: 'stock Lab → stock shop' },
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
      <div className="font-bold text-sm">{vi ? `${st.sourceType === 'sales_order' ? 'Đơn bán' : 'Đơn'} ${st.orderRef} — xác nhận cuối trên Odoo` : `${st.sourceType === 'sales_order' ? 'Vente' : 'Commande'} ${st.orderRef} — validation finale Odoo`}</div>
      <div className="space-y-1">
        {st.lines.map(l => (
          <div key={l.key} className="flex justify-between gap-2">
            <span className="truncate">{l.product} · {l.kind === 'extra' ? '+' : '−'}{l.qty}{l.kind === 'damaged' ? (vi ? ' hỏng' : ' abîmé') : ''}{l.photoUrls.length ? ' 📷' : ''}</span>
            <span className="shrink-0 font-semibold" style={{ color: l.sent ? '#15803D' : l.status === 'closed' ? '#1A4731' : '#B45309' }}>
              {l.sent ? (vi ? '✓ đã gửi' : '✓ envoyé') : l.status !== 'closed' ? (vi ? 'chưa xử lý xong' : 'pas encore réglé') : l.action ? (vi ? ACTION_LABEL[l.action].vi : ACTION_LABEL[l.action].fr) : (vi ? 'không cần Odoo' : 'rien sur Odoo')}
            </span>
          </div>
        ))}
      </div>
      {msg && <div className="font-semibold" style={{ color: msg.ok ? '#15803D' : '#B42318' }}>{msg.text}</div>}
      {st.odooRefs.length > 0 && (
        <div className="rounded-lg px-2.5 py-2 space-y-0.5" style={{ backgroundColor: '#EAF2ED', color: '#1A4731' }}>
          <div className="font-bold">{vi ? 'Phiếu trên Odoo' : 'Pièces Odoo'}</div>
          {st.odooRefs.map(r => (
            <div key={r.at}>
              <div className="text-[11px] text-gray-500">{new Date(r.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}{r.by ? ` · ${r.by}` : ''}</div>
              {r.done.map((d, i) => <div key={i} className="font-mono">{d}</div>)}
            </div>
          ))}
        </div>
      )}
      {st.sent ? (
        <div className="font-semibold" style={{ color: '#15803D' }}>{vi ? '✓ Đã gửi Odoo.' : '✓ Envoyé à Odoo.'}</div>
      ) : !canSend ? (
        <div className="font-semibold" style={{ color: st.ready ? '#1A4731' : '#6B7280' }}>
          {st.ready ? (vi ? '✓ Đã xử lý xong — chờ Lab manager / admin gửi Odoo.' : '✓ Tout est réglé — en attente d’envoi à Odoo par la Lab manager / un admin.')
                    : (vi ? 'Lab manager / admin gửi Odoo khi mọi dòng đã xử lý.' : 'La Lab manager / un admin envoie à Odoo une fois toutes les lignes réglées.')}
        </div>
      ) : confirming ? (
        <div className="flex gap-2 items-center">
          <span className="font-semibold">{vi ? 'Gửi tất cả các dòng lên Odoo?' : 'Envoyer toutes les lignes à Odoo ?'}</span>
          <button onClick={send} disabled={busy} className="font-bold rounded-lg px-3 py-1.5 text-white" style={{ backgroundColor: '#1A4731' }}>{busy ? '…' : (vi ? 'Gửi' : 'Envoyer')}</button>
          <button onClick={() => setConfirming(false)} className="font-semibold underline">{vi ? 'Huỷ' : 'Annuler'}</button>
        </div>
      ) : (
        <button onClick={() => setConfirming(true)} disabled={!st.ready || busy}
          className="text-sm font-bold rounded-lg px-4 py-2 text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
          {vi ? 'Gửi Odoo xác nhận cuối' : 'Envoyer à Odoo (validation finale)'}
        </button>
      )}
      {!st.ready && !st.sent && <div style={{ color: '#6B7280' }}>{vi ? 'Chọn nguyên nhân cho từng dòng trước.' : 'Choisir la cause de chaque ligne d’abord.'}</div>}
      <div style={{ color: '#6B7280' }}>{st.sourceType === 'sales_order'
        ? (vi ? 'Odoo: 1 phiếu trả hàng cho cả đơn + scrap Lab + giao thêm; hoá đơn về nháp, sửa số lượng (kế toán xác nhận lại).' : 'Odoo : 1 retour pour toute la commande + scrap Lab + livraison en plus ; facture repassée en brouillon, quantités ajustées (la compta revalide).')
        : (vi ? 'Odoo: nhập kho shop số hàng tốt + chuyển transit → Lab / scrap / Lab → shop.' : 'Odoo : réception shop au bon nombre + transferts transit → Lab / scrap / Lab → shop.')}</div>
    </div>
  );
}

export default function GapsView({ initialGaps, schemaReady, odooMode, canSendOdoo }: { initialGaps: DeliveryGap[]; schemaReady: boolean; odooMode: 'simulated' | 'live'; canSendOdoo: boolean }) {
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

  // Damaged with a photo is settled automatically (Lab loss) and goes straight to "send".
  // The physical return is optional: the "return" tab only lists what has not come back yet.
  const byTab = useMemo(() => ({
    decide: initialGaps.filter(g => g.status === 'open'),
    shop: initialGaps.filter(g => g.status === 'waiting_shop'),
    return: initialGaps.filter(g => (g.kind === 'damaged' || g.labCause === 'damaged_returned') && g.labCause !== 'shop_miscount' && g.status !== 'waiting_shop' && !g.returnConfirmedAt),
    send: initialGaps.filter(g => g.status === 'closed' && g.odooMode !== 'sent' && g.labCause !== 'shop_miscount' && !(g.kind === 'extra' && g.labCause !== 'lab_sent_extra')),
    closed: initialGaps.filter(g => g.status === 'closed'),
  }), [initialGaps]);
  const list = byTab[tab];
  const current = list.find(g => g.key === selected) ?? list[0] ?? null;
  const overdueCount = initialGaps.filter(g => g.overdue || g.returnOverdue).length;

  function pick(g: DeliveryGap) { setSelected(g.key); setEditing(false); setCause(null); setMessage(''); setPlan(null); setInPlan(null); setErr(null); }

  async function submit() {
    if (!current || !cause) return;
    setBusy(true); setErr(null);
    const { decideGapAction } = await import('./actions');
    const res = await decideGapAction({ checkLineId: current.checkLineId, kind: current.kind, cause, message: message.trim() || null });
    setBusy(false);
    if (res.error) { setErr(res.error === 'not_enabled' ? (vi ? 'Bản thử: chưa kích hoạt lưu (cần cập nhật cơ sở dữ liệu).' : 'Preview : enregistrement pas encore activé (ajout en base à appliquer).') : res.error); return; }
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
    { key: 'decide', vi: 'Cần xử lý', fr: 'À décider' },
    { key: 'shop', vi: 'Chờ shop', fr: 'Attente shop' },
    { key: 'return', vi: 'Hỏng chưa về Lab', fr: 'Abîmés pas revenus' },
    { key: 'send', vi: 'Chờ gửi Odoo', fr: 'À envoyer à Odoo' },
    { key: 'closed', vi: 'Đã đóng', fr: 'Clôturés' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/delivery-check" className="w-9 h-9 flex items-center justify-center rounded-lg border border-gray-200 bg-white"><ArrowLeft size={16} /></Link>
        <div>
          <h1 className="font-serif text-2xl font-bold text-navy">{vi ? 'Lệch giao hàng' : 'Écarts de livraison'}</h1>
          <p className="text-ink-light text-sm">{vi ? 'Shop nhận khác số Bếp — xử lý trong 48h' : 'Le shop a reçu ≠ du check Lab — à traiter sous 48h'}</p>
        </div>
      </div>

      <div className="rounded-xl px-4 py-2.5 text-xs flex items-start gap-2" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE', color: '#4C1D95' }}>
        <FlaskConical size={14} className="shrink-0 mt-0.5" />
        <span>
          {vi ? 'Odoo: nhập kho shop tự xác nhận khi đủ số. Có lệch: chọn nguyên nhân từng dòng (hàng hỏng có ảnh = tự xử lý), rồi bấm « Gửi Odoo xác nhận cuối » cho cả đơn — Odoo tự làm trả hàng, scrap, chuyển kho, hoá đơn. '
                : 'Odoo : réception shop validée seule si tout correspond. Écart : cause ligne par ligne (abîmé avec photo = réglé automatiquement), puis « Gửi Odoo xác nhận cuối » pour toute la commande — retour, scrap, transferts, facture faits par l’app. '}
          {schemaReady ? '' : (vi ? 'Chưa lưu được quyết định (cơ sở dữ liệu chưa cập nhật) — các lệch được tính từ xác nhận của shop.' : 'Décisions pas encore enregistrables (ajout en base non appliqué) — écarts calculés depuis les réceptions shop.')}
        </span>
      </div>

      {overdueCount > 0 && (
        <div className="rounded-xl px-4 py-2.5 text-sm font-bold flex items-center gap-2" style={{ backgroundColor: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          <AlertTriangle size={16} /> {overdueCount} {vi ? 'quá hạn (48h / 2 chuyến) — báo Axel' : 'en retard (48h / 2 livraisons) — alerte Axel'}
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

      <div className="flex flex-col lg:flex-row gap-4">
        <div className="lg:w-[380px] shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden">
          {!list.length && <div className="px-4 py-6 text-sm text-center text-gray-500">{vi ? 'Không có' : 'Rien ici'}</div>}
          {list.map(g => {
            const h = hoursLeft(g.deadlineAt);
            const sign = g.kind === 'extra' ? '+' : '−';
            const color = g.kind === 'extra' ? '#1F5FAD' : g.kind === 'damaged' ? '#92400E' : '#B42318';
            return (
              <button key={g.key} onClick={() => pick(g)} className="w-full text-left px-4 py-3 border-b border-gray-200 space-y-1"
                style={{ backgroundColor: current?.key === g.key ? '#F3F4F6' : 'white' }}>
                <div className="flex justify-between gap-2">
                  <span className="text-sm font-semibold truncate">{g.product}</span>
                  <span className="text-sm font-bold shrink-0" style={{ color }}>{g.kind === 'damaged' ? `${g.qty} ${vi ? 'hỏng' : 'abîmé(s)'}` : `${sign}${g.qty}`}</span>
                </div>
                <div className="flex justify-between gap-2 text-xs text-gray-500">
                  <span className="truncate">{g.shopName} · {vi ? 'gửi' : 'envoyé'} {g.sent}, {vi ? 'nhận' : 'reçu'} {g.received}</span>
                  {tab === 'decide' && h != null && (
                    <span className="font-semibold shrink-0" style={{ color: g.overdue ? '#B42318' : '#374151' }}>
                      {g.overdue ? (vi ? 'quá hạn' : 'en retard') : vi ? `còn ${h}h` : `${h}h restantes`}
                    </span>
                  )}
                  {tab === 'return' && (
                    <span className="font-semibold shrink-0" style={{ color: g.returnOverdue ? '#B42318' : '#374151' }}>
                      {g.deliveriesSince} {vi ? 'chuyến sau' : 'livr. depuis'}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          <div className="px-4 py-2.5 text-xs text-gray-500">{vi ? 'Dòng trên cùng = sắp hết hạn 48h.' : 'En haut = le plus proche de ses 48h.'}</div>
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
                {current.kind === 'extra' ? `${vi ? 'Thừa' : 'En trop'} +${current.qty}` : current.kind === 'damaged' ? `${vi ? 'Hỏng' : 'Abîmé'} ${current.qty}` : `${vi ? 'Thiếu' : 'Manque'} −${current.qty}`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5">
                <div className="text-[11px] font-bold text-gray-500">{vi ? 'BẾP GỬI' : 'ENVOYÉ'}</div>
                <div className="text-xl font-bold">×{current.sent}</div>
                <div className="text-xs text-gray-500">{current.checkedBy ?? '—'}{current.checkedAt ? ` · ${new Date(current.checkedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}</div>
              </div>
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5">
                <div className="text-[11px] font-bold text-gray-500">{vi ? 'SHOP NHẬN' : 'REÇU'}</div>
                <div className="text-xl font-bold" style={{ color: current.kind === 'extra' ? '#1F5FAD' : '#B42318' }}>×{current.received}{current.damaged > 0 ? ` (${current.damaged} ${vi ? 'hỏng' : 'abîmé'})` : ''}</div>
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
              <div className="text-xs text-gray-600">{vi ? 'Shop chọn:' : 'Le shop indique :'} <b>{current.shopCause === 'wrong_product' ? (vi ? 'Sai sản phẩm' : 'Mauvais produit') : (vi ? 'Thiếu hàng' : 'Manquant')}</b></div>
            )}

            {(current.status === 'open' || editing) && (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-[11px] font-bold tracking-wide text-gray-500 mb-2">
                    {current.kind === 'missing' ? (vi ? `${current.qty} CÁI THIẾU ĐI ĐÂU?` : `OÙ SONT LES ${current.qty} MANQUANTS ?`) : current.kind === 'damaged' ? (vi ? 'ẢNH CÓ CHO THẤY HỎNG?' : 'LA PHOTO MONTRE-T-ELLE LA CASSE ?') : (vi ? 'CÁI THỪA TỪ ĐÂU RA?' : 'D’OÙ VIENT LE SURPLUS ?')}
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
                  placeholder={vi ? 'Lời nhắn cho shop (tuỳ chọn)' : 'Message au shop (optionnel)'}
                  className="w-full text-sm rounded-lg px-3 py-2.5 border border-gray-300" />
              </>
            )}
            {current.kind === 'damaged' && current.labCause !== 'shop_miscount' && (
              <div className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700">
                {vi ? 'Hỏng khi nhận, có ảnh = hao hụt Lab, tự xử lý: « Gửi Odoo » sẽ trả về + scrap. Nhận lại hàng hỏng trong Nhập kho (LỖI LAB) là tuỳ chọn.'
                    : 'Abîmé à l’arrivée avec photo = perte Lab, réglé automatiquement : « Envoyer à Odoo » fait retour + scrap. Le retour physique en Nhập kho (LỖI LAB) est un plus.'}
                {current.returnConfirmedAt && <div className="font-semibold mt-1" style={{ color: '#15803D' }}>{vi ? '✓ Hàng hỏng đã về Lab' : '✓ Abîmés revenus au Lab'}{current.returnConfirmedBy ? ` · ${current.returnConfirmedBy}` : ''}</div>}
                {current.returnOverdue && <div className="font-bold mt-1" style={{ color: '#B42318' }}>{vi ? `Chưa về sau ${current.deliveriesSince} chuyến — báo Axel` : `Pas revenu après ${current.deliveriesSince} livraisons — alerte Axel`}</div>}
              </div>
            )}
            {current.labCause && current.status !== 'open' && !editing && (
              <div className="text-sm text-gray-700 flex items-center gap-3 flex-wrap">
                <span>{vi ? 'Đã chọn:' : 'Décidé :'} <b>{[...CAUSES.missing, ...CAUSES.extra, ...CAUSES.damaged].find(c => c.key === current.labCause)?.[vi ? 'vi' : 'fr']}</b>{current.decidedBy ? ` · ${current.decidedBy}` : ''}</span>
                {current.odooMode !== 'sent' && (
                  <button onClick={() => { setEditing(true); setCause(current.labCause); }} className="text-xs font-semibold underline text-gray-600">{vi ? 'Đổi' : 'Modifier'}</button>
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
                  {vi ? 'Chỉ nhập kho shop trên Odoo' : 'Valider seulement la réception shop'}
                </button>
              )}
              {(current.status === 'open' || editing) && (
                <button onClick={submit} disabled={!cause || busy}
                  className="text-sm font-bold rounded-lg px-6 py-3 text-white disabled:opacity-40 flex items-center gap-2" style={{ backgroundColor: '#1A4731' }}>
                  {busy && <Loader2 size={14} className="animate-spin" />}{vi ? 'Xác nhận nguyên nhân' : 'Confirmer la cause'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
