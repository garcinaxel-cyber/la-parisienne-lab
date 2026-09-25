'use client';
import { Factory } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import OemOrdersView from '@/components/oem/OemOrdersView';

export default function OemOrdersPageView(props: { role: string; userId: string | null; userName: string | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
          <Factory size={26} style={{ color: '#1A4731' }} /> {vi ? 'Đơn hàng OEM' : 'OEM Orders'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {vi ? 'Theo dõi đơn Maison Mooncake và Tianhe Food — tách biệt hoàn toàn với sản xuất cửa hàng.'
              : 'Maison Mooncake and Tianhe Food orders — fully separate from shop production.'}
        </p>
      </div>
      <OemOrdersView {...props} />
    </div>
  );
}
