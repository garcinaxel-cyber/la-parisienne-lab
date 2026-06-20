'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { FileSpreadsheet, ChevronRight } from 'lucide-react';

export default function OrdersListView({ imports }: { imports: any[] }) {
  const { lang } = useI18n();

  // Group by delivery_date
  const grouped = imports.reduce<Record<string, any[]>>((acc, imp) => {
    (acc[imp.delivery_date] ??= []).push(imp);
    return acc;
  }, {});

  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });

  const isToday = (d: string) => d === new Date().toISOString().split('T')[0];

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl font-bold text-navy">
          {lang === 'vi' ? 'Đơn sản xuất' : 'Production orders'}
        </h1>
        <Link href="/import" className="btn-primary">{lang === 'vi' ? '+ Nhập mới' : '+ New import'}</Link>
      </div>

      {dates.length === 0 && (
        <div className="card p-12 text-center">
          <FileSpreadsheet size={40} className="mx-auto mb-3 text-border-soft" />
          <p className="text-ink-light">{lang === 'vi' ? 'Chưa có đơn nào' : 'No orders yet'}</p>
          <Link href="/import" className="btn-primary mt-4 mx-auto">
            {lang === 'vi' ? 'Nhập đơn đầu tiên' : 'Import first order'}
          </Link>
        </div>
      )}

      {dates.map(date => (
        <div key={date} className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">
              {formatDate(date)}
            </h2>
            {isToday(date) && (
              <span className="badge bg-gold/20 text-gold text-[10px] font-bold uppercase tracking-wide">
                {lang === 'vi' ? 'Hôm nay' : 'Today'}
              </span>
            )}
          </div>

          <Link href={`/orders/${date}`}
            className="card block hover:bg-cream/60 transition-colors overflow-hidden">
            <div className="divide-y divide-border-soft">
              {grouped[date].map((imp: any) => (
                <div key={imp.id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-1.5 h-8 rounded-full shrink-0 ${
                      imp.status === 'published' ? 'bg-green-500' :
                      imp.status === 'draft' ? 'bg-amber-400' : 'bg-red-400'
                    }`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-navy">
                        {imp.type === 'daily'
                          ? (lang === 'vi' ? 'Đơn chính' : 'Main order')
                          : (lang === 'vi' ? 'Đơn bánh khẩn' : 'Urgent cake order')}
                        {' '}#{imp.order_number}
                      </div>
                      <div className="text-xs text-ink-light flex gap-2 flex-wrap">
                        {imp.shipped_from_lab && <span>⚡ {lang === 'vi' ? 'Giao từ lab' : 'Ships from lab'}</span>}
                        {imp.notes && <span className="truncate max-w-[200px]">{imp.notes}</span>}
                        <span>
                          {lang === 'vi' ? 'Nhập lúc' : 'Imported'}{' '}
                          {new Date(imp.imported_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <span className={`badge text-xs ${
                      imp.status === 'published' ? 'bg-green-100 text-green-700' :
                      imp.status === 'draft' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {imp.status === 'published'
                        ? (lang === 'vi' ? 'Đã phát' : 'Published')
                        : imp.status === 'draft'
                        ? (lang === 'vi' ? 'Nháp' : 'Draft')
                        : (lang === 'vi' ? 'Đã hủy' : 'Cancelled')}
                    </span>
                    <ChevronRight size={16} className="text-ink-light" />
                  </div>
                </div>
              ))}
            </div>
          </Link>
        </div>
      ))}
    </div>
  );
}
