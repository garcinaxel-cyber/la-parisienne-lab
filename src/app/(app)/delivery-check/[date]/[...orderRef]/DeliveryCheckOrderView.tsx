'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, CheckCircle2, AlertTriangle, PackageCheck, Box, Pencil, Printer, Eye, EyeOff, RefreshCw, CheckCheck, ArrowRightLeft } from 'lucide-react';
import type { CheckLine, DeliveryOrderHeader, OnlineOrderCheckInfo, DeliveryDestination } from '@/lib/delivery-check';
import { DELIVERY_CHECK_REASONS as REASONS } from '@/lib/delivery-check-reasons';
import type { ProdStatus } from '@/lib/delivery-check-production';
import { TEAM_LABELS, type Team } from '@/lib/types';

// Families made as extra production for stock, never on demand (Axel, 2026-10-19: tiramisu,
// biscuits voyage, macarons → "soit en stock soit c'est pas envoyé") — no production alert.
const STOCK_FAMILIES = new Set(['macaron', 'biscuit voyage', 'tiramisu']);

// "Bếp → kho" cell (Axel, 2026-10-19): what the kitchen produced / sent to stock for this SKU
// vs what is delivered, for the whole delivery date. Information only — never blocks anything.
function ProdCell({ s, family, vi }: { s: ProdStatus | undefined; family: string | null; vi: boolean }) {
  const chip = (bg: string, color: string, text: string) => (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold whitespace-nowrap" style={{ backgroundColor: bg, color }}>{text}</span>
  );
  const grey = (t: string) => chip('#F3F4F6', '#4B5563', t);
  if (!s) return null;
  const teams = s.teams.map(t => TEAM_LABELS[t as Team]?.vi ?? t).join(', ');
  const day = s.ordered > 0 ? (vi ? `Cả ngày: giao ${s.checked}/${s.ordered}` : `Journée : livré ${s.checked}/${s.ordered}`) : null;
  const sub = (color: string, text: string | null) => text ? <div className="text-[11px] leading-snug mt-0.5" style={{ color }}>{text}</div> : null;

  if (family && STOCK_FAMILIES.has(family.trim().toLowerCase())) {
    return <div>{grey(vi ? 'Kho · làm thêm' : 'Stock · prod. extra')}</div>;
  }
  if (s.cards === 0) return <div>{grey(vi ? 'Kho · không có thẻ SX' : 'Stock · pas de carte')}</div>;
  if (s.planned === 0) {
    return <div>{grey(s.stock > 0 ? (vi ? `Có sẵn ×${s.stock}` : `Dispo stock ×${s.stock}`) : (vi ? 'Chặn' : 'Bloqué'))}{sub('#6B7280', day)}</div>;
  }
  let main;
  if (s.sent >= s.planned) main = chip('#ECFDF5', '#047857', vi ? `Chuyển kho ✓ ${s.sent}/${s.planned}` : `Transféré ✓ ${s.sent}/${s.planned}`);
  else if (s.sent > 0) main = chip('#FFF4D6', '#8A5A00', vi ? `Chuyển kho ${s.sent}/${s.planned}` : `Transféré ${s.sent}/${s.planned}`);
  else if (s.produced > 0) main = chip('#FDECEA', '#B42318', vi ? `Chưa chuyển kho 0/${s.planned}` : `Pas transféré 0/${s.planned}`);
  else main = chip('#FDECEA', '#B42318', vi ? `Chưa làm 0/${s.planned}` : `Pas produit 0/${s.planned}`);
  const over = s.checked - (s.sent + s.stock);
  return (
    <div>
      {main}
      {sub('#6B7280', [teams, day].filter(Boolean).join(' · ') || null)}
      {over > 0 && s.sent < s.checked && sub('#6D28D9', vi ? `Giao nhiều hơn chuyển kho +${over}` : `Livré > transféré +${over}`)}
    </div>
  );
}

type LineState = { qty: string; reason: string; note: string };

// A weighed raw material (e.g. "Mango" 152-MH.210, sold/consumed in kg) never matches its
// nominal expected qty exactly — the real weight is whatever the scale reads. There's no
// unit-of-measure field on CheckLine to flag this explicitly (Odoo qty is rounded to a whole
// number on import — see odoo-sync.ts Math.round(product_uom_qty) — so qty_expected is always
// an integer placeholder like "1"), so a typed DECIMAL value is treated as the signal instead:
// nobody fat-fingers a count-based product ("4 bánh") as "3.87" by accident, so any non-integer
// entry is assumed to be an actual measured weight and skips the mandatory reason (2026-08-14,
// Axel — assistants couldn't press OK after typing the real weight because the reason
// dropdown, required for ANY nonzero diff, was hidden below the iPad keyboard).
function isWeighedEntry(qty: number): boolean {
  return Number.isFinite(qty) && !Number.isInteger(qty);
}

// Raw float subtraction (0.896 - 1) prints as "-0.10399999999999998" — round to a sane
// precision (grams) before display.
function fmtDiff(diff: number): string {
  const r = Math.round(diff * 1000) / 1000;
  return String(r);
}

// Hoisted to module scope on purpose (2026-08-11 bug: assistants could only type one letter at
// a time into the reason note, losing focus after every keystroke). It used to be declared
// INSIDE DeliveryCheckOrderView's render body — React saw a brand-new function/component
// identity on every setState-triggered re-render (i.e. every keystroke via upd()), so it
// unmounted and remounted this entire subtree each time, including whatever input had focus.
// Needs everything it used to read from closure passed in as props instead.
function Section({ title, icon: Icon, items, state, checked, savingLine, validated, vi, upd, checkLine, setChecked, hiddenFromPrint, toggleHidden, prod }: {
  title: string; icon: any; items: CheckLine[];
  state: Record<string, LineState>; checked: Set<string>; savingLine: string | null; validated: boolean; vi: boolean;
  upd: (id: string, patch: Partial<LineState>) => void;
  checkLine: (l: CheckLine) => void;
  setChecked: (fn: (p: Set<string>) => Set<string>) => void;
  hiddenFromPrint: Record<string, boolean>;
  toggleHidden: (id: string, hidden: boolean) => void;
  prod?: Record<string, ProdStatus> | null;
}) {
  if (!items.length) return null;
  const withProd = !!prod;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
        <Icon size={16} className="text-navy" />
        <span className="text-sm font-bold text-navy">{title}</span>
        <span className="text-xs text-ink-light">· {items.filter(l => checked.has(l.id)).length}/{items.length}</span>
      </div>
      {withProd && (
        <div className="hidden sm:grid sm:grid-cols-12 sm:gap-2 px-4 py-1.5 text-[10px] font-bold uppercase tracking-wide text-ink-light border-b border-border-soft">
          <div className="sm:col-span-4">{vi ? 'Sản phẩm' : 'Produit'}</div>
          <div className="sm:col-span-1 text-center">{vi ? 'Đặt' : 'Cmd'}</div>
          <div className="sm:col-span-3">{vi ? 'Bếp → kho (cả ngày)' : 'Cuisine → stock (journée)'}</div>
          <div className="sm:col-span-4 text-center">{vi ? 'Kiểm' : 'Check'}</div>
        </div>
      )}
      <div className="divide-y divide-border-soft">
        {items.map(l => {
          const st = state[l.id] ?? { qty: String(l.qty_expected), reason: '', note: '' };
          const qty = Number(st.qty);
          const diff = qty - l.qty_expected;
          const isDiff = diff !== 0;
          const needsReason = isDiff && !isWeighedEntry(qty);
          const isChecked = checked.has(l.id);
          const isHidden = hiddenFromPrint[l.id] ?? l.hidden_from_print;
          return (
            <div key={l.id} className="px-4 py-2.5"
              // Checked but the expected qty has since moved (Odoo changed it after this line
              // was validated — see odoo-apply.ts's qty_expected sync doc comment, 2026-08-13
              // REP/2026/01021) → amber instead of green, so the mismatch is visible at a glance
              // instead of only in the small "(±X)" text next to the checked value.
              style={{ backgroundColor: isChecked ? (isDiff ? '#FFFBEB' : '#F0FDF4') : isDiff ? '#FEF2F2' : undefined }}>
              {/* Mobile: stacked (full-width, larger, wrapping name on its own row, qty+check
                  below) — the old single-row 12-col grid squeezed the name into ~5/12 of a phone
                  screen width, truncating it with "…" (2026-08-28, Axel: "améliorer la visibilité
                  des... noms des produits" on the delivery-check phone view). sm:contents on the
                  qty+check wrapper makes it transparent to the grid from tablet/desktop up, so
                  that layout is untouched — only phones (<640px) get the stacked version. */}
              <div className="flex flex-col gap-2 sm:grid sm:grid-cols-12 sm:items-center sm:gap-2">
                <div className={`${withProd ? 'sm:col-span-4' : 'sm:col-span-5'} min-w-0`}>
                  <div className="text-base font-semibold text-navy leading-snug sm:text-sm sm:font-normal sm:truncate">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)}</div>
                  {l.sku && <div className="text-[11px] text-ink-light font-mono">{l.sku}</div>}
                  {l.note && (
                    <div className="text-[11px] font-semibold mt-0.5 whitespace-pre-line" style={{ color: '#B45309' }}>
                      📝 {l.note}
                    </div>
                  )}
                  {withProd && <div className="sm:hidden mt-1"><ProdCell s={l.sku ? prod![l.sku] : undefined} family={l.product_category} vi={vi} /></div>}
                </div>
                <div className="flex items-center justify-between gap-2 sm:contents">
                <div className={`${withProd ? 'sm:col-span-1' : 'sm:col-span-2'} text-center font-bold text-navy`}>×{l.qty_expected}</div>
                {withProd && <div className="hidden sm:block sm:col-span-3 min-w-0"><ProdCell s={l.sku ? prod![l.sku] : undefined} family={l.product_category} vi={vi} /></div>}
                <div className={`${withProd ? 'sm:col-span-4' : 'sm:col-span-5'} flex items-center justify-center gap-2`}>
                  {isChecked ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: '#059669' }}>
                        <CheckCircle2 size={16} /> ×{st.qty}{isDiff && <span style={{ color: '#DC2626' }}> ({diff > 0 ? '+' : ''}{fmtDiff(diff)})</span>}
                      </span>
                      {/* Hide/show on the printed slip — never touches the tracked qty, only
                          whether the client-facing document shows this line (2026-08-14, Axel:
                          a wrong SKU checked to 0 after a mistake shouldn't confuse the client).
                          Available regardless of validated state, unlike the pencil edit. */}
                      <button onClick={() => toggleHidden(l.id, !isHidden)}
                        className="w-6 h-6 flex items-center justify-center rounded-lg shrink-0"
                        style={{ border: '1px solid', borderColor: isHidden ? '#FCA5A5' : '#D1D5DB', color: isHidden ? '#DC2626' : undefined }}
                        title={vi ? (isHidden ? 'Hiện khi in' : 'Ẩn khi in') : (isHidden ? 'Afficher à l\'impression' : 'Masquer à l\'impression')}
                        aria-label={vi ? 'Ẩn khi in' : 'Masquer à l\'impression'}>
                        {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      {!validated && (
                        <button onClick={() => setChecked(p => { const n = new Set(p); n.delete(l.id); return n; })}
                          className="w-6 h-6 flex items-center justify-center rounded-lg shrink-0" style={{ border: '1px solid #D1D5DB' }}
                          title={vi ? 'Sửa' : 'Modifier'} aria-label={vi ? 'Sửa' : 'Modifier'}>
                          <Pencil size={12} />
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <input type="number" value={st.qty} onChange={e => upd(l.id, { qty: e.target.value })}
                        className="w-14 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                        style={{ border: '1px solid', borderColor: isDiff ? '#F87171' : '#D1D5DB' }} />
                      {isDiff && <span className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>{diff > 0 ? '+' : ''}{fmtDiff(diff)}</span>}
                      <button onClick={() => checkLine(l)} disabled={savingLine === l.id || (needsReason && !st.reason)}
                        className="text-xs font-bold px-2.5 py-1.5 rounded-lg text-white shrink-0 disabled:opacity-40"
                        style={{ backgroundColor: '#16A34A' }}>
                        {savingLine === l.id ? '…' : (vi ? 'OK' : 'OK')}
                      </button>
                    </>
                  )}
                </div>
                </div>
              </div>
              {needsReason && !isChecked && (
                <div className="mt-2 flex flex-col sm:flex-row gap-2">
                  <select value={st.reason} onChange={e => upd(l.id, { reason: e.target.value })}
                    className="rounded-lg px-2 py-1.5 text-sm sm:w-56"
                    style={{ border: '1px solid', borderColor: st.reason ? '#D1D5DB' : '#F87171', backgroundColor: 'white' }}>
                    <option value="">{vi ? '— Lý do —' : '— Raison —'}</option>
                    {REASONS.map(r => <option key={r.v} value={r.v}>{vi ? r.vi : r.en}</option>)}
                  </select>
                  <input type="text" value={st.note} onChange={e => upd(l.id, { note: e.target.value })}
                    placeholder={vi ? 'Ghi chú (tuỳ chọn)' : 'Note (optionnel)'}
                    className="flex-1 rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DeliveryCheckOrderView({ header, lines, backHref, onlineInfo, destination, prodBySku }: { header: DeliveryOrderHeader; lines: CheckLine[]; backHref: string; onlineInfo?: OnlineOrderCheckInfo | null; destination?: DeliveryDestination | null; prodBySku?: Record<string, ProdStatus> | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [state, setState] = useState<Record<string, { qty: string; reason: string; note: string }>>(() => {
    const s: Record<string, { qty: string; reason: string; note: string }> = {};
    for (const l of lines) s[l.id] = {
      qty: String(l.qty_checked ?? l.qty_expected),
      reason: l.discrepancy_reason ?? '',
      note: l.discrepancy_note ?? '',
    };
    return s;
  });
  const [checked, setChecked] = useState<Set<string>>(() => new Set(lines.filter(l => l.qty_checked != null).map(l => l.id)));
  const [savingLine, setSavingLine] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(header.status === 'validated');
  const [validateError, setValidateError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [hiddenFromPrint, setHiddenFromPrint] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(lines.map(l => [l.id, l.hidden_from_print])));
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ text: string; error?: boolean } | null>(null);
  // "Ne sera pas livrée" — app-only, réversible, aucun impact Odoo (Axel, 2026-09-18).
  const [markedNotDelivered, setMarkedNotDelivered] = useState(header.marked_not_delivered);
  const [togglingNotDelivered, setTogglingNotDelivered] = useState(false);

  const upd = (id: string, patch: Partial<{ qty: string; reason: string; note: string }>) =>
    setState(p => ({ ...p, [id]: { ...p[id], ...patch } }));

  // Optimistic — flips immediately, server action fires in the background (best-effort, same
  // pattern as markPrintedAction). Doesn't touch qty/status, so nothing else depends on it
  // actually landing before continuing.
  function toggleHidden(id: string, hidden: boolean) {
    setHiddenFromPrint(p => ({ ...p, [id]: hidden }));
    import('../../actions').then(({ toggleHideFromPrintAction }) => toggleHideFromPrintAction(id, hidden));
  }

  async function checkLine(l: CheckLine) {
    const st = state[l.id]; const qty = Number(st?.qty);
    if (qty !== l.qty_expected && !isWeighedEntry(qty) && !st?.reason) return;
    setSavingLine(l.id);
    const { checkLineAction } = await import('../../actions');
    const res = await checkLineAction(l.id, qty, st?.reason || null, st?.note || null);
    setSavingLine(null);
    if (res.ok) setChecked(p => new Set(p).add(l.id));
  }

  async function validate() {
    setValidating(true); setValidateError(null);
    const { validateOrderAction } = await import('../../actions');
    const res = await validateOrderAction(header.id);
    setValidating(false);
    if (res.ok) setValidated(true); else setValidateError(res.error ?? 'Error');
  }

  async function unlock() {
    setUnlocking(true);
    const { unlockOrderAction } = await import('../../actions');
    const res = await unlockOrderAction(header.id);
    setUnlocking(false);
    if (res.ok) setValidated(false);
  }

  async function toggleNotDelivered() {
    setTogglingNotDelivered(true);
    const next = !markedNotDelivered;
    const { setMarkedNotDeliveredAction } = await import('../../actions');
    const res = await setMarkedNotDeliveredAction(header.id, next);
    setTogglingNotDelivered(false);
    if (res.ok) setMarkedNotDelivered(next);
  }

  // Manual "Sync Odoo" for when an assistant can't find a product that should be on this order
  // (Axel, 2026-08-16) — same on-demand sync the station pages already have, just triggered from
  // here so nobody has to wait for the next 15-min cron pass. Read-only from this component's
  // point of view: it only pulls fresher data in, router.refresh() re-fetches this same page's
  // server data afterward so any newly-synced line shows up without a full reload.
  async function syncOdoo() {
    setSyncing(true); setSyncMsg(null);
    const { syncOdooForDeliveryCheckAction } = await import('../../actions');
    const res = await syncOdooForDeliveryCheckAction(header.delivery_date, header.order_ref);
    setSyncing(false);
    if (res.error) setSyncMsg({ text: vi ? 'Lỗi đồng bộ' : 'Erreur de synchro', error: true });
    else { setSyncMsg({ text: vi ? 'Đã đồng bộ' : 'Synchronisé' }); router.refresh(); }
    setTimeout(() => setSyncMsg(null), 4000);
  }

  const production = lines.filter(l => l.category === 'production');
  const packaging = lines.filter(l => l.category === 'packaging');
  const total = lines.length;
  const doneCount = lines.filter(l => checked.has(l.id)).length;
  const allChecked = total > 0 && doneCount === total;

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-ink-light hover:text-navy">
        <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
      </Link>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <div>
            <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy">{header.order_ref}</h1>
            <p className="text-ink-light text-sm">{header.shop_name} · {header.delivery_date}</p>
            {/* "Commande de X — à livrer à Y" (Axel, 2026-09-22) — a manual/online/birthday cake
                whose actual delivery destination (lab_manual_cakes.delivered_by) differs from
                the shop this order is attributed to. Unconditional (not inside the validated/
                not-validated branches below), so it stays visible before the check, during it,
                and once the order hits 100% — an assistant printing or handing this off should
                never lose sight of where it actually goes. */}
            {destination?.mismatch && (
              <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold"
                style={{ backgroundColor: '#F5F3FF', border: '1px solid #C4B5FD', color: '#6D28D9' }}>
                <ArrowRightLeft size={13} className="shrink-0" />
                {vi
                  ? `Đơn của ${header.shop_name} — GIAO ĐẾN ${destination.actualShop}`
                  : `Commande de ${header.shop_name} — À LIVRER À ${destination.actualShop}`}
              </div>
            )}
            {/* Online-sale customer details (Axel, 2026-09-09) — name, delivery mode (via the
                shop vs lab-direct-to-customer) and address, for an order placed through the
                online-sales interface. Never shown on the print view — this is the detail
                screen only (DeliveryPrintView.tsx is a separate component/route). */}
            {onlineInfo && (
              <div className="mt-1.5 inline-flex flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-xs"
                style={{ backgroundColor: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E3A5F' }}>
                <div className="font-semibold">
                  🛍 {vi ? 'Đơn online' : 'Commande en ligne'}
                  {onlineInfo.customerName ? ` · ${onlineInfo.customerName}` : ''}
                  {onlineInfo.customerPhone ? ` · ${onlineInfo.customerPhone}` : ''}
                </div>
                <div>
                  {onlineInfo.deliveryMode === 'direct'
                    ? (vi ? '🚚 Lab giao thẳng cho khách' : '🚚 Livraison directe par le lab')
                    : (vi ? '🏪 Giao qua shop' : '🏪 Livraison via le shop')}
                  {onlineInfo.deliveryAddress ? ` · ${onlineInfo.deliveryAddress}` : ''}
                </div>
              </div>
            )}
          </div>
          {/* Manual Odoo resync — an assistant who can't find a product she expects on this
              order doesn't have to wait for the next cron pass (2026-08-16, Axel). */}
          <button onClick={syncOdoo} disabled={syncing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 disabled:opacity-50"
            style={{ border: '1px solid #D1D5DB', color: '#374151' }}
            title={vi ? 'Không thấy sản phẩm? Đồng bộ lại Odoo' : "Produit manquant ? Resynchroniser Odoo"}>
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? (vi ? 'Đang đồng bộ…' : 'Synchro…') : (vi ? 'Đồng bộ Odoo' : 'Sync Odoo')}
          </button>
          {syncMsg && <span className="text-xs font-semibold" style={{ color: syncMsg.error ? '#DC2626' : '#166534' }}>{syncMsg.text}</span>}
        </div>
        {validated ? (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5" style={{ backgroundColor: '#DCFCE7', color: '#166534' }}>
              <CheckCircle2 size={16} /> {vi ? 'Đã xác nhận' : 'Validé'}
            </span>
            {/* Odoo delivery validation status (Axel, 2026-08-17) — a distinct badge from the
                checklist "Validé" above: that one only means every line was checked in the app,
                this one means the delivered quantities were actually written back to Odoo and
                the picking validated, i.e. the full process Axel wants assistants to never skip. */}
            {(header.odoo_push_status === 'validated' || header.odoo_push_status === 'already_done') && (
              <span className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}
                title={header.odoo_validated_by_name ? `${vi ? 'Xác nhận bởi' : 'Validé par'} ${header.odoo_validated_by_name}` : undefined}>
                <CheckCheck size={16} /> {vi ? 'Đã xử lý xong 100%' : 'Traité à 100%'}
              </span>
            )}
            {markedNotDelivered ? (
              // Marquage local "ne sera pas livrée" (Axel, 2026-09-18) — commande clôturée sur
              // Odoo avec 0 unité livrée car elle ne sera jamais réellement livrée (Odoo ne
              // permet pas de supprimer une commande). Cliquer annule le marquage (réversible).
              <button onClick={toggleNotDelivered} disabled={togglingNotDelivered}
                className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5 disabled:opacity-50"
                style={{ backgroundColor: '#FEE2E2', color: '#B91C1C' }}
                title={vi ? 'Nhấn để hủy đánh dấu' : 'Cliquer pour annuler ce marquage'}>
                <CheckCheck size={16} /> {vi ? 'Đã xử lý 100% (không giao)' : 'Traité à 100% (non livrée)'}
              </button>
            ) : header.odoo_push_status !== 'validated' && header.odoo_push_status !== 'already_done' && (
              <>
                {/* Le lien "valider sur Odoo" n'a de sens qu'une fois imprimé (c'est le flux
                    impression -> validation) — mais "Ne sera pas livrée" doit rester
                    disponible AVANT l'impression aussi : une commande qu'on sait déjà ne
                    jamais livrer n'a souvent aucune raison d'être imprimée du tout (Axel,
                    2026-09-18 — le bouton n'apparaissait qu'après impression, ce qui ratait
                    exactement ce cas). */}
                {header.printed_at && (
                  <Link href={`/delivery-print?date=${header.delivery_date}&orderRef=${encodeURIComponent(header.order_ref)}&validate=1`}
                    className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5"
                    style={{ backgroundColor: header.odoo_push_status === 'error' ? '#FEE2E2' : '#FEF2F2', color: '#B91C1C' }}
                    title={header.odoo_push_error ?? undefined}>
                    <AlertTriangle size={15} /> {vi ? 'Cần xác nhận trên Odoo' : 'À valider sur Odoo'}
                  </Link>
                )}
                {/* Commande clôturée sur Odoo à 0 livré car elle ne sera jamais réellement
                    livrée — bouton purement local/réversible, aucun impact Odoo (Axel,
                    2026-09-18). */}
                <button onClick={toggleNotDelivered} disabled={togglingNotDelivered}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-3 py-1.5 disabled:opacity-50"
                  style={{ border: '1px solid #D1D5DB', color: '#374151' }}
                  title={vi ? 'Đơn sẽ không giao (đã xử lý trên Odoo với số lượng 0)' : 'Ne sera pas livrée (clôturée sur Odoo à 0)'}>
                  {togglingNotDelivered ? '…' : (vi ? 'Không giao' : 'Ne sera pas livrée')}
                </button>
              </>
            )}
            {header.printed_at && (
              <span className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5" style={{ backgroundColor: '#DBEAFE', color: '#1D4ED8' }}
                title={header.printed_by_name ? `${vi ? 'In bởi' : 'Imprimé par'} ${header.printed_by_name}` : undefined}>
                <Printer size={15} /> {vi ? 'Đã in' : 'Déjà imprimé'}{header.print_count > 1 ? ` ×${header.print_count}` : ''}
              </span>
            )}
            <Link href={`/delivery-print?date=${header.delivery_date}&orderRef=${encodeURIComponent(header.order_ref)}`}
              className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5 text-white"
              style={{ backgroundColor: '#1f2937' }}>
              <Printer size={15} /> {header.source_type === 'replenishment' ? (vi ? 'In phiếu LAB/OUT' : 'Imprimer LAB/OUT') : (vi ? 'In hóa đơn bán hàng' : 'Imprimer hóa đơn bán hàng')}
            </Link>
            {/* Re-open a validated order to fix a line and re-validate (Axel, 2026-08-14) —
                doesn't clear any checked qty, just unlocks editing again. */}
            <button onClick={unlock} disabled={unlocking}
              className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5 disabled:opacity-50"
              style={{ border: '1px solid #D1D5DB', color: '#374151' }}
              title={vi ? 'Mở lại để sửa' : 'Rouvrir pour corriger'}>
              <Pencil size={14} /> {unlocking ? '…' : (vi ? 'Sửa lại' : 'Modifier')}
            </button>
          </div>
        ) : (
          <span className="text-sm font-semibold rounded-full px-3 py-1.5"
            style={{ backgroundColor: allChecked ? '#DCFCE7' : '#F3F4F6', color: allChecked ? '#166534' : '#6B7280' }}>
            {doneCount}/{total} {vi ? 'đã kiểm' : 'vérifiés'}
          </span>
        )}
      </div>

      <Section title={vi ? 'Sản phẩm sản xuất' : 'Produits fabriqués'} icon={PackageCheck} items={production}
        state={state} checked={checked} savingLine={savingLine} validated={validated} vi={vi} upd={upd} checkLine={checkLine} setChecked={setChecked}
        hiddenFromPrint={hiddenFromPrint} toggleHidden={toggleHidden} prod={prodBySku ?? null} />
      <Section title={vi ? 'Bao bì / khác' : 'Packaging / divers'} icon={Box} items={packaging}
        state={state} checked={checked} savingLine={savingLine} validated={validated} vi={vi} upd={upd} checkLine={checkLine} setChecked={setChecked}
        hiddenFromPrint={hiddenFromPrint} toggleHidden={toggleHidden} />

      {!validated && (
        <div className="card px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm text-ink-light">
            {allChecked ? (vi ? 'Tất cả đã kiểm — sẵn sàng xác nhận' : 'Tout est vérifié — prêt à valider')
              : (vi ? `Còn ${total - doneCount} sản phẩm` : `${total - doneCount} produit(s) restant(s)`)}
          </span>
          <div className="flex items-center gap-2">
            {validateError && <span className="text-xs font-semibold flex items-center gap-1" style={{ color: '#DC2626' }}><AlertTriangle size={13} /> {validateError}</span>}
            <button onClick={validate} disabled={!allChecked || validating}
              className="px-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-40"
              style={{ backgroundColor: '#16A34A' }}>
              {validating ? '…' : (vi ? 'Xác nhận' : 'Valider')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
