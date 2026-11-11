'use client';
import { useI18n } from '@/lib/i18n';
import RawMaterialsTab from '@/app/station/[team]/RawMaterialsTab';

export default function PackagingView({ userName }: { userName: string | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  return (
    <div className="max-w-2xl mx-auto px-3 sm:px-0 py-4 space-y-3">
      <div>
        <h1 className="font-serif text-2xl font-bold" style={{ color: '#1A4731' }}>{vi ? 'Đặt bao bì' : 'Packaging order'}</h1>
        <p className="text-[13px] mt-0.5" style={{ color: '#6B7280' }}>{vi ? 'Yêu cầu gửi thẳng cho Ms Flavor · hàng nhập vào kho Lab' : 'Requests go straight to Ms Flavor · goods received into the Lab storage'}</p>
      </div>
      <RawMaterialsTab team="packaging" lang={vi ? 'vi' : 'en'} userName={userName} packaging />
    </div>
  );
}
