'use client';
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Ban, RotateCcw, Upload, Eye, EyeOff, Search, Plus, Check } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import {
  unexcludeSkuAction, setExcludedSkuImageAction, setExcludedSkuShopVisibleAction,
  searchOdooForExclusionAction, addExcludedFromOdooAction, type OdooCandidate,
} from '../../odoo-changes-actions';
import { thumb } from '@/lib/img-thumb';

type Row = { sku: string; product_name: string | null; reason: string | null; image_url?: string | null; shop_visible: boolean; created_at: string };
type Filter = 'all' | 'visible' | 'hidden';

// Non-production items (Axel, 2026-10-31): hide an item from the shops, add items from Odoo
// (one search or several codes pasted at once), filter the list.
export default function ExcludedView({ rows }: { rows: Row[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── filter ──
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const counts = useMemo(() => ({
    all: rows.length, visible: rows.filter(r => r.shop_visible).length, hidden: rows.filter(r => !r.shop_visible).length,
  }), [rows]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter(r => (filter === 'all' || (filter === 'visible') === r.shop_visible)
      && (!t || (r.sku + ' ' + (r.product_name ?? '')).toLowerCase().includes(t)));
  }, [rows, q, filter]);

  // ── add from Odoo ──
  const [oq, setOq] = useState('');
  const [results, setResults] = useState<OdooCandidate[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [addVisible, setAddVisible] = useState(true);
  const [confirmProd, setConfirmProd] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function runSearch() {
    setSearchErr(null); setMsg(null); setConfirmProd(null);
    start(async () => {
      const r = await searchOdooForExclusionAction(oq);
      if (r.error) { setSearchErr(r.error); setResults(null); return; }
      setResults(r.products ?? []);
    });
  }
  function add(items: OdooCandidate[]) {
    if (!items.length) return;
    start(async () => {
      const r = await addExcludedFromOdooAction(items.map(i => ({ sku: i.sku, name: i.name })), addVisible);
      if (r.error) { setMsg(r.error); return; }
      setAdded(prev => { const n = new Set(prev); items.forEach(i => n.add(i.sku)); return n; });
      setMsg(vi ? `Đã thêm ${r.added ?? 0} sản phẩm` : `${r.added ?? 0} item(s) added`);
      setConfirmProd(null);
      router.refresh();
    });
  }
  const addable = (results ?? []).filter(p => !p.inList && !p.isProduction && !added.has(p.sku));

  async function restore(sku: string) {
    setRestoring(sku);
    await unexcludeSkuAction(sku);
    setRestoring(null);
    router.refresh();
  }
  async function toggleVisible(r: Row) {
    setToggling(r.sku);
    await setExcludedSkuShopVisibleAction(r.sku, !r.shop_visible);
    setToggling(null);
    router.refresh();
  }
  async function handleImageFile(sku: string, file: File) {
    if (!file.type.startsWith('image/')) return;
    setUploading(sku);
    const supabase = createClient();
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `excluded/${sku}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('lab-images').upload(path, file, { upsert: true });
    if (!error) {
      const { data: urlData } = supabase.storage.from('lab-images').getPublicUrl(path);
      await setExcludedSkuImageAction(sku, urlData.publicUrl);
      router.refresh();
    }
    setUploading(null);
  }

  const chip = (k: Filter, label: string) => (
    <button key={k} onClick={() => setFilter(k)}
      className="text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors"
      style={filter === k ? { borderColor: '#B08A2E', backgroundColor: '#F7EBCB', color: '#3B2A1A' } : { borderColor: '#E0D49A', color: '#5F5E5A' }}>
      {label} · {counts[k]}
    </button>
  );

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy">{vi ? 'Sản phẩm không sản xuất' : 'Non-production items'}</h1>
        <p className="text-ink-light text-sm mt-1">
          {vi ? 'Bao bì, đồ uống, sticker… — không bao giờ tạo thẻ sản xuất. Ẩn một sản phẩm để cửa hàng không thấy khi đặt hàng và kiểm kho.'
              : 'Packaging, drinks, stickers… — never turned into production cards. Hide an item so shops no longer see it when ordering or counting stock.'}
        </p>
      </div>

      {/* Add from Odoo */}
      <div className="card p-4 space-y-3">
        <div className="text-sm font-semibold text-navy flex items-center gap-2"><Plus size={15} />{vi ? 'Thêm từ Odoo' : 'Add from Odoo'}</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={oq} onChange={e => setOq(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
            placeholder={vi ? 'Tên hoặc mã, hoặc dán nhiều mã (VTTH0103, VTTH026…)' : 'Name or code, or paste several codes (VTTH0103, VTTH026…)'}
            className="flex-1 border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#E0D49A' }} />
          <button onClick={runSearch} disabled={pending || oq.trim().length < 2}
            className="text-sm font-semibold px-4 py-2 rounded-lg border flex items-center justify-center gap-1.5"
            style={{ borderColor: '#B08A2E', color: '#3B2A1A', backgroundColor: '#F7EBCB' }}>
            <Search size={14} />{pending ? '…' : (vi ? 'Tìm' : 'Search')}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-light">
          <input type="checkbox" checked={addVisible} onChange={e => setAddVisible(e.target.checked)} />
          {vi ? 'Cửa hàng thấy được sản phẩm thêm vào' : 'Added items are visible to shops'}
        </label>
        {searchErr && <div className="text-xs" style={{ color: '#A8573B' }}>{searchErr}</div>}
        {msg && <div className="text-xs" style={{ color: '#2D6A4F' }}>{msg}</div>}
        {results && (
          results.length === 0 ? (
            <div className="text-xs text-ink-light">{vi ? 'Không tìm thấy sản phẩm trên Odoo' : 'No product found in Odoo'}</div>
          ) : (
            <div className="border rounded-lg divide-y" style={{ borderColor: '#EFE6C8' }}>
              {addable.length > 1 && (
                <div className="flex justify-end px-3 py-2">
                  <button onClick={() => add(addable)} disabled={pending}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1.5"
                    style={{ borderColor: '#2D6A4F', color: '#2D6A4F' }}>
                    <Plus size={12} />{vi ? `Thêm tất cả (${addable.length})` : `Add all (${addable.length})`}
                  </button>
                </div>
              )}
              {results.map(p => {
                const done = p.inList || added.has(p.sku);
                return (
                  <div key={p.sku} className="flex items-center gap-2 px-3 py-2">
                    <code className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: '#F1EFE8', color: '#5F5E5A' }}>{p.sku}</code>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-navy truncate">{p.name}</div>
                      {p.isProduction && !done && (
                        <div className="text-[11px]" style={{ color: '#A8573B' }}>
                          {vi ? 'Sản phẩm sản xuất — thêm vào sẽ dừng tạo thẻ sản xuất' : 'Production product — adding it stops its production cards'}
                        </div>
                      )}
                    </div>
                    {done ? (
                      <span className="text-xs flex items-center gap-1 shrink-0" style={{ color: '#2D6A4F' }}><Check size={12} />{vi ? 'Đã có' : 'In list'}</span>
                    ) : p.isProduction && confirmProd !== p.sku ? (
                      <button onClick={() => setConfirmProd(p.sku)} className="text-xs font-semibold px-3 py-1.5 rounded-lg border shrink-0"
                        style={{ borderColor: '#A8573B', color: '#A8573B' }}>{vi ? 'Thêm…' : 'Add…'}</button>
                    ) : (
                      <button onClick={() => add([p])} disabled={pending} className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1 shrink-0"
                        style={p.isProduction ? { borderColor: '#A8573B', color: '#fff', backgroundColor: '#A8573B' } : { borderColor: '#2D6A4F', color: '#2D6A4F' }}>
                        <Plus size={12} />{p.isProduction ? (vi ? 'Xác nhận' : 'Confirm') : (vi ? 'Thêm' : 'Add')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={vi ? 'Lọc theo mã hoặc tên' : 'Filter by code or name'}
            className="w-full border rounded-lg pl-8 pr-3 py-2 text-sm" style={{ borderColor: '#E0D49A' }} />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {chip('all', vi ? 'Tất cả' : 'All')}
          {chip('visible', vi ? 'Cửa hàng thấy' : 'Visible to shops')}
          {chip('hidden', vi ? 'Đã ẩn' : 'Hidden')}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-b border-border-soft">
          <div className="col-span-1"></div>
          <div className="col-span-2">SKU</div>
          <div className="col-span-4">{vi ? 'Sản phẩm' : 'Product'}</div>
          <div className="col-span-5 text-right">{vi ? 'Cửa hàng · Khôi phục' : 'Shops · Restore'}</div>
        </div>
        {shown.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-light flex flex-col items-center gap-2">
            <Ban size={28} className="text-border-soft" />
            {rows.length === 0 ? (vi ? 'Chưa có sản phẩm nào bị loại' : 'No items excluded yet') : (vi ? 'Không có kết quả' : 'No match')}
          </div>
        ) : (
          <div className="divide-y divide-border-soft">
            {shown.map(r => (
              <div key={r.sku} className="grid grid-cols-12 items-center px-4 py-2.5 gap-2" style={r.shop_visible ? undefined : { backgroundColor: '#FAF6EF' }}>
                <div className="col-span-1">
                  <input ref={el => { fileInputs.current[r.sku] = el; }} type="file" accept="image/*" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(r.sku, f); e.target.value = ''; }} />
                  <button onClick={() => fileInputs.current[r.sku]?.click()} disabled={uploading === r.sku}
                    className="relative w-9 h-9 rounded-lg overflow-hidden border flex items-center justify-center shrink-0"
                    style={{ borderColor: '#E0D49A', backgroundColor: '#F1EFE8' }}
                    title={vi ? 'Thêm ảnh' : 'Add a photo'}>
                    {r.image_url ? (
                      <img src={thumb(r.image_url, 80)} alt="" className="absolute inset-0 w-full h-full object-cover" style={r.shop_visible ? undefined : { opacity: 0.5 }} />
                    ) : (
                      <Upload size={13} style={{ color: uploading === r.sku ? '#B8AE7A' : '#8A8570' }} />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <code className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: '#F1EFE8', color: '#5F5E5A' }}>{r.sku}</code>
                </div>
                <div className="col-span-4 text-sm truncate" style={{ color: r.shop_visible ? undefined : '#8A8570' }}>{r.product_name || '—'}</div>
                <div className="col-span-5 flex justify-end gap-1.5">
                  <button onClick={() => toggleVisible(r)} disabled={toggling === r.sku}
                    title={r.shop_visible ? (vi ? 'Ẩn với cửa hàng' : 'Hide from shops') : (vi ? 'Hiện cho cửa hàng' : 'Show to shops')}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors"
                    style={r.shop_visible ? { borderColor: '#E0D49A', color: '#3B2A1A' } : { borderColor: '#D8CDB8', color: '#8A8570', backgroundColor: '#F1EFE8' }}>
                    {r.shop_visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    {toggling === r.sku ? '…' : r.shop_visible ? (vi ? 'Hiện' : 'Visible') : (vi ? 'Ẩn' : 'Hidden')}
                  </button>
                  <button onClick={() => restore(r.sku)} disabled={restoring === r.sku}
                    title={vi ? 'Trả về sản xuất' : 'Back to production'}
                    className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors"
                    style={{ borderColor: '#E0D49A', color: '#2D6A4F' }}>
                    <RotateCcw size={12} />
                    {restoring === r.sku ? '…' : (vi ? 'Khôi phục' : 'Restore')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
