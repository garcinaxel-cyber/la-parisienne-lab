'use client';
// "Không thấy" on the finished-goods inventory (Axel, 2026-11-11): the same path as the raw
// materials and packaging — photo + quantity + unit + a word while counting; in the recap the
// assistant searches the product, the quantity is added to its line. Sending waits until every
// photo is handled.
import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Search, X } from 'lucide-react';
import { compressImage } from '@/lib/compress-image';
import { addFgUnknownAction, resolveFgUnknownAction, type FgUnknown } from '../actions';

const NAVY = '#1A4731', GOLD_TEXT = '#8A6D14', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318', OK = '#067647';
const UNITS_VI = ['cái', 'hộp', 'gói', 'kg', 'g'];
const UNITS_FR = ['pièce', 'boîte', 'sachet', 'kg', 'g'];

export function FgUnknownSheet({ sessionId, vi, onClose, onAdded }: { sessionId: string; vi: boolean; onClose: () => void; onAdded: (u: FgUnknown) => void }) {
  const L = (v: string, f: string) => (vi ? v : f);
  const units = vi ? UNITS_VI : UNITS_FR;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [qty, setQty] = useState(''); const [unit, setUnit] = useState(units[0]); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.click(); }, []);
  const pick = async (f?: File) => { if (!f) return; const c = await compressImage(f, 1280, 0.8).catch(() => f); setFile(c); setPreview(URL.createObjectURL(c)); };
  const send = async () => {
    if (!file && !note.trim()) { setErr(L('Chụp ảnh hoặc ghi chú', 'Photo ou un mot requis')); return; }
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set('sessionId', sessionId); if (file) fd.set('file', file, 'photo.jpg');
    fd.set('qty', qty); fd.set('unit', unit); fd.set('note', note);
    const r = await addFgUnknownAction(fd); setBusy(false);
    if (r.error || !r.unknown) { setErr(r.error ?? 'Error'); return; }
    onAdded(r.unknown);
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between"><div className="text-[16px] font-extrabold" style={{ color: NAVY }}>{L('Không tìm thấy sản phẩm', 'Article introuvable')}</div>
          <button aria-label="Close" onClick={onClose}><X size={20} /></button></div>
        <button onClick={() => input.current?.click()} className="w-full h-48 rounded-xl flex items-center justify-center overflow-hidden" style={{ backgroundColor: '#F3EBD2' }}>
          {preview ? <img src={preview} alt="" className="w-full h-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-[13px] font-bold" style={{ color: GOLD_TEXT }}><Camera size={28} />{L('Chụp ảnh', 'Prendre la photo')}</span>}
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => pick(e.target.files?.[0])} />
        <div className="flex gap-2">
          <input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} placeholder={L('Số lượng', 'Quantité')} className="w-24 rounded-lg px-3 py-2.5 text-[16px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
          <select value={unit} onChange={e => setUnit(e.target.value)} className="rounded-lg px-2 text-[14px] bg-white" style={{ border: '1px solid #D1D5DB' }}>
            {units.map(u => <option key={u}>{u}</option>)}
          </select>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={L('Tên gọi', 'Un mot')} className="flex-1 min-w-0 rounded-lg px-3 py-2.5 text-[14px]" style={{ border: '1px solid #D1D5DB' }} />
        </div>
        {err && <div className="text-[13px] font-semibold" style={{ color: LATE }}>{err}</div>}
        <button disabled={busy} onClick={send} className="w-full rounded-xl py-3 text-[14px] font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: GOLD_TEXT }}>
          {busy ? <Loader2 size={16} className="animate-spin inline" /> : L('Gửi "cần xác định" và đếm tiếp', 'Envoyer « à identifier » et continuer')}</button>
      </div>
    </div>
  );
}

type Picked = { fiche_id: string | null; variant_id: string | null; sku: string; product_name_vi: string; product_name_en: string | null; category: string | null; label: string };

export function FgUnknownRow({ u, vi, onDone }: { u: FgUnknown; vi: boolean; onDone: (u: FgUnknown, matched?: { sku: string; qty: number; product: Picked }) => void }) {
  const L = (v: string, f: string) => (vi ? v : f);
  const [q, setQ] = useState(u.note ?? '');
  const [hits, setHits] = useState<any[]>([]);
  const [pick, setPick] = useState<Picked | null>(null);
  const [qty, setQty] = useState(u.qty != null ? String(u.qty) : '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (u.status !== 'open' || q.trim().length < 2 || pick) { setHits([]); return; }
    const t = setTimeout(async () => {
      try { const r = await fetch(`/api/lab/products-search?q=${encodeURIComponent(q.trim())}`); const d = await r.json(); setHits(Array.isArray(d) ? d.slice(0, 6) : []); }
      catch { setHits([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, pick, u.status]);
  const done = async (status: 'matched' | 'ignored') => {
    const n = Number(qty.replace(',', '.'));
    if (status === 'matched' && (!pick || !qty.trim() || !Number.isFinite(n) || n < 0)) { setErr(L('Chọn sản phẩm và số lượng', 'Choisis le produit et la quantité')); return; }
    setBusy(true); setErr(null);
    const { label, ...product } = pick ?? ({} as Picked); void label;
    const r = await resolveFgUnknownAction(u.id, status === 'matched' ? { status, product, qty: n } : { status });
    setBusy(false); if (r.error) { setErr(r.error); return; }
    onDone({ ...u, status, resolvedSku: pick?.sku ?? null }, status === 'matched' && pick ? { sku: pick.sku, qty: n, product: pick } : undefined);
  };
  return (
    <div className="rounded-xl p-2.5 space-y-2 bg-white" style={{ border: `1px solid ${HAIR}` }}>
      <div className="flex gap-2.5">
        {u.photoUrl ? <a href={u.photoUrl} target="_blank" rel="noreferrer"><img src={u.photoUrl} alt="" className="w-20 h-20 rounded-lg object-cover" /></a> : <div className="w-20 h-20 rounded-lg" style={{ backgroundColor: '#F3EBD2' }} />}
        <div className="flex-1 min-w-0 text-[12.5px] space-y-0.5">
          <div className="font-extrabold text-[13.5px]">{u.qty != null ? `${u.qty} ${u.unit ?? ''}` : '—'}{u.note ? ` · « ${u.note} »` : ''}</div>
          <div style={{ color: '#5B6B63' }}>{u.createdBy} · {new Date(u.createdAt).toLocaleString('fr-FR', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          {u.status !== 'open' && <div className="font-bold" style={{ color: u.status === 'matched' ? OK : '#5B6B63' }}>
            {u.status === 'matched' ? `✓ ${u.resolvedSku ?? ''}` : L('Không kiểm kê', 'Hors inventaire')}</div>}
        </div>
      </div>
      {u.status === 'open' && (<>
        <label className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ border: `2px solid ${NAVY}` }}>
          <Search size={15} color="#5B6B63" /><input value={q} onChange={e => { setQ(e.target.value); setPick(null); }} placeholder={L('Tìm sản phẩm', 'Chercher le produit')} className="flex-1 outline-none text-[14px]" />
        </label>
        {!pick && hits.map((h: any) => (
          <div key={h.id} className="rounded-lg p-1.5 space-y-1" style={{ border: `1px solid ${BORDER}` }}>
            <div className="text-[12.5px] font-bold">{vi ? h.name_vi : (h.name_en || h.name_vi)}</div>
            <div className="flex flex-wrap gap-1.5">
              {(h.variants ?? []).filter((v: any) => v.sku).map((v: any) => (
                <button key={v.id} onClick={() => setPick({ fiche_id: h.id, variant_id: v.id, sku: v.sku, product_name_vi: h.name_vi, product_name_en: h.name_en ?? null, category: h.category_id || 'Autre', label: `${vi ? h.name_vi : (h.name_en || h.name_vi)} · ${v.label ?? v.sku}` })}
                  className="text-[11.5px] font-semibold rounded-lg px-2 py-1" style={{ border: '1px solid #D1D5DB' }}>{v.label} · {v.sku}</button>
              ))}
            </div>
          </div>
        ))}
        {pick && <div className="flex items-center gap-2 flex-wrap">
          <span className="flex-1 min-w-0 text-[13px] font-extrabold">{pick.label}</span>
          <input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} className="w-20 rounded-lg px-2 py-2 text-[15px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
          <button disabled={busy} onClick={() => done('matched')} className="rounded-lg px-3 py-2 text-[12.5px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{L('Chọn', 'Choisir')}</button>
        </div>}
        {err && <div className="text-[12px] font-semibold" style={{ color: LATE }}>{err}</div>}
        <button disabled={busy} onClick={() => done('ignored')} className="w-full rounded-lg py-2 text-[12px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#5B6B63' }}>{L('Không kiểm kê', 'Hors inventaire')}</button>
      </>)}
    </div>
  );
}
