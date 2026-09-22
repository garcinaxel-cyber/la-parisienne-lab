'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Ban, RotateCcw, Upload } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { unexcludeSkuAction, setExcludedSkuImageAction } from '../../odoo-changes-actions';
import { thumb } from '@/lib/img-thumb';

type Row = { sku: string; product_name: string | null; reason: string | null; image_url?: string | null; created_at: string };

export default function ExcludedView({ rows }: { rows: Row[] }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [restoring, setRestoring] = useState<string | null>(null);
  // Photo upload (Axel, 2026-09-22: "laisse moi la possibilité de mettre une photo") — these
  // items have no fiche/variant to hang an image_url off, so it lives on lab_excluded_skus
  // itself, same 'lab-images' bucket + upload pattern as FicheEditor's variant photos. Also
  // shown to shop managers ordering it (searchManagerOrderProductsAction reads this column).
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function restore(sku: string) {
    setRestoring(sku);
    await unexcludeSkuAction(sku);
    setRestoring(null);
    router.refresh();
  }

  async function handleImageFile(sku: string, file: File) {
    if (!file.type.startsWith('image/')) return;
    setUploading(sku);
    const supabase = createClient();
    const ext = file.name.split('.').pop() ?? 'jpg';
    // Unique filename per upload — fixed path + CDN cache made replaced photos appear unchanged.
    const path = `excluded/${sku}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('lab-images').upload(path, file, { upsert: true });
    if (!error) {
      const { data: urlData } = supabase.storage.from('lab-images').getPublicUrl(path);
      await setExcludedSkuImageAction(sku, urlData.publicUrl);
      router.refresh();
    }
    setUploading(null);
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy">
          {lang === 'vi' ? 'Sản phẩm không sản xuất' : 'Non-production items'}
        </h1>
        <p className="text-ink-light text-sm mt-1">
          {lang === 'vi'
            ? 'Bao bì, đồ uống, sticker… — không bao giờ tạo thẻ sản xuất và không cảnh báo khi nhập đơn.'
            : 'Packaging, drinks, stickers… — never turned into production cards and never flagged at import.'}
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-b border-border-soft">
          <div className="col-span-1"></div>
          <div className="col-span-2">SKU</div>
          <div className="col-span-5">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
          <div className="col-span-4 text-right">{lang === 'vi' ? 'Khôi phục' : 'Restore'}</div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-light flex flex-col items-center gap-2">
            <Ban size={28} className="text-border-soft" />
            {lang === 'vi' ? 'Chưa có sản phẩm nào bị loại' : 'No items excluded yet'}
          </div>
        ) : (
          <div className="divide-y divide-border-soft">
            {rows.map(r => (
              <div key={r.sku} className="grid grid-cols-12 items-center px-4 py-2.5 gap-2">
                <div className="col-span-1">
                  <input ref={el => { fileInputs.current[r.sku] = el; }} type="file" accept="image/*" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(r.sku, f); e.target.value = ''; }} />
                  <button onClick={() => fileInputs.current[r.sku]?.click()} disabled={uploading === r.sku}
                    className="relative w-9 h-9 rounded-lg overflow-hidden border flex items-center justify-center shrink-0"
                    style={{ borderColor: '#E0D49A', backgroundColor: '#F1EFE8' }}
                    title={lang === 'vi' ? 'Thêm ảnh' : 'Ajouter une photo'}>
                    {r.image_url ? (
                      <img src={thumb(r.image_url, 80)} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    ) : (
                      <Upload size={13} style={{ color: uploading === r.sku ? '#B8AE7A' : '#8A8570' }} />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <code className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: '#F1EFE8', color: '#5F5E5A' }}>{r.sku}</code>
                </div>
                <div className="col-span-5 text-sm text-navy truncate">{r.product_name || '—'}</div>
                <div className="col-span-4 flex justify-end">
                  <button onClick={() => restore(r.sku)} disabled={restoring === r.sku}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border flex items-center gap-1.5 transition-colors"
                    style={{ borderColor: '#E0D49A', color: '#2D6A4F' }}>
                    <RotateCcw size={12} />
                    {restoring === r.sku ? '…' : (lang === 'vi' ? 'Khôi phục' : 'Restore')}
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
