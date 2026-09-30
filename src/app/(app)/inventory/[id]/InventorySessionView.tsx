'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, Search, CheckCircle2, AlertTriangle, Loader2, Check, RotateCcw } from 'lucide-react';
import type { InventoryLineResult } from '@/lib/odoo-inventory';
import QtyExprInput from '@/components/QtyExprInput';
import { evalQty } from '@/lib/qty-expr';

type Product = {
  sku: string; product_name_vi: string; product_name_en: string | null;
  category: string; variant_label: string | null; fiche_id: string; variant_id: string;
};
type SavedLine = {
  id: string; sku: string; product_name_vi: string; product_name_en: string | null;
  category: string | null; qty_counted: number; qty_system: number | null;
  odoo_push_status: string | null; odoo_push_error: string | null;
};
type Session = { id: string; inventory_date: string; status: string; odoo_push_status: string | null; odoo_push_error: string | null };

// saved: the qty in the field is what the server has; error: last save failed (2026-09-30 — the
// first real LAB count lost everything because failed saves were silent).
type LineState = { qty: string; product_name_vi: string; product_name_en: string | null; category: string | null; fiche_id: string | null; variant_id: string | null; saving: boolean; saved?: boolean; error?: string | null };

const draftKey = (sessionId: string) => `lab_inventory_draft_${sessionId}`;

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

export default function InventorySessionView({
  session, products, initialLines, categories,
}: { session: Session; products: Product[]; initialLines: SavedLine[]; categories: string[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();

  const [step, setStep] = useState<'count' | 'recap' | 'success'>('count');
  const [activeCat, setActiveCat] = useState<string>(categories[0]);
  const [lines, setLines] = useState<Record<string, LineState>>(() => {
    const m: Record<string, LineState> = {};
    for (const p of products) {
      m[p.sku] = { qty: '', product_name_vi: p.product_name_vi, product_name_en: p.product_name_en, category: p.category, fiche_id: p.fiche_id, variant_id: p.variant_id, saving: false };
    }
    for (const l of initialLines) {
      m[l.sku] = {
        qty: String(l.qty_counted), product_name_vi: l.product_name_vi, product_name_en: l.product_name_en,
        category: l.category, fiche_id: m[l.sku]?.fiche_id ?? null, variant_id: m[l.sku]?.variant_id ?? null, saving: false,
        saved: true,
      };
    }
    return m;
  });
  const [extraCats, setExtraCats] = useState<string[]>(() =>
    Array.from(new Set(initialLines.filter(l => l.category && !categories.includes(l.category)).map(l => l.category as string)))
  );

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);

  const [inventoryDate, setInventoryDate] = useState(session.inventory_date || todayISO());
  const [recapLines, setRecapLines] = useState<InventoryLineResult[] | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [finalLines, setFinalLines] = useState<InventoryLineResult[] | null>(null);

  const allCats = [...categories, 'Autre'];

  // Backup of typed-but-not-yet-saved quantities in this browser, so leaving the page (another tab
  // of the app) never loses a count: restored on return, cleared line by line once saved.
  const [draftsRestored, setDraftsRestored] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey(session.id));
      const saved = raw ? JSON.parse(raw) as Record<string, string> : {};
      const skus = Object.keys(saved);
      if (skus.length) {
        setLines(prev => {
          const n = { ...prev };
          for (const sku of skus) if (n[sku] && typeof saved[sku] === 'string') n[sku] = { ...n[sku], qty: saved[sku], saved: false };
          return n;
        });
      }
    } catch { /* storage unavailable — nothing to restore */ }
    setDraftsRestored(true);
  }, [session.id]);
  useEffect(() => {
    if (!draftsRestored) return;
    try {
      const pending: Record<string, string> = {};
      for (const [sku, st] of Object.entries(lines)) if (!st.saved && st.qty.trim() !== '') pending[sku] = st.qty;
      if (Object.keys(pending).length) localStorage.setItem(draftKey(session.id), JSON.stringify(pending));
      else localStorage.removeItem(draftKey(session.id));
    } catch { /* ignore */ }
  }, [lines, draftsRestored, session.id]);

  async function saveQty(sku: string, raw: string) {
    const state = lines[sku];
    if (!state) return;
    const trimmed = raw.trim();
    setLines(p => ({ ...p, [sku]: { ...p[sku], qty: trimmed } }));
    if (trimmed === '') return; // don't save empty — leaves it as "not counted"
    // Mini calculator (2026-09-30, same as OEM): "12+3+50", "12×24+7". An invalid expression
    // stays red in the field and is NOT saved; a valid one is replaced by its result.
    const qty = evalQty(trimmed);
    if (qty === null || !Number.isFinite(qty)) return;
    setLines(p => ({ ...p, [sku]: { ...p[sku], qty: String(qty), saving: true, error: null } }));
    let err: string | null = null;
    try {
      const { saveLineAction } = await import('../actions');
      const res = await saveLineAction(session.id, {
        fiche_id: state.fiche_id, variant_id: state.variant_id, sku,
        product_name_vi: state.product_name_vi, product_name_en: state.product_name_en,
        category: state.category, qty_counted: qty,
      });
      if (res?.error) err = res.error;
    } catch (e: any) {
      err = String(e?.message ?? e) || 'Network error';
    }
    // only mark saved if the field still holds the value we just sent (the user may have retyped)
    setLines(p => ({ ...p, [sku]: { ...p[sku], saving: false, error: err, saved: !err && p[sku].qty === String(qty) } }));
  }

  async function runSearch(q: string) {
    setSearch(q);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const res = await fetch(`/api/lab/products-search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } finally {
      setSearching(false);
    }
  }

  function addFromSearch(hit: any, variant: any) {
    if (!variant?.sku) return;
    const category = hit.category_id || 'Autre';
    setLines(p => ({
      ...p,
      [variant.sku]: {
        qty: '', product_name_vi: hit.name_vi, product_name_en: hit.name_en ?? null,
        category, fiche_id: hit.id, variant_id: variant.id, saving: false,
      },
    }));
    if (!allCats.includes(category)) setExtraCats(p => Array.from(new Set([...p, category])));
    setActiveCat(category);
    setSearch(''); setSearchResults([]);
  }

  const countedSkus = useMemo(() => Object.keys(lines).filter(sku => lines[sku].qty.trim() !== ''), [lines]);

  const unsavedSkus = useMemo(() => Object.keys(lines).filter(sku => lines[sku].qty.trim() !== '' && !lines[sku].saved && !lines[sku].saving), [lines]);
  const badSkus = useMemo(() => Object.keys(lines).filter(sku => Number.isNaN(evalQty(lines[sku].qty) as number)), [lines]);

  async function goToRecap() {
    if (!countedSkus.length) return;
    if (badSkus.length) return; // shown in red above the button — fix before the recap
    setStep('recap'); setRecapLoading(true); setSubmitError(null);
    const { previewSubmitAction } = await import('../actions');
    const res = await previewSubmitAction(session.id);
    setRecapLoading(false);
    if (res.error) { setSubmitError(res.error); return; }
    setRecapLines(res.lines ?? []);
  }

  async function confirmSend() {
    setSubmitting(true); setSubmitError(null);
    const { confirmSubmitAction } = await import('../actions');
    const res = await confirmSubmitAction(session.id, inventoryDate);
    setSubmitting(false);
    if (res.error) { setSubmitError(res.error); return; }
    setFinalLines(res.lines ?? []);
    setStep('success');
    router.refresh();
  }

  const catsForDisplay = [...categories, ...extraCats.filter(c => !categories.includes(c))];

  return (
    <div className="space-y-3">
      <Link href="/inventory" className="inline-flex items-center gap-1.5 text-sm text-ink-light hover:text-navy">
        <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
      </Link>
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1">
        {vi ? 'Kiểm kê' : 'Inventaire'} — {session.inventory_date}
      </h1>

      {step === 'count' && (
        <>
          <div className="flex gap-1.5 flex-wrap">
            {catsForDisplay.map(cat => {
              const inCat = products.filter(p => p.category === cat).map(p => p.sku)
                .concat(Object.keys(lines).filter(sku => lines[sku].category === cat && !products.some(p => p.sku === sku)));
              const done = inCat.filter(sku => lines[sku]?.qty.trim() !== '').length;
              return (
                <button key={cat} onClick={() => setActiveCat(cat)}
                  className="text-xs font-semibold rounded-full px-3.5 py-1.5 inline-flex items-center gap-1.5"
                  style={{
                    border: '1px solid', borderColor: activeCat === cat ? '#1f2937' : '#D1D5DB',
                    backgroundColor: activeCat === cat ? '#F3F4F6' : 'transparent', color: '#1f2937',
                  }}>
                  {cat}
                  <span style={{ color: '#9CA3AF' }}>{done}/{inCat.length || 0}</span>
                </button>
              );
            })}
            <button onClick={() => setActiveCat('__search__')}
              className="text-xs font-semibold rounded-full px-3.5 py-1.5 inline-flex items-center gap-1.5"
              style={{
                border: '1px solid', borderColor: activeCat === '__search__' ? '#1f2937' : '#D1D5DB',
                backgroundColor: activeCat === '__search__' ? '#F3F4F6' : 'transparent', color: '#1f2937',
              }}>
              <Search size={13} /> {vi ? 'Thêm sản phẩm khác' : 'Ajouter un autre produit'}
            </button>
          </div>

          {activeCat === '__search__' ? (
            <div className="card p-4 space-y-3">
              <input value={search} onChange={e => runSearch(e.target.value)}
                placeholder={vi ? 'Tìm theo tên hoặc SKU…' : 'Rechercher par nom ou SKU…'}
                className="w-full rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              {searching && <div className="text-xs text-ink-light">{vi ? 'Đang tìm…' : 'Recherche…'}</div>}
              <div className="space-y-1.5">
                {searchResults.map((hit: any) => (
                  <div key={hit.id} className="rounded-lg px-3 py-2" style={{ border: '1px solid #E5E7EB' }}>
                    <div className="text-sm font-bold text-navy mb-1">{vi ? hit.name_vi : (hit.name_en || hit.name_vi)}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(hit.variants ?? []).filter((v: any) => v.sku).map((v: any) => {
                        const already = !!lines[v.sku]?.qty;
                        return (
                          <button key={v.id} onClick={() => addFromSearch(hit, v)}
                            className="text-xs font-semibold rounded-lg px-2.5 py-1.5"
                            style={{ border: '1px solid #D1D5DB', backgroundColor: lines[v.sku] ? '#F0FDF4' : 'white' }}>
                            {v.label} · {v.sku} {already && '✓'}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card divide-y divide-border-soft overflow-hidden">
              {(products.filter(p => p.category === activeCat)
                .concat(Object.keys(lines).filter(sku => lines[sku].category === activeCat && !products.some(p => p.sku === sku))
                  .map(sku => ({ sku, product_name_vi: lines[sku].product_name_vi, product_name_en: lines[sku].product_name_en, category: activeCat, variant_label: null, fiche_id: '', variant_id: '' } as Product)))
              ).map(p => {
                const st = lines[p.sku];
                const counted = st?.qty.trim() !== '';
                const pendingSave = counted && !st?.saved && !st?.saving;
                return (
                  <div key={p.sku} className="px-4 py-2.5 flex items-center justify-between gap-3" style={{ backgroundColor: counted ? '#F0FDF4' : undefined }}>
                    <div className="min-w-0 flex-1">
                      {/* full name on 2+ lines rather than truncated — the calculator field is wider (2026-09-30) */}
                      <div className="text-sm font-semibold text-navy leading-snug break-words">{vi ? p.product_name_vi : (p.product_name_en || p.product_name_vi)}</div>
                      <div className="text-xs text-ink-light break-all">{p.sku}{p.variant_label ? ` · ${p.variant_label}` : ''}</div>
                      {st?.error && <div className="text-[11px] font-semibold break-words" style={{ color: '#DC2626' }}>{vi ? 'Chưa lưu: ' : 'Non enregistré : '}{st.error}</div>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <QtyExprInput value={st?.qty ?? ''}
                        onChange={v => setLines(prev => ({ ...prev, [p.sku]: { ...prev[p.sku], qty: v, saved: false } }))}
                        onBlur={v => { if (!lines[p.sku]?.saved) saveQty(p.sku, v); }}
                        filledBorderColor={st?.error ? '#DC2626' : st?.saved ? '#86EFAC' : '#F59E0B'} width={60} />
                      {/* per-line status: saving / saved ✓ / explicit save or retry button */}
                      <span className="w-7 h-7 shrink-0 flex items-center justify-center">
                        {st?.saving ? <Loader2 size={15} className="animate-spin text-ink-light" />
                          : st?.error ? (
                            <button type="button" onClick={() => saveQty(p.sku, st.qty)} aria-label="retry"
                              className="w-7 h-7 rounded-md flex items-center justify-center" style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>
                              <RotateCcw size={14} />
                            </button>
                          ) : pendingSave ? (
                            <button type="button" onClick={() => saveQty(p.sku, st!.qty)} aria-label="save"
                              className="w-7 h-7 rounded-md flex items-center justify-center text-white" style={{ backgroundColor: '#16A34A' }}>
                              <Check size={15} />
                            </button>
                          ) : counted && st?.saved ? <CheckCircle2 size={16} style={{ color: '#16A34A' }} /> : null}
                      </span>
                    </div>
                  </div>
                );
              })}
              {products.filter(p => p.category === activeCat).length === 0 &&
                Object.keys(lines).filter(sku => lines[sku].category === activeCat).length === 0 && (
                <div className="p-8 text-center text-sm text-ink-light">{vi ? 'Không có sản phẩm' : 'Aucun produit'}</div>
              )}
            </div>
          )}

          {unsavedSkus.length > 0 && (
            <div className="rounded-lg px-3 py-2 text-sm font-semibold" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
              {vi ? `${unsavedSkus.length} dòng chưa lưu — bấm ✓ hoặc ↻ ở từng dòng` : `${unsavedSkus.length} ligne(s) non enregistrée(s) — appuyez sur ✓ ou ↻ sur chaque ligne`}
            </div>
          )}
          {badSkus.length > 0 && (
            <div className="text-sm font-semibold text-right" style={{ color: '#DC2626' }}>
              {vi ? `Số lượng không hợp lệ: ${badSkus.join(', ')}` : `Quantité invalide : ${badSkus.join(', ')}`}
            </div>
          )}
          <div className="flex justify-end pt-2">
            <button onClick={goToRecap} disabled={!countedSkus.length || badSkus.length > 0 || unsavedSkus.length > 0}
              className="text-sm font-bold px-5 py-2.5 rounded-xl text-white disabled:opacity-40"
              style={{ backgroundColor: '#1f2937' }}>
              {vi ? `Xem lại (${countedSkus.length})` : `Voir le récapitulatif (${countedSkus.length})`}
            </button>
          </div>
        </>
      )}

      {step === 'recap' && (
        <div className="space-y-3">
          {recapLoading ? (
            <div className="card p-10 text-center text-sm text-ink-light">{vi ? 'Đang tải…' : 'Chargement…'}</div>
          ) : submitError ? (
            <div className="card p-4 text-sm font-semibold" style={{ color: '#DC2626' }}>{submitError}</div>
          ) : (
            <>
              <div className="card p-4 flex items-center gap-2">
                <label className="text-sm font-semibold text-navy shrink-0">{vi ? 'Ngày kiểm kê' : "Date d'inventaire"}</label>
                <input type="date" value={inventoryDate} onChange={e => setInventoryDate(e.target.value)}
                  className="rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ backgroundColor: '#F9FAFB' }}>
                      <th className="text-left px-3 py-2 font-semibold text-ink-light">{vi ? 'Sản phẩm' : 'Produit'}</th>
                      <th className="text-right px-3 py-2 font-semibold text-ink-light">{vi ? 'Đếm' : 'Compté'}</th>
                      <th className="text-right px-3 py-2 font-semibold text-ink-light">{vi ? 'Odoo hiện tại' : 'Odoo actuel'}</th>
                      <th className="text-right px-3 py-2 font-semibold text-ink-light">{vi ? 'Chênh lệch' : 'Écart'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-soft">
                    {(recapLines ?? []).map(r => {
                      const st = lines[r.sku];
                      return (
                        <tr key={r.sku}>
                          <td className="px-3 py-2">
                            <div className="font-semibold text-navy">{st ? (vi ? st.product_name_vi : (st.product_name_en || st.product_name_vi)) : r.sku}</div>
                            <div className="text-xs text-ink-light">{r.sku}</div>
                            {!r.found && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{vi ? 'Không tìm thấy trên Odoo' : 'Introuvable sur Odoo'}</div>}
                          </td>
                          <td className="text-right px-3 py-2 font-bold text-navy">{r.qtyCounted}</td>
                          <td className="text-right px-3 py-2 text-ink-light">{r.qtySystem ?? '—'}</td>
                          <td className="text-right px-3 py-2 font-bold" style={{ color: !r.diff ? '#6B7280' : r.diff > 0 ? '#059669' : '#DC2626' }}>
                            {r.diff == null ? '—' : (r.diff > 0 ? `+${r.diff}` : r.diff)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-ink-light">
                {vi
                  ? 'Mỗi sản phẩm đã được "chốt" trên Odoo ngay khi bạn nhập lần đầu — "Odoo hiện tại" là số liệu tại thời điểm đó. Bấm "Gửi lên Odoo" sẽ tính chênh lệch thực tế và áp dụng lên tồn kho hiện tại trên Odoo, không ghi đè.'
                  : 'Chaque produit a été "figé" sur Odoo dès sa première saisie — "Odoo actuel" est la valeur à cet instant-là. Cliquer sur "Envoyer à Odoo" calcule l’écart réel et l’applique sur le stock actuel dans Odoo, sans écraser.'}
              </p>
              {submitError && <div className="text-sm font-semibold" style={{ color: '#DC2626' }}>{submitError}</div>}
              <div className="flex justify-between items-center pt-2">
                <button onClick={() => setStep('count')} className="text-sm font-semibold text-ink-light hover:text-navy">
                  {vi ? '← Sửa số lượng' : '← Modifier les quantités'}
                </button>
                <button onClick={confirmSend} disabled={submitting}
                  className="text-sm font-bold px-5 py-2.5 rounded-xl text-white disabled:opacity-50"
                  style={{ backgroundColor: '#16A34A' }}>
                  {submitting ? '…' : (vi ? 'Gửi lên Odoo' : 'Envoyer à Odoo')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {step === 'success' && finalLines && (
        <div className="space-y-3">
          <div className="card p-5 text-center">
            {finalLines.every(l => l.ok) ? (
              <CheckCircle2 size={36} className="mx-auto mb-2" style={{ color: '#16A34A' }} />
            ) : (
              <AlertTriangle size={36} className="mx-auto mb-2" style={{ color: '#D97706' }} />
            )}
            <div className="font-bold text-navy">
              {finalLines.filter(l => l.ok).length}/{finalLines.length} {vi ? 'đã gửi thành công' : 'lignes envoyées avec succès'}
            </div>
          </div>
          {finalLines.some(l => !l.ok) && (
            <div className="card divide-y divide-border-soft overflow-hidden">
              {finalLines.filter(l => !l.ok).map(l => (
                <div key={l.sku} className="px-4 py-2.5">
                  <div className="text-sm font-bold text-navy">{l.sku}</div>
                  <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{l.error}</div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Link href="/inventory" className="text-sm font-bold px-5 py-2.5 rounded-xl text-white inline-block" style={{ backgroundColor: '#1f2937' }}>
              {vi ? 'Xong' : 'Terminé'}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
