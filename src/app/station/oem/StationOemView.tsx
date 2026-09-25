'use client';
import Link from 'next/link';
import { ArrowLeft, Factory } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import OemOrdersView from '@/components/oem/OemOrdersView';

export default function StationOemView(props: { role: string; userId: string | null; userName: string | null }) {
  const { lang, setLang } = useI18n();
  const vi = lang === 'vi';
  return (
    <div className="min-h-screen" style={{ backgroundColor: '#F7F5F0' }}>
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2.5 text-white" style={{ backgroundColor: '#1A4731' }}>
        <Link href="/station/me" className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }} aria-label="back">
          <ArrowLeft size={16} />
        </Link>
        <Factory size={18} />
        <div className="font-bold text-sm sm:text-base flex-1">{vi ? 'Đơn hàng OEM' : 'OEM Orders'}</div>
        <button onClick={() => setLang(vi ? 'en' : 'vi')} className="text-xs font-bold rounded-lg px-2 py-1" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
          {vi ? 'EN' : 'VI'}
        </button>
      </div>
      <div className="p-3 sm:p-5">
        <OemOrdersView {...props} />
      </div>
    </div>
  );
}
