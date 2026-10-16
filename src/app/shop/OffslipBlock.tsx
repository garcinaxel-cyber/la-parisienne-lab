'use client';
// "Nhận sản phẩm không có trong phiếu" (Axel, 2026-10-16) — under each order of the shop's
// reception: declare products received that are on NO slip (photo required). The shop keeps them;
// the Lab settles them on Delivery gaps. Self-contained: loads its own items, never touches the
// order's lines or their confirm flow.
import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Loader2, Camera, ImageIcon, X, PackagePlus } from 'lucide-react';
import type { OffslipItem } from '@/lib/offslip';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', RED = '#B42318';

async function compress(file: File, maxSide = 1280, quality = 0.8): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d'); if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    return blob ? new File([blob], 'offslip.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

type Prod = { sku: string; name: string; imageUrl: string | null };

export default function OffslipBlock({ deliveryOrderId, orderRef, shopName, readOnly, byName, canDeclare, L, onZoom, excludeSkus = [] }: {
  deliveryOrderId: string; orderRef: string; shopName: string; readOnly: boolean; byName: string; canDeclare: boolean;
  // SKUs already on one of this shop's slips for the same day (Axel, 2026-10-16): an extra unit of
  // those is counted on its own line (existing 'thừa' gap flow), never declared off-slip.
  excludeSkus?: string[];
  L: (vi: string, en: string) => string; onZoom?: (url: string) => void;
}) {
  const [items, setItems] = useState<OffslipItem[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Prod[]>([]);
  const [searching, setSearching] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [picked, setPicked] = useState<Prod | null>(null);
  const [qty, setQty] = useState(1);
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const a = await import('./actions');
    const r = await a.getOffslipForOrdersAction([deliveryOrderId], readOnly ? shopName : undefined);
    if (r.items) setItems(r.items);
  }, [deliveryOrderId, readOnly, shopName]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2 || picked) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      const a = await import('./actions');
      const r = await a.searchStockCountProductsAction(s, readOnly ? shopName : undefined);
      setSearching(false);
      const ex = new Set(excludeSkus);
      const all = r.products ?? [];
      setHidden(all.filter(p => ex.has(p.sku)).length);
      setResults(all.filter(p => !ex.has(p.sku)).slice(0, 12).map(p => ({ sku: p.sku, name: p.name, imageUrl: p.imageUrl })));
    }, 250);
    return () => clearTimeout(t);
  }, [q, picked, readOnly, shopName, excludeSkus.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() { setQ(''); setResults([]); setPicked(null); setQty(1); setPhotos([]); setNote(''); setErr(null); }
  async function addPhoto(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', await compress(f));
      const a = await import('./actions');
      const r = await a.uploadReceiptPhotoAction(fd, readOnly ? shopName : undefined);
      if (r.url) setPhotos(p => [...p, r.url!]); else if (r.error) setErr(r.error);
    } finally { setUploading(false); }
  }
  async function submit() {
    if (!picked) return;
    if (!byName.trim()) { setErr(L('Chọn tên người xác nhận ở trên trước.', 'Pick your name above first.')); return; }
    if (!photos.length) { setErr(L('Cần ít nhất 1 ảnh.', 'A photo is required.')); return; }
    setBusy(true); setErr(null);
    const a = await import('./actions');
    const r = await a.declareOffslipAction({ deliveryOrderId, sku: picked.sku, productName: picked.name, qty, photoUrls: photos, note: note.trim() || null,
      declaredByName: byName.trim(), ...(readOnly ? { shopName } : {}) });
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setOpen(false); reset(); load();
  }

  const statusOf = (i: OffslipItem) => i.status === 'open'
    ? { t: L('Lab đang kiểm tra', 'The Lab is checking'), bg: '#FFF6E0', fg: '#8A5A00' }
    : i.labCause === 'shop_error' ? { t: L('Lab: không có hàng thừa', 'Lab: nothing extra'), bg: '#F2F4F7', fg: '#344054' }
    : { t: L('Đã cộng vào tồn kho shop', 'Added to the shop stock'), bg: '#ECFDF3', fg: '#067647' };

  return (
    <div className="px-4 py-3 space-y-2" style={{ borderBottom: `1px solid ${HAIR}` }}>
      {items.length > 0 && (
        <div className="rounded-xl p-2.5 space-y-2" style={{ border: `1.5px solid ${GOLD}`, backgroundColor: '#fff' }}>
          <div className="text-[11px] font-extrabold uppercase tracking-wide" style={{ color: GOLD_TEXT }}>{L('Ngoài phiếu · đã khai báo', 'Off-slip · declared')}</div>
          {items.map(i => { const st = statusOf(i); return (
            <div key={i.id} className="flex items-center gap-2.5">
              {i.photoUrls[0]
                ? <button type="button" onClick={() => onZoom?.(i.photoUrls[0])} className="w-10 h-10 rounded-lg overflow-hidden shrink-0" style={{ border: `1px solid ${BORDER}` }} aria-label={L('Xem ảnh', 'View photo')}><img src={i.photoUrls[0]} alt="" className="w-full h-full object-cover" /></button>
                : <div className="w-10 h-10 rounded-lg shrink-0" style={{ backgroundColor: PALE }} />}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold truncate">{i.productName}</div>
                <div className="text-[11.5px]" style={{ color: '#6B7280' }}>+{i.qty} · {i.declaredBy}</div>
              </div>
              <span className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5 shrink-0" style={{ backgroundColor: st.bg, color: st.fg }}>{st.t}</span>
            </div>); })}
        </div>
      )}
      {canDeclare && (
        <button type="button" onClick={() => { reset(); setOpen(true); }}
          className="w-full inline-flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-extrabold bg-white"
          style={{ border: `2px dashed ${GOLD}`, color: NAVY }}>
          <Plus size={15} /> {L('Nhận sản phẩm không có trong phiếu', 'Received a product not on the slip')}
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: 'rgba(26,44,36,.45)' }} onClick={() => !busy && setOpen(false)}>
          <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[90vh] overflow-y-auto space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-2">
              <PackagePlus size={18} style={{ color: NAVY }} className="mt-0.5" />
              <div className="flex-1">
                <div className="text-[15px] font-extrabold">{L('Sản phẩm không có trong phiếu', 'Product not on the slip')}</div>
                <div className="text-xs" style={{ color: '#6B7280' }}>{orderRef} · {shopName}</div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="close" style={{ color: '#9CA3AF' }}><X size={18} /></button>
            </div>

            {!picked ? (
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 rounded-xl px-3" style={{ border: `1px solid ${BORDER}` }}>
                  <Search size={14} style={{ color: '#9CA3AF' }} />
                  <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm sản phẩm…', 'Search a product…')} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
                  {searching && <Loader2 size={14} className="animate-spin" style={{ color: '#9CA3AF' }} />}
                </label>
                {hidden > 0 && (
                  <div className="text-[11.5px] rounded-lg px-2.5 py-2" style={{ backgroundColor: '#FFF6E0', color: '#8A5A00' }}>
                    {L(`${hidden} sản phẩm có trong phiếu hôm nay không hiện ở đây: nhận dư thì sửa số ở dòng của sản phẩm đó.`, `${hidden} product(s) on today's slips are not listed here: for an extra unit, change the count on that product's line.`)}
                  </div>
                )}
                {results.map(p => (
                  <button key={p.sku} type="button" onClick={() => setPicked(p)} className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left" style={{ border: `1px solid ${HAIR}` }}>
                    {p.imageUrl ? <img src={p.imageUrl} alt="" className="w-9 h-9 rounded-md object-cover" /> : <div className="w-9 h-9 rounded-md" style={{ backgroundColor: PALE }} />}
                    <span className="flex-1 text-[13px] font-semibold">{p.name}</span>
                    <span className="text-[11px]" style={{ color: '#9CA3AF' }}>{p.sku}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2.5 rounded-xl px-3 py-2" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}` }}>
                <span className="flex-1 text-[13.5px] font-extrabold">✓ {picked.name} <span className="font-normal" style={{ color: '#9CA3AF' }}>· {picked.sku}</span></span>
                <button onClick={() => { setPicked(null); setQ(''); }} className="text-xs font-extrabold" style={{ color: GOLD_TEXT }}>{L('Đổi', 'Change')}</button>
              </div>
            )}

            <div className="flex items-center gap-3">
              <span className="flex-1 text-[13px] font-bold">{L('Số lượng nhận thêm', 'Extra quantity received')}</span>
              <div className="flex items-center rounded-lg overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
                <button onClick={() => setQty(n => Math.max(1, n - 1))} className="w-10 h-10 font-extrabold" style={{ color: NAVY }}>−</button>
                <input inputMode="numeric" value={qty} onChange={e => { const v = parseInt(e.target.value.replace(/\D/g, ''), 10); setQty(isNaN(v) ? 1 : Math.max(1, Math.min(500, v))); }}
                  className="w-12 h-10 text-center font-extrabold outline-none" style={{ borderLeft: `1px solid ${HAIR}`, borderRight: `1px solid ${HAIR}` }} />
                <button onClick={() => setQty(n => Math.min(500, n + 1))} className="w-10 h-10 font-extrabold" style={{ color: NAVY }}>+</button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{L('Ảnh', 'Photo')} <span style={{ color: RED }}>· {L('bắt buộc', 'required')}</span></div>
              <div className="flex gap-2">
                <label className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-extrabold cursor-pointer" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>
                  <Camera size={15} /> {L('Chụp ảnh', 'Take photo')}
                  <input type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading} onChange={e => { addPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                <label className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-extrabold cursor-pointer" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>
                  <ImageIcon size={15} /> {L('Chọn ảnh có sẵn', 'Choose a picture')}
                  <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={e => { addPhoto(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
              <div className="flex gap-2 flex-wrap">
                {photos.map(u => (
                  <div key={u} className="relative w-14 h-14">
                    <img src={u} alt="" className="w-14 h-14 rounded-lg object-cover" />
                    <button type="button" onClick={() => setPhotos(p => p.filter(x => x !== u))} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full text-white text-xs" style={{ backgroundColor: RED }} aria-label="x">×</button>
                  </div>
                ))}
                {uploading && <div className="w-14 h-14 rounded-lg flex items-center justify-center" style={{ border: `1.5px dashed ${GOLD}` }}><Loader2 size={16} className="animate-spin" /></div>}
              </div>
            </div>

            <label className="block">
              <span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Ghi chú (tuỳ chọn)', 'Note (optional)')}</span>
              <input value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder={L('VD: tem ghi tên khách…', 'e.g. a customer name on the label…')}
                className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
            </label>

            <div className="rounded-xl px-3 py-2 text-xs" style={{ backgroundColor: PALE, color: GOLD_TEXT, border: `1px solid ${BORDER}` }}>
              {L('Giữ bánh lại ở shop và bán bình thường. Lab kiểm tra rồi cộng vào tồn kho của shop.', 'Keep the goods at the shop and sell them as usual. The Lab checks and adds them to your stock.')}
            </div>
            {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: RED }}>{err}</div>}
            <button disabled={busy || !picked || !photos.length || uploading} onClick={submit}
              className="w-full rounded-xl py-3 font-extrabold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>
              {busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Gửi cho Lab', 'Send to the Lab')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
