'use client';
import { useI18n } from '@/lib/i18n';
import { Download, FileSpreadsheet } from 'lucide-react';

interface Day { date: string; pieces: number; cards: number; extras: number }

export default function ProductionHistoryView({ days, today }: { days: Day[]; today: string }) {
  const { lang } = useI18n();
  const fmt = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black text-navy flex items-center gap-2">
          <FileSpreadsheet size={20} />
          {lang === 'vi' ? 'Lịch sử sản xuất' : 'Historique de production'}
        </h1>
        <p className="text-sm text-ink-light mt-1">
          {lang === 'vi'
            ? 'Tổng sản xuất mỗi ngày (gồm extra). Xuất Excel để nhập vào Odoo bất cứ lúc nào — kể cả ngày đã qua.'
            : 'Production totale par jour (extra inclus). Exporte l’Excel pour Odoo à tout moment — même un jour passé oublié.'}
        </p>
      </div>

      {days.length === 0 ? (
        <div className="card p-6 text-center text-ink-light text-sm">
          {lang === 'vi' ? 'Chưa có sản xuất nào.' : 'Aucune production enregistrée.'}
        </div>
      ) : (
        <div className="card divide-y divide-border-soft overflow-hidden">
          {days.map(d => (
            <div key={d.date} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-navy truncate">
                  {fmt(d.date)}
                  {d.date === today && (
                    <span className="ml-2 text-[11px] font-black rounded-full px-2 py-0.5"
                      style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                      {lang === 'vi' ? 'Hôm nay' : 'Aujourd’hui'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-light mt-0.5">
                  <span className="font-semibold text-navy">{d.pieces}</span> {lang === 'vi' ? 'sản phẩm' : 'pièces'}
                  {' · '}{d.cards} {lang === 'vi' ? 'thẻ' : 'cartes'}
                  {d.extras > 0 && <> · {d.extras} extra</>}
                </div>
              </div>
              <a
                href={`/api/lab/production-export?date=${d.date}`}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold bg-navy text-white hover:bg-navy/90 transition-colors shrink-0"
              >
                <Download size={15} />
                {lang === 'vi' ? 'Xuất' : 'Export'}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
