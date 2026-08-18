'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, Printer, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import type { CheckLine, DeliveryOrderHeader } from '@/lib/delivery-check';
import { formatOdooStyleDate, withWarehouseSuffix } from '@/lib/delivery-print';
import type { SoLinePricing } from '@/lib/odoo-so-pricing';
import type { NeedsSplitEntry, PlannedWrite, SplitInput } from '@/lib/odoo-delivery-validate';

// Reproduces the Odoo "Picking Operations" LAB/OUT export as closely as possible for
// replenishment orders (validated against a real export, LAB/OUT/03078 REP/2026/00997, with
// Axel on 2026-08-11), and a simpler "HÓA ĐƠN BÁN HÀNG" printout for sales orders (2026-08-11:
// titled "HÓA ĐƠN BÁN HÀNG" + the SO number — not the earlier "HÓA ĐƠN TẠM" proposal — amount
// computed on DELIVERED qty, not the customer's ordered qty).
//
// "Ghi chú" shows the product's own Odoo note (lab_delivery_check_lines.note) plus the
// assistant's discrepancy note if any, stacked on separate lines.
export default function DeliveryPrintView({ header, lines, pricing }: {
  header: DeliveryOrderHeader; lines: CheckLine[]; pricing?: SoLinePricing | null;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const isSo = header.source_type === 'sales_order';
  const showPricing = isSo && !!pricing && Object.keys(pricing.bySku).length > 0;
  // hidden_from_print (2026-08-14, Axel) — a checked line an assistant deliberately hid (e.g. a
  // wrong SKU checked to 0 after a mistake) is filtered out everywhere on this printout,
  // including the subtotal/tax sums below — a hidden row but a total that still silently
  // accounts for it would be its own source of client confusion.
  const printLines = lines.filter(l => !l.hidden_from_print);

  const fmtMoney = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n));

  // Subtotal (untaxed) + VAT, both based on DELIVERED qty like every per-line amount here.
  // VAT is summed per-line at each line's OWN rate (see odoo-so-pricing.ts's taxRate doc
  // comment — confirmed live that tax can differ line-to-line on the same order, e.g. a
  // tax-exempt product mixed with 8%-taxed ones), never a single order-wide percentage.
  let subtotal = 0, vatTotal = 0;
  if (showPricing) {
    for (const l of printLines) {
      const p = pricing!.bySku[l.sku ?? ''];
      if (!p) continue;
      const untaxed = p.unitPrice * (l.qty_checked ?? l.qty_expected);
      subtotal += untaxed;
      vatTotal += untaxed * p.taxRate;
    }
  }
  const grandTotal = subtotal + vatTotal;
  // Shown in the "Thuế GTGT (X%)" label — computed from the actual blended rate (vatTotal/
  // subtotal), NOT hardcoded to 8%: a mixed-rate order (confirmed live, S03135 — one tax-exempt
  // line alongside 8%-taxed ones) will show its true blended rate here (e.g. "7.58%") instead of
  // a misleading flat "8%", while the normal single-rate case still shows a clean "8%".
  const vatPct = subtotal > 0 ? Math.round((vatTotal / subtotal) * 10000) / 100 : 0;

  // "Valider la livraison sur Odoo" (Axel, 2026-08-17) — mandatory pop-up right after printing,
  // REP orders only for this pilot phase (sales orders + invoice creation come later). Two-step
  // confirmation, never a single blind write: dryRun=true first (preview + surface any needsSplit
  // requirement), then dryRun=false only once the assistant has explicitly confirmed the preview.
  const [validateOpen, setValidateOpen] = useState(false);
  const [step, setStep] = useState<'choice' | 'loading' | 'split' | 'preview' | 'success' | 'error'>('choice');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [needsSplit, setNeedsSplit] = useState<NeedsSplitEntry[]>([]);
  const [splitValues, setSplitValues] = useState<Record<string, Record<number, string>>>({});
  const [plan, setPlan] = useState<PlannedWrite[]>([]);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [pickingName, setPickingName] = useState<string | null>(null);

  function buildSplits(): SplitInput[] {
    return needsSplit.map(ns => ({
      sku: ns.sku,
      allocations: ns.lines.map(l => ({ moveId: l.moveId, qty: Number(splitValues[ns.sku]?.[l.moveId] ?? 0) })),
    }));
  }

  async function runDryRun(fromSplitScreen = false) {
    setStep('loading'); setErrorMsg(null); setSplitError(null);
    const { validateDeliveryOnOdooAction } = await import('@/app/(app)/delivery-check/actions');
    const res = await validateDeliveryOnOdooAction(header.id, true, buildSplits());
    if (res.needsSplit?.length) {
      setNeedsSplit(res.needsSplit);
      // Prefill with each line's own original expected qty — the natural starting point an
      // assistant then adjusts down for whichever line actually fell short.
      setSplitValues(p => {
        const next = { ...p };
        for (const ns of res.needsSplit!) if (!next[ns.sku]) next[ns.sku] = Object.fromEntries(ns.lines.map(l => [l.moveId, String(l.expectedQty)]));
        return next;
      });
      setStep('split');
      return;
    }
    if (!res.ok) {
      // A split submitted from the split screen that doesn't sum correctly comes back as a
      // plain error (not needsSplit again) — show it inline, right there, instead of jumping to
      // the generic error screen and losing everything she just typed.
      if (fromSplitScreen) { setSplitError(res.error ?? (vi ? 'Lỗi không xác định' : 'Erreur inconnue')); setStep('split'); return; }
      setErrorMsg(res.error ?? (vi ? 'Lỗi không xác định' : 'Erreur inconnue')); setStep('error'); return;
    }
    setPlan(res.plan ?? []); setAlreadyDone(!!res.alreadyDoneOnOdoo); setPickingName(res.pickingName ?? null);
    setStep('preview');
  }

  async function confirmReal() {
    setStep('loading'); setErrorMsg(null);
    const { validateDeliveryOnOdooAction } = await import('@/app/(app)/delivery-check/actions');
    const res = await validateDeliveryOnOdooAction(header.id, false, buildSplits());
    if (!res.ok) { setErrorMsg(res.error ?? (vi ? 'Lỗi không xác định' : 'Erreur inconnue')); setStep('error'); return; }
    setAlreadyDone(!!res.alreadyDoneOnOdoo); setPickingName(res.pickingName ?? null);
    setStep('success');
  }

  function closeAndReturn() {
    setValidateOpen(false); setStep('choice');
    window.location.href = `/delivery-check/${header.delivery_date}/${header.order_ref}`;
  }

  async function handlePrint() {
    // Fire the "already printed" mark alongside the print dialog — doesn't block printing if
    // the request is slow/fails, this is a nice-to-have color-code, not a gate (2026-08-11).
    try {
      const { markPrintedAction } = await import('@/app/(app)/delivery-check/actions');
      markPrintedAction(header.id);
    } catch { /* best-effort */ }
    window.print();
    // REP only for this pilot phase — sales orders don't get the pop-up yet (Axel, 2026-08-17).
    if (!isSo) { setValidateOpen(true); setStep('choice'); }
  }

  return (
    <div>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 10mm 12mm; size: A4; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        .labprint-table { border-collapse: collapse; width: 100%; }
        .labprint-table th, .labprint-table td { border: 1px solid #000; padding: 3px 5px; }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-white border-b border-border-soft px-4 py-2 flex items-center justify-between gap-4 shadow-sm">
        <Link href={`/delivery-check/${header.delivery_date}/${header.order_ref}`}
          className="flex items-center gap-1.5 text-sm text-ink-light hover:text-navy transition-colors">
          <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
        </Link>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-light hidden sm:inline">
            {vi ? 'Nhiều sản phẩm → dùng "Vừa 1 trang" trong hộp thoại in nếu cần' : 'Beaucoup de lignes → cocher "Ajuster à la page" dans le dialogue d\'impression si besoin'}
          </span>
          <button onClick={handlePrint}
            className="flex items-center gap-1.5 text-sm font-semibold text-white bg-navy rounded-xl px-4 py-2 hover:bg-navy/80 transition-colors">
            <Printer size={15} /> {vi ? 'In phiếu' : 'Imprimer'}
          </button>
        </div>
      </div>

      <div style={{ background: '#fff', color: '#111', maxWidth: '720px', margin: '24px auto', padding: '20px 28px', fontFamily: "'Times New Roman', serif", fontSize: 13 }}>
        <div style={{ textAlign: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-print.png" alt="La Paris" style={{ height: 56, margin: '0 auto' }} />
          <div style={{ fontSize: 12.5, lineHeight: 1.4, marginTop: 4 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>CÔNG TY CỔ PHẦN LA PARISIENNE</div>
            <div>Địa chỉ: 18 Phú Xá, Phường Phú Thượng, TP Hà Nội, Việt Nam</div>
            <div>SĐT: 0985023553&nbsp;&nbsp;&nbsp;&nbsp;Email: Laparisiene09@gmail.com</div>
            <div>Ngân hàng Techcombank : 609609 mở tại TCB Lạc Long Quân.</div>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 18, fontWeight: 500, margin: '10px 0 8px' }}>
          {isSo ? `HÓA ĐƠN BÁN HÀNG — ${header.order_ref}` : 'Lệnh giao hàng'}
        </div>

        <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
          <div>Số phiếu:</div>
          <div>Khách hàng:</div>
          <div>Từ: Lab&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Đến: {withWarehouseSuffix(header.shop_name)}</div>
          <div>SĐT:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Email:</div>
          <div>Ngày giao hàng: {formatOdooStyleDate(header.delivery_date)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Tài liệu gốc: {header.order_ref}</div>
        </div>

        <table className="labprint-table" style={{ marginTop: 10, fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'center' }}>
              <th style={{ width: '4%' }}>STT</th>
              <th style={{ width: showPricing ? '28%' : '38%' }}>Mã hàng</th>
              <th style={{ width: '8%' }}>ĐVT</th>
              <th style={{ width: '10%' }}>S.L Yêu cầu</th>
              <th style={{ width: '10%' }}>S.L Thực tế</th>
              {showPricing && <th style={{ width: '12%' }}>Đơn giá</th>}
              {showPricing && <th style={{ width: '13%' }}>Thành tiền</th>}
              <th style={{ width: showPricing ? '15%' : '30%' }}>Ghi chú</th>
            </tr>
          </thead>
          <tbody>
            {printLines.map((l, i) => {
              const delivered = l.qty_checked ?? l.qty_expected;
              const unit = showPricing ? pricing!.bySku[l.sku ?? '']?.unitPrice : undefined;
              return (
                <tr key={l.id}>
                  <td style={{ textAlign: 'center' }}>{i + 1}</td>
                  <td>{l.product_name_vi}</td>
                  <td style={{ textAlign: 'center' }}>Đơn vị</td>
                  <td style={{ textAlign: 'center' }}>{l.qty_expected}</td>
                  <td style={{ textAlign: 'center' }}>{delivered}</td>
                  {showPricing && <td style={{ textAlign: 'right' }}>{unit != null ? fmtMoney(unit) : ''}</td>}
                  {showPricing && <td style={{ textAlign: 'right' }}>{unit != null ? fmtMoney(unit * delivered) : ''}</td>}
                  <td style={{ fontSize: 10.5, whiteSpace: 'pre-line' }}>{[l.note, l.discrepancy_note].filter(Boolean).join('\n')}</td>
                </tr>
              );
            })}
          </tbody>
          {showPricing && (
            <tfoot>
              <tr>
                <td colSpan={6} style={{ textAlign: 'right' }}>Tổng tiền hàng ({pricing!.currency})</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(subtotal)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={6} style={{ textAlign: 'right' }}>Thuế GTGT ({vatPct}%)</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(vatTotal)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={6} style={{ textAlign: 'right', fontWeight: 700 }}>Tổng cộng ({pricing!.currency})</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtMoney(grandTotal)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28, fontSize: 13 }}>
          <div>Khách hàng</div>
          <div>Người lập phiếu</div>
        </div>
      </div>

      {validateOpen && (
        <div className="no-print" style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.55)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 16, maxWidth: 480, width: '100%', maxHeight: '85vh', overflowY: 'auto', padding: 24 }}>
            {step === 'choice' && (
              <>
                <h2 className="font-serif text-lg font-bold text-navy mb-2">
                  {vi ? 'Xác nhận giao hàng trên Odoo?' : 'Valider la livraison sur Odoo ?'}
                </h2>
                <p className="text-sm text-ink-light mb-5">
                  {vi
                    ? 'Bước cuối cùng: cập nhật số lượng đã giao trên Odoo. Bắt buộc để hoàn tất quy trình.'
                    : "Dernière étape : met à jour les quantités livrées sur Odoo. Obligatoire pour clore le process."}
                </p>
                <div className="flex flex-col gap-2">
                  <button onClick={() => runDryRun()} className="w-full py-2.5 rounded-xl font-bold text-white text-sm" style={{ backgroundColor: '#16A34A' }}>
                    {vi ? 'Xác nhận giao hàng trên Odoo' : 'Valider la livraison sur Odoo'}
                  </button>
                  <button onClick={closeAndReturn} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {vi ? 'Quay lại đơn hàng' : 'Revenir à la commande'}
                  </button>
                </div>
              </>
            )}

            {step === 'loading' && (
              <div className="py-10 text-center text-sm text-ink-light">{vi ? 'Đang xử lý…' : 'Traitement en cours…'}</div>
            )}

            {step === 'split' && (
              <>
                <h2 className="font-serif text-lg font-bold text-navy mb-1 flex items-center gap-2">
                  <AlertTriangle size={18} style={{ color: '#D97706' }} />
                  {vi ? 'Cần phân bổ theo dòng' : 'Répartition nécessaire'}
                </h2>
                <p className="text-sm text-ink-light mb-4">
                  {vi
                    ? 'Sản phẩm này có nhiều dòng trên Odoo và số lượng không khớp — cho biết dòng nào bị thiếu/dư.'
                    : "Ce produit a plusieurs lignes sur Odoo et la quantité ne correspond pas — indique quelle(s) ligne(s) ont un écart."}
                </p>
                {splitError && (
                  <div className="text-xs font-semibold rounded-lg px-3 py-2 mb-3" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{splitError}</div>
                )}
                <div className="space-y-4 mb-4">
                  {needsSplit.map(ns => {
                    const values = splitValues[ns.sku] ?? {};
                    const sum = ns.lines.reduce((s, l) => s + Number(values[l.moveId] ?? 0), 0);
                    const ok = sum === ns.qtyChecked;
                    return (
                      <div key={ns.sku} className="rounded-xl p-3" style={{ border: '1px solid #E5E7EB' }}>
                        <div className="text-sm font-semibold text-navy mb-2">{ns.product_name_vi} — {vi ? 'tổng đã kiểm' : 'total coché'} {ns.qtyChecked}</div>
                        {ns.lines.map(l => (
                          <div key={l.moveId} className="flex items-center justify-between gap-2 mb-1.5">
                            <span className="text-xs text-ink-light flex-1 truncate">{l.note || (vi ? '(không ghi chú)' : '(sans note)')} — {vi ? 'dự kiến' : 'attendu'} {l.expectedQty}</span>
                            <input type="number" value={values[l.moveId] ?? ''}
                              onChange={e => setSplitValues(p => ({ ...p, [ns.sku]: { ...p[ns.sku], [l.moveId]: e.target.value } }))}
                              className="w-16 text-center rounded-lg px-2 py-1 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
                          </div>
                        ))}
                        <div className="text-xs font-semibold mt-1" style={{ color: ok ? '#059669' : '#DC2626' }}>
                          {vi ? 'Tổng' : 'Somme'}: {sum} / {ns.qtyChecked}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col gap-2">
                  <button onClick={() => runDryRun(true)}
                    disabled={needsSplit.some(ns => ns.lines.reduce((s, l) => s + Number((splitValues[ns.sku] ?? {})[l.moveId] ?? 0), 0) !== ns.qtyChecked)}
                    className="w-full py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-40" style={{ backgroundColor: '#16A34A' }}>
                    {vi ? 'Tiếp tục' : 'Continuer'}
                  </button>
                  <button onClick={closeAndReturn} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {vi ? 'Quay lại đơn hàng' : 'Revenir à la commande'}
                  </button>
                </div>
              </>
            )}

            {step === 'preview' && (
              <>
                <h2 className="font-serif text-lg font-bold text-navy mb-3">{vi ? 'Xem trước' : 'Aperçu'}</h2>
                {alreadyDone ? (
                  <p className="text-sm mb-4" style={{ color: '#166534' }}>
                    {vi ? `Đã được xác nhận trên Odoo (${pickingName}) — không cần làm gì thêm.` : `Déjà validé sur Odoo (${pickingName}) — rien à faire de plus.`}
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-ink-light mb-3">
                      {vi ? `Sẽ ghi trên Odoo (${pickingName}):` : `Sera écrit sur Odoo (${pickingName}) :`}
                    </p>
                    <div className="rounded-xl mb-4 overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                      {plan.map((p, i) => (
                        <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs" style={{ borderTop: i ? '1px solid #F3F4F6' : undefined }}>
                          <span className="text-ink-light truncate flex-1">{p.sku}{p.note ? ` · ${p.note}` : ''}</span>
                          <span className="font-bold text-navy">{p.deliverQty} / {p.expectedQty}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <div className="flex flex-col gap-2">
                  {!alreadyDone && (
                    <button onClick={confirmReal} className="w-full py-2.5 rounded-xl font-bold text-white text-sm" style={{ backgroundColor: '#16A34A' }}>
                      {vi ? 'Xác nhận — ghi vào Odoo' : 'Confirmer — écrire sur Odoo'}
                    </button>
                  )}
                  <button onClick={closeAndReturn} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {alreadyDone ? (vi ? 'Đóng' : 'Fermer') : (vi ? 'Quay lại đơn hàng' : 'Revenir à la commande')}
                  </button>
                </div>
              </>
            )}

            {step === 'success' && (
              <>
                <div className="flex items-center gap-2 mb-3" style={{ color: '#166534' }}>
                  <CheckCircle2 size={22} />
                  <h2 className="font-serif text-lg font-bold">{vi ? 'Đã xử lý xong 100%' : 'Traité à 100%'}</h2>
                </div>
                <p className="text-sm text-ink-light mb-5">
                  {alreadyDone
                    ? (vi ? 'Đơn hàng đã được xác nhận trên Odoo.' : 'La commande était déjà validée sur Odoo.')
                    : (vi ? `Số lượng đã được ghi và bàn giao trên Odoo (${pickingName}).` : `Quantités écrites et livraison validée sur Odoo (${pickingName}).`)}
                </p>
                <button onClick={closeAndReturn} className="w-full py-2.5 rounded-xl font-bold text-white text-sm" style={{ backgroundColor: '#16A34A' }}>
                  {vi ? 'Xong' : 'Terminé'}
                </button>
              </>
            )}

            {step === 'error' && (
              <>
                <div className="flex items-center gap-2 mb-3" style={{ color: '#DC2626' }}>
                  <X size={22} />
                  <h2 className="font-serif text-lg font-bold">{vi ? 'Lỗi' : 'Erreur'}</h2>
                </div>
                <p className="text-sm mb-5" style={{ color: '#DC2626' }}>{errorMsg}</p>
                <div className="flex flex-col gap-2">
                  <button onClick={() => runDryRun()} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {vi ? 'Thử lại' : 'Réessayer'}
                  </button>
                  <button onClick={closeAndReturn} className="w-full py-2.5 rounded-xl font-semibold text-sm" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                    {vi ? 'Quay lại đơn hàng' : 'Revenir à la commande'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
