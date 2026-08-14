'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, CheckCircle2, AlertTriangle, PackageCheck, Box, Pencil, Printer } from 'lucide-react';
import type { CheckLine, DeliveryOrderHeader } from '@/lib/delivery-check';
import { DELIVERY_CHECK_REASONS as REASONS } from '@/lib/delivery-check-reasons';

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
function Section({ title, icon: Icon, items, state, checked, savingLine, validated, vi, upd, checkLine, setChecked }: {
  title: string; icon: any; items: CheckLine[];
  state: Record<string, LineState>; checked: Set<string>; savingLine: string | null; validated: boolean; vi: boolean;
  upd: (id: string, patch: Partial<LineState>) => void;
  checkLine: (l: CheckLine) => void;
  setChecked: (fn: (p: Set<string>) => Set<string>) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
        <Icon size={16} className="text-navy" />
        <span className="text-sm font-bold text-navy">{title}</span>
        <span className="text-xs text-ink-light">· {items.filter(l => checked.has(l.id)).length}/{items.length}</span>
      </div>
      <div className="divide-y divide-border-soft">
        {items.map(l => {
          const st = state[l.id] ?? { qty: String(l.qty_expected), reason: '', note: '' };
          const qty = Number(st.qty);
          const diff = qty - l.qty_expected;
          const isDiff = diff !== 0;
          const needsReason = isDiff && !isWeighedEntry(qty);
          const isChecked = checked.has(l.id);
          return (
            <div key={l.id} className="px-4 py-2.5"
              // Checked but the expected qty has since moved (Odoo changed it after this line
              // was validated — see odoo-apply.ts's qty_expected sync doc comment, 2026-08-13
              // REP/2026/01021) → amber instead of green, so the mismatch is visible at a glance
              // instead of only in the small "(±X)" text next to the checked value.
              style={{ backgroundColor: isChecked ? (isDiff ? '#FFFBEB' : '#F0FDF4') : isDiff ? '#FEF2F2' : undefined }}>
              <div className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-5 min-w-0">
                  <div className="text-sm text-navy truncate">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)}</div>
                  {l.sku && <div className="text-[11px] text-ink-light font-mono">{l.sku}</div>}
                  {l.note && (
                    <div className="text-[11px] font-semibold mt-0.5 whitespace-pre-line" style={{ color: '#B45309' }}>
                      📝 {l.note}
                    </div>
                  )}
                </div>
                <div className="col-span-2 text-center font-bold text-navy">×{l.qty_expected}</div>
                <div className="col-span-5 flex items-center justify-center gap-2">
                  {isChecked ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: '#059669' }}>
                        <CheckCircle2 size={16} /> ×{st.qty}{isDiff && <span style={{ color: '#DC2626' }}> ({diff > 0 ? '+' : ''}{fmtDiff(diff)})</span>}
                      </span>
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

export default function DeliveryCheckOrderView({ header, lines, backHref }: { header: DeliveryOrderHeader; lines: CheckLine[]; backHref: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
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

  const upd = (id: string, patch: Partial<{ qty: string; reason: string; note: string }>) =>
    setState(p => ({ ...p, [id]: { ...p[id], ...patch } }));

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
        <div>
          <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy">{header.order_ref}</h1>
          <p className="text-ink-light text-sm">{header.shop_name} · {header.delivery_date}</p>
        </div>
        {validated ? (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="inline-flex items-center gap-1.5 text-sm font-bold rounded-full px-3 py-1.5" style={{ backgroundColor: '#DCFCE7', color: '#166534' }}>
              <CheckCircle2 size={16} /> {vi ? 'Đã xác nhận' : 'Validé'}
            </span>
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
        state={state} checked={checked} savingLine={savingLine} validated={validated} vi={vi} upd={upd} checkLine={checkLine} setChecked={setChecked} />
      <Section title={vi ? 'Bao bì / khác' : 'Packaging / divers'} icon={Box} items={packaging}
        state={state} checked={checked} savingLine={savingLine} validated={validated} vi={vi} upd={upd} checkLine={checkLine} setChecked={setChecked} />

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
