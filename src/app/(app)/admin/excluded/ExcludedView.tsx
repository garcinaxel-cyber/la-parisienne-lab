'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Ban, RotateCcw } from 'lucide-react';
import { unexcludeSkuAction } from '../../odoo-changes-actions';

type Row = { sku: string; product_name: string | null; reason: string | null; created_at: string };

export default function ExcludedView({ rows }: { rows: Row[] }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [restoring, setRestoring] = useState<string | null>(null);

  async function restore(sku: string) {
    setRestoring(sku);
    await unexcludeSkuAction(sku);
    setRestoring(null);
    router.refresh();
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
          <div className="col-span-3">SKU</div>
          <div className="col-span-6">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
          <div className="col-span-3 text-right">{lang === 'vi' ? 'Khôi phục' : 'Restore'}</div>
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
                <div className="col-span-3">
                  <code className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: '#F1EFE8', color: '#5F5E5A' }}>{r.sku}</code>
                </div>
                <div className="col-span-6 text-sm text-navy truncate">{r.product_name || '—'}</div>
                <div className="col-span-3 flex justify-end">
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
