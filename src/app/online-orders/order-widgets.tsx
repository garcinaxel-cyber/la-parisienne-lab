'use client';
import { useEffect, useState } from 'react';
import { Search, Loader2, X } from 'lucide-react';
import * as actions from './actions';
import type { OnlineProduct, OnlineOrderSummary } from './actions';
import { BORDER, CREAM_DARK, INK_LIGHT, fmtCompactVnd, useL } from './shared';

// Moved out of OnlineOrdersView.tsx (UI v2, 2026-11-14) so the new Orders screen can reuse them.
// Client-side downscale before any upload (design photo or payment screenshot): a phone
// screenshot is 2–5 MB, the same picture at 1200px JPEG is ~100–250 KB. Keeps Supabase
// storage/egress flat and the upload instant on shop wifi. Falls back to the original file
// if the browser can't decode it.
export async function compressImage(file: File, maxSide = 1200, quality = 0.72): Promise<File> {
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


// Reconstruction panel (Axel, 2026-09-08): lets the seller replace a historical import's single
// generic no-SKU revenue line with real catalog items, if she still remembers the order. Reuses
// the same product search as the order-creation tab; deliberately minimal (no delivery-date,
// shop, cake-message fields -- this only ever edits WHAT was sold, never re-triggers anything).
type ReconstructLine = { key: string; ficheId: string; variantId: string | null; sku: string | null; nameVi: string; qty: number; unitPrice: number };

export function ReconstructPanel({ order, onDone, onCancel }: { order: OnlineOrderSummary; onDone: () => void; onCancel: () => void }) {
  const { tr } = useL();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OnlineProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [lines, setLines] = useState<ReconstructLine[]>([]);
  const [saving, setSaving] = useState(false);
  const originalText = order.items.map(i => i.nameVi).join(', ');
  // Preserve the revenue the historical row already carried -- excel_import orders land with
  // exactly one generic no-SKU line, so order.total IS that original amount. Used both to
  // prefill a sane price (instead of a catalog price that may not exist) and to flag any
  // mismatch before saving (Axel, 2026-09-08: a reconstruction silently zeroed an order's total
  // because the picked product had no catalog price and nothing caught it).
  const originalTotal = order.total;
  const newTotal = lines.reduce((s, l) => s + l.qty * (Number(l.unitPrice) || 0), 0);
  const mismatch = lines.length > 0 && newTotal !== originalTotal;

  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await actions.searchOnlineProductsAction(q);
      setResults(res.products ?? []);
      setSearching(false);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  function addLine(p: OnlineProduct) {
    setLines(ls => {
      // First line and no catalog price to go on -- default to the original order's total
      // rather than 0, so leaving the price field untouched can't silently zero the order.
      const fallback = ls.length === 0 ? originalTotal : 0;
      const unitPrice = p.price ?? fallback;
      return [...ls, { key: `${p.ficheId}:${p.variantId}:${ls.length}`, ficheId: p.ficheId, variantId: p.variantId, sku: p.sku, nameVi: p.nameVi, qty: 1, unitPrice }];
    });
    setQuery('');
  }
  function removeLine(key: string) { setLines(ls => ls.filter(l => l.key !== key)); }
  function updateQty(key: string, qty: number) { setLines(ls => ls.map(l => l.key === key ? { ...l, qty: Math.max(1, qty) } : l)); }
  function updatePrice(key: string, unitPrice: number) { setLines(ls => ls.map(l => l.key === key ? { ...l, unitPrice: Math.max(0, unitPrice) } : l)); }

  async function save() {
    if (!lines.length) return;
    setSaving(true);
    await actions.replaceOnlineOrderLinesAction(order.orderBatchId, lines.map(l => ({ ficheId: l.ficheId, variantId: l.variantId, sku: l.sku, nameVi: l.nameVi, qty: l.qty, unitPrice: l.unitPrice })));
    setSaving(false);
    onDone();
  }

  return (
    <div className="rounded-lg p-3 mb-2" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#6D28D9', marginBottom: 4 }}>{tr('reconstructTitle')}</div>
      <div style={{ fontSize: 11.5, color: INK_LIGHT, marginBottom: 8, fontStyle: 'italic' }}>{tr('reconstructHint')}{originalText}</div>

      <div style={{ fontSize: 11, color: INK_LIGHT, marginBottom: 6 }}>{tr('reconstructAddMore')}</div>
      <div className="relative mb-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style={{ border: `1px solid ${BORDER}`, backgroundColor: '#fff' }}>
          <Search size={13} color={INK_LIGHT} />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('reconstructSearchPh')}
            className="flex-1 text-sm outline-none" style={{ fontSize: 12.5 }} />
          {searching && <Loader2 size={13} className="animate-spin" color={INK_LIGHT} />}
        </div>
        {query.trim() && results.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg shadow-lg max-h-56 overflow-y-auto" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {results.map(p => (
              <button key={`${p.ficheId}:${p.variantId}`} onMouseDown={e => e.preventDefault()} onClick={() => addLine(p)}
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-gray-50" style={{ borderBottom: `1px solid ${CREAM_DARK}`, fontSize: 12.5 }}>
                {p.nameVi}{p.isCake ? ' 🎂' : ''}
              </button>
            ))}
          </div>
        )}
      </div>

      {lines.length === 0 ? (
        <div style={{ fontSize: 11.5, color: INK_LIGHT, marginBottom: 8 }}>{tr('reconstructEmpty')}</div>
      ) : (
        <div className="space-y-1.5 mb-2">
          {lines.map(l => (
            <div key={l.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
              <span className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', fontSize: 12 }}>{l.nameVi}</span>
              <input type="number" min={1} value={l.qty} onChange={e => updateQty(l.key, Number(e.target.value))}
                className="text-center rounded" style={{ width: 36, fontSize: 12, border: `1px solid ${BORDER}`, padding: '2px 0' }} />
              <input type="number" min={0} value={l.unitPrice} onChange={e => updatePrice(l.key, Number(e.target.value))}
                className="text-right rounded" style={{ width: 76, fontSize: 12, border: `1px solid ${BORDER}`, padding: '2px 4px' }} />
              <button onClick={() => removeLine(l.key)}><X size={13} color={INK_LIGHT} /></button>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11.5, marginBottom: 6, fontWeight: mismatch ? 700 : 400, color: mismatch ? '#B91C1C' : INK_LIGHT }}>
        {tr('reconstructOriginalTotal')}{fmtCompactVnd(originalTotal)} · {fmtCompactVnd(newTotal)}
        {mismatch ? ` — ${tr('reconstructMismatch')}` : ''}
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} style={{ fontSize: 12, fontWeight: 600, color: INK_LIGHT, padding: '6px 12px' }}>{tr('reconstructCancel')}</button>
        <button onClick={save} disabled={!lines.length || saving}
          style={{ fontSize: 12, fontWeight: 700, color: '#fff', backgroundColor: mismatch ? '#B91C1C' : '#6D28D9', padding: '6px 14px', borderRadius: 8, opacity: !lines.length || saving ? 0.5 : 1 }}>
          {saving ? tr('reconstructSaving') : tr('reconstructSave')}
        </button>
      </div>
    </div>
  );
}

