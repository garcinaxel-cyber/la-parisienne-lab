'use client';
// Thumbnail of a raw material / packaging item (Axel, 2026-10-28). Photos come from one small
// list loaded once per page session (never from Odoo on screen); lazy-loaded 160 px JPEG thumbnails (~5 KB each).
// When an item has no photo and `canAdd` is set, a camera button lets the staff take or import
// one — it shows at once and is sent to Odoo in the background.
import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { getItemPhotosAction, addItemPhotoAction } from '@/app/item-photo-actions';

let cache: { byTmpl: Map<number, string>; bySku: Map<string, string> } | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
function load(): Promise<void> {
  if (cache) return Promise.resolve();
  if (!pending) pending = getItemPhotosAction().then(r => {
    const byTmpl = new Map<number, string>(); const bySku = new Map<string, string>();
    for (const [t, s, u] of r.rows ?? []) { byTmpl.set(t, u); if (s) bySku.set(s, u); }
    cache = { byTmpl, bySku }; listeners.forEach(f => f());
  }).catch(() => { pending = null; });
  return pending;
}

async function compress(file: File): Promise<Blob> {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, 1200 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const b: Blob | null = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
  return b ?? file;
}

export default function ItemPhoto({ tmplId, sku, size = 40, canAdd = false }: { tmplId?: number | null; sku?: string | null; size?: number; canAdd?: boolean }) {
  const [, force] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { const f = () => force(x => x + 1); listeners.add(f); load(); return () => { listeners.delete(f); }; }, []);
  const url = (tmplId && cache?.byTmpl.get(tmplId)) || (sku && cache?.bySku.get(sku)) || null;
  const box = { width: size, height: size, minWidth: size };

  if (url) return <img src={url} alt="" loading="lazy" decoding="async" className="rounded-md object-cover border border-[#E8D9C0] bg-white shrink-0" style={box} />;
  if (!canAdd || !tmplId) return <span className="rounded-md bg-[#F5EFE6] border border-[#E8D9C0] inline-block shrink-0" style={box} aria-hidden />;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.set('tmplId', String(tmplId)); if (sku) fd.set('sku', sku);
      fd.set('file', await compress(f), 'photo.jpg');
      const r = await addItemPhotoAction(fd);
      if (r.error || !r.url) { setErr(r.error ?? 'Error'); window.alert(r.error ?? 'Error'); }
      else { cache?.byTmpl.set(tmplId, r.url); if (sku) cache?.bySku.set(sku, r.url); listeners.forEach(x => x()); }
    } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <>
      {/* span, not button: the thumbnail sits inside row buttons (inventory list) */}
      <span role="button" tabIndex={0} title="Thêm ảnh · Add a photo" aria-disabled={busy}
        onClick={e => { e.stopPropagation(); e.preventDefault(); if (!busy) input.current?.click(); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); if (!busy) input.current?.click(); } }}
        className="rounded-md border border-dashed border-[#C9A96E] bg-[#FBF7F0] inline-flex items-center justify-center text-[#7A4E2D] shrink-0 cursor-pointer" style={box}>
        {busy ? <Loader2 size={Math.max(12, size / 3)} className="animate-spin" /> : <Camera size={Math.max(12, size / 3)} />}
      </span>
      <input ref={input} type="file" accept="image/*" className="hidden" onClick={e => e.stopPropagation()} onChange={e => pick(e.target.files?.[0])} />
      {err ? <span className="sr-only">{err}</span> : null}
    </>
  );
}
