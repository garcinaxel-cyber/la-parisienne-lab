'use client';
import { useEffect, useState } from 'react';
import { Trash2, Search, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import type { LabLoss, LabLossReason } from './actions';
import { thumb } from '@/lib/img-thumb';

// LAB's own scrap/loss report — admin + assistant space. Axel, 2026-08-27: "une fonction de
// scrap similaire aux shops mais pour les produits casse du lab". Same shape as the shop
// portal's loss report (multi-item batch, double-confirm before the Odoo-bound submit, best-effort
// Odoo sync surfaced per item), but standalone (no deliveries/cakes tabs) and with the reporter's
// name taken from their own logged-in profile instead of a shared-account name picker.
type ProductSearchResult = { id: string; name_vi: string; name_en: string | null; sku: string | null; main_image_url?: string | null };

export default function LabScrapView({ reporterName }: { reporterName: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const [losses, setLosses] = useState<LabLoss[] | null>(null);
  const [reasons, setReasons] = useState<LabLossReason[] | null>(null);
  const [loading, setLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [product, setProduct] = useState<ProductSearchResult | null>(null);
  const [qty, setQty] = useState('1');
  const [reasonId, setReasonId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [items, setItems] = useState<{ id: string; product: ProductSearchResult; qty: number; reasonId: number; reasonName: string; note: string }[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function load() {
    setLoading(true);
    const actions = await import('./actions');
    const [lossesRes, reasonsRes] = await Promise.all([actions.getLabLossesAction(), actions.getLabLossReasonsAction()]);
    setLoading(false);
    if (lossesRes.losses) setLosses(lossesRes.losses);
    if (reasonsRes.reasons) setReasons(reasonsRes.reasons);
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/lab/products-search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setResults(Array.isArray(data) ? data : []);
      } catch { setResults([]); }
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function addItem() {
    if (!product || !reasonId) return;
    const qtyNum = Number(qty);
    if (!(qtyNum > 0)) return;
    const reason = reasons?.find(r => r.id === reasonId);
    if (!reason) return;
    setItems(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      product, qty: qtyNum, reasonId: reason.id, reasonName: reason.name, note: note.trim(),
    }]);
    setProduct(null); setQuery(''); setQty('1'); setNote(''); setReasonId(null);
  }

  function removeItem(id: string) {
    setItems(prev => prev.filter(i => i.id !== id));
  }

  async function submit() {
    if (items.length === 0) return;
    setSubmitting(true); setMsg(null);
    const { recordLabLossAction } = await import('./actions');
    let okCount = 0, errCount = 0, syncErrCount = 0;
    for (const item of items) {
      const res = await recordLabLossAction({
        sku: item.product.sku, productName: item.product.name_vi, qty: item.qty,
        reasonTagId: item.reasonId, reasonTagName: item.reasonName, note: item.note || null,
      });
      if (res.error) errCount++;
      else { okCount++; if (!res.odooSynced) syncErrCount++; }
    }
    setSubmitting(false);
    if (errCount > 0) setMsg(vi ? `Đã lưu ${okCount}/${items.length} sản phẩm, ${errCount} lỗi` : `Saved ${okCount}/${items.length} items, ${errCount} error(s)`);
    else if (syncErrCount > 0) setMsg(vi ? `Đã lưu ${okCount} sản phẩm (${syncErrCount} chưa đồng bộ Odoo)` : `Saved ${okCount} item(s) (${syncErrCount} not synced to Odoo)`);
    else setMsg(vi ? `Đã lưu và đồng bộ Odoo (${okCount} sản phẩm)` : `Saved and synced to Odoo (${okCount} item(s))`);
    setItems([]);
    setLosses(null);
    load();
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
          <Trash2 size={26} className="text-red-600" /> {vi ? 'Hao hụt sản xuất (Lab)' : 'Lab scrap / loss'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {vi ? 'Báo cáo sản phẩm hỏng/casse tại kho LAB — ghi trực tiếp lên Odoo, không phải kho boutique.' : 'Report broken/damaged production items at LAB’s own warehouse — writes directly to Odoo, never a shop’s stock.'}
        </p>
      </div>

      <div className="bg-white rounded-2xl p-4 space-y-2.5 max-w-xl" style={{ border: '1px solid #E5E7EB' }}>
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
          {vi ? 'Báo cáo mới' : 'New report'}
        </div>
        <div className="text-xs" style={{ color: '#9CA3AF' }}>
          {vi ? 'Người báo cáo' : 'Reported by'}: <span className="font-semibold" style={{ color: '#374151' }}>{reporterName || '—'}</span>
        </div>

        <div className="relative">
          <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>{vi ? 'Sản phẩm' : 'Product'}</div>
          {product ? (
            <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB', backgroundColor: '#F9FAFB' }}>
              <span className="flex items-center gap-2 min-w-0">
                {product.main_image_url && (
                  <button type="button" onClick={() => setZoomImage(product.main_image_url!)}
                    className="shrink-0 w-8 h-8 rounded overflow-hidden" aria-label={vi ? 'Xem ảnh' : 'View photo'}>
                    <img src={thumb(product.main_image_url, 80)} alt="" className="w-full h-full object-cover" />
                  </button>
                )}
                <span className="font-semibold truncate">{vi ? product.name_vi : (product.name_en || product.name_vi)}{product.sku ? ` (${product.sku})` : ''}</span>
              </span>
              <button onClick={() => { setProduct(null); setQuery(''); }} className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>
                {vi ? 'Đổi' : 'Change'}
              </button>
            </div>
          ) : (
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: '#9CA3AF' }} />
              <input type="text" value={query} onChange={e => setQuery(e.target.value)}
                placeholder={vi ? 'Tìm sản phẩm…' : 'Search product…'} className="w-full rounded-lg pl-8 pr-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              {query.trim().length >= 2 && (
                <div className="mt-1 rounded-lg overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
                  {searching ? (
                    <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>{vi ? 'Đang tìm…' : 'Searching…'}</div>
                  ) : !results.length ? (
                    <div className="px-3 py-2 text-xs" style={{ color: '#9CA3AF' }}>{vi ? 'Không tìm thấy' : 'No results'}</div>
                  ) : results.slice(0, 8).map(p => (
                    <button key={p.id} onClick={() => { setProduct(p); setResults([]); }}
                      className="w-full text-left px-3 py-2 text-sm border-t first:border-t-0 flex items-center gap-2" style={{ borderColor: '#F3F4F6' }}>
                      {p.main_image_url && <img src={thumb(p.main_image_url, 80)} alt="" className="w-8 h-8 rounded object-cover shrink-0" />}
                      <span className="truncate">{vi ? p.name_vi : (p.name_en || p.name_vi)}{p.sku ? <span style={{ color: '#9CA3AF' }}> · {p.sku}</span> : null}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2.5">
          <div className="flex-1">
            <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>{vi ? 'Số lượng' : 'Quantity'}</div>
            <input type="number" min={0} step="1" value={qty} onChange={e => setQty(e.target.value)}
              className="w-full rounded-lg px-2.5 py-1.5 text-sm font-bold" style={{ border: '1px solid #D1D5DB' }} />
          </div>
          <div className="flex-[2]">
            <div className="text-xs font-semibold mb-1" style={{ color: '#6B7280' }}>{vi ? 'Lý do' : 'Reason'}</div>
            <select value={reasonId ?? ''} onChange={e => setReasonId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }}>
              <option value="">{vi ? 'Chọn lý do…' : 'Choose reason…'}</option>
              {(reasons ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        </div>
        <input type="text" value={note} onChange={e => setNote(e.target.value)}
          placeholder={vi ? 'Ghi chú (tuỳ chọn)' : 'Note (optional)'} className="w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
        <button onClick={addItem}
          disabled={!product || !reasonId || !(Number(qty) > 0)}
          className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 disabled:opacity-40"
          style={{ backgroundColor: '#F3F4F6', color: '#1f2937', border: '1px solid #D1D5DB' }}>
          + {vi ? 'Thêm vào danh sách' : 'Add to list'}
        </button>

        {items.length > 0 && (
          <div className="space-y-1.5 pt-1" style={{ borderTop: '1px solid #F3F4F6' }}>
            <div className="text-xs font-bold uppercase tracking-wide pt-1.5" style={{ color: '#6B7280' }}>
              {vi ? 'Danh sách' : 'List'} ({items.length})
            </div>
            {items.map(item => (
              <div key={item.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#F9FAFB', border: '1px solid #F3F4F6' }}>
                {item.product.main_image_url && (
                  <img src={thumb(item.product.main_image_url, 80)} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate">{item.product.name_vi} <span style={{ color: '#9CA3AF', fontWeight: 400 }}>×{item.qty}</span></div>
                  <div className="text-[11px] truncate" style={{ color: '#9CA3AF' }}>{item.reasonName}{item.note ? ` · ${item.note}` : ''}</div>
                </div>
                <button onClick={() => removeItem(item.id)} className="text-xs font-bold shrink-0 px-1" style={{ color: '#DC2626' }} aria-label={vi ? 'Xoá' : 'Remove'}>✕</button>
              </div>
            ))}
          </div>
        )}

        <button onClick={() => { if (items.length === 0) addItem(); setPending(true); }}
          disabled={submitting || !reporterName.trim() || (items.length === 0 && !(product && reasonId && Number(qty) > 0))}
          className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 text-white disabled:opacity-40"
          style={{ backgroundColor: '#DC2626' }}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          {items.length > 1
            ? (vi ? `Báo cáo hao hụt (${items.length} sản phẩm)` : `Report scrap (${items.length} items)`)
            : (vi ? 'Báo cáo hao hụt' : 'Report scrap')}
        </button>
        {product && reasonId && Number(qty) > 0 && items.length === 0 && (
          <div className="text-[11px]" style={{ color: '#9CA3AF' }}>
            {vi ? 'Sẵn sàng báo cáo — hoặc nhấn "+ Thêm vào danh sách" để thêm sản phẩm khác trước.'
                : 'Ready to report — or tap "+ Add to list" first to add another product.'}
          </div>
        )}
        {msg && <div className="text-xs font-semibold" style={{ color: msg.toLowerCase().includes('lỗi') || msg.toLowerCase().includes('error') ? '#DC2626' : '#059669' }}>{msg}</div>}
      </div>

      <div className="max-w-xl space-y-2">
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
          {vi ? 'Lịch sử gần đây' : 'Recent history'}
        </div>
        {loading && losses === null ? (
          <div className="text-center py-6 text-sm" style={{ color: '#6B7280' }}>{vi ? 'Đang tải…' : 'Loading…'}</div>
        ) : !losses?.length ? (
          <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: '#6B7280', border: '1px solid #E5E7EB' }}>
            {vi ? 'Chưa có báo cáo hao hụt nào' : 'No scrap reports yet'}
          </div>
        ) : (
          <div className="space-y-2">
            {losses.map(l => (
              <div key={l.id} className="bg-white rounded-2xl p-3.5" style={{ border: '1px solid #E5E7EB' }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-navy truncate">{l.productName} ×{l.qty}</div>
                  {l.odooScrapId ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold shrink-0" style={{ color: '#059669' }}><CheckCircle2 size={12} /> Odoo</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold shrink-0" style={{ color: '#D97706' }}><AlertTriangle size={12} /> {vi ? 'Chưa đồng bộ' : 'Not synced'}</span>
                  )}
                </div>
                <div className="text-xs mt-0.5" style={{ color: '#6B7280' }}>{l.reasonTagName}{l.note ? ` · ${l.note}` : ''}</div>
                <div className="text-[11px] mt-1" style={{ color: '#9CA3AF' }}>{l.reportedByName} · {new Date(l.reportedAt).toLocaleString(vi ? 'vi-VN' : 'en-GB')}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {zoomImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          onClick={() => setZoomImage(null)}>
          <img src={thumb(zoomImage, 1200)} alt="" className="max-w-full max-h-full rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}

      {pending && items.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-3 max-h-[85vh] overflow-y-auto">
            <div className="text-xs font-bold uppercase tracking-wide" style={{ color: '#6B7280' }}>
              {vi ? `Xác nhận báo cáo hao hụt (${items.length} sản phẩm)` : `Confirm scrap report (${items.length} items)`}
            </div>
            <div className="space-y-1.5">
              {items.map(item => (
                <div key={item.id} className="flex items-center gap-3 rounded-xl p-2.5" style={{ backgroundColor: '#FEF2F2' }}>
                  {item.product.main_image_url && (
                    <img src={thumb(item.product.main_image_url, 112)} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" style={{ border: '1px solid #FCA5A5' }} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-navy truncate">{item.product.name_vi}{item.product.sku ? ` (${item.product.sku})` : ''}</div>
                    <div className="text-xs" style={{ color: '#6B7280' }}>{item.reasonName}{item.note ? ` · ${item.note}` : ''}</div>
                  </div>
                  <span className="text-sm font-bold shrink-0" style={{ color: '#DC2626' }}>×{item.qty}</span>
                </div>
              ))}
            </div>
            <div className="text-[11px]" style={{ color: '#9CA3AF' }}>
              {vi ? 'Thao tác này gửi thẳng lên Odoo (kho LAB) và không thể huỷ.' : 'This sends straight to Odoo (LAB’s own stock) and can’t be undone.'}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPending(false)}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>
                {vi ? 'Huỷ' : 'Cancel'}
              </button>
              <button onClick={() => { setPending(false); submit(); }}
                className="flex-1 text-sm font-bold rounded-lg px-3 py-2.5 text-white" style={{ backgroundColor: '#DC2626' }}>
                {vi ? 'Xác nhận' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
