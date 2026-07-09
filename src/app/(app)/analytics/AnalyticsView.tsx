'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { Package, CheckCircle2, ClipboardList, AlertCircle } from 'lucide-react';

type Kpis = { unitsProduced: number; unitsPlanned: number; completion: number; orders: number; blocked: number };
type TeamStat = { team: string; completion: number; units: number };
type Daily = { date: string; units: number; total: number; done: number; completion: number };

export default function AnalyticsView({ days, kpis, teams, topProducts, reasons, daily }: {
  days: number; kpis: Kpis; teams: TeamStat[];
  topProducts: { name: string; qty: number }[];
  reasons: { reason: string; count: number }[];
  daily: Daily[];
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const current = params.get('range') ?? '30';

  const setRange = (r: string) => router.push(`/analytics?range=${r}`);
  const maxUnits = Math.max(1, ...daily.map(d => d.units));

  const kpiCards = [
    { label: lang === 'vi' ? 'Đã sản xuất' : 'Units produced', value: kpis.unitsProduced.toLocaleString(), icon: Package, color: 'text-navy' },
    { label: lang === 'vi' ? 'Tỷ lệ hoàn thành' : 'Completion rate', value: `${kpis.completion}%`, icon: CheckCircle2, color: 'text-green-600' },
    { label: lang === 'vi' ? 'Đơn đã phát hành' : 'Published imports', value: kpis.orders, icon: ClipboardList, color: 'text-navy' },
    { label: lang === 'vi' ? 'Sản phẩm bị chặn' : 'Blocked products', value: kpis.blocked, icon: AlertCircle, color: kpis.blocked > 0 ? 'text-amber-600' : 'text-ink-light' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy">
            {lang === 'vi' ? 'Phân tích & lịch sử' : 'Analytics & history'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {lang === 'vi' ? `${days} ngày qua` : `Last ${days} days`}
          </p>
        </div>
        <div className="flex gap-1.5">
          {[['7', '7' + (lang === 'vi' ? ' ngày' : 'd')], ['30', '30' + (lang === 'vi' ? ' ngày' : 'd')], ['90', '90' + (lang === 'vi' ? ' ngày' : 'd')]].map(([r, label]) => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                current === r ? 'bg-navy text-white' : 'bg-white border border-border-soft text-ink-light hover:text-navy'
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpiCards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-4 flex items-center gap-3">
            <Icon size={20} className={color} />
            <div>
              <div className="text-xl font-bold text-navy leading-tight">{value}</div>
              <div className="text-[11px] text-ink-light">{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Completion by team */}
        <div className="card p-4">
          <h2 className="font-semibold text-sm text-navy mb-3">{lang === 'vi' ? 'Hoàn thành theo đội' : 'Completion by team'}</h2>
          {teams.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-2.5">
              {teams.map(t => {
                const meta = TEAM_LABELS[t.team as Team];
                return (
                  <div key={t.team}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-navy">{meta ? (lang === 'vi' ? meta.vi : meta.en) : t.team}</span>
                      <span className="text-ink-light">{t.completion}% · {t.units.toLocaleString()} {lang === 'vi' ? 'cái' : 'units'}</span>
                    </div>
                    <div className="h-2 rounded-full bg-border-soft overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${t.completion}%`, backgroundColor: meta?.color ?? '#1A4731' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top products */}
        <div className="card p-4">
          <h2 className="font-semibold text-sm text-navy mb-3">{lang === 'vi' ? 'Sản phẩm nhiều nhất' : 'Top products made'}</h2>
          {topProducts.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-1.5">
              {topProducts.map(p => (
                <div key={p.name} className="flex justify-between text-[13px]">
                  <span className="text-navy truncate pr-3">{p.name}</span>
                  <span className="font-semibold text-navy shrink-0">{p.qty.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Blocked reasons */}
        <div className="card p-4">
          <h2 className="font-semibold text-sm text-navy mb-3">{lang === 'vi' ? 'Lý do bị chặn' : 'Blocked reasons'}</h2>
          {reasons.length === 0 ? (
            <p className="text-xs text-ink-light">{lang === 'vi' ? 'Không có sản phẩm bị chặn 🎉' : 'No blocked products 🎉'}</p>
          ) : (
            <div className="space-y-1.5">
              {reasons.map(r => (
                <div key={r.reason} className="flex justify-between items-center text-[13px]">
                  <span className="text-navy truncate pr-3">{r.reason}</span>
                  <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Volume per day */}
        <div className="card p-4">
          <h2 className="font-semibold text-sm text-navy mb-3">{lang === 'vi' ? 'Sản lượng theo ngày' : 'Volume per day'}</h2>
          {daily.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <>
              <div className="flex items-end gap-1 h-28">
                {daily.slice(-14).map(d => (
                  <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                    <span className="text-[10px] font-bold text-navy mb-0.5">{d.units.toLocaleString()}</span>
                    <div className="w-full rounded-t transition-all"
                      style={{ height: `${Math.max(6, d.units / maxUnits * 100)}%`, backgroundColor: d.completion === 100 ? '#16A34A' : '#0369a1' }} />
                    <span className="text-[9px] text-ink-light mt-1 truncate w-full text-center">
                      {new Date(d.date + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-ink-light mt-1.5 text-center">
                {lang === 'vi' ? '14 ngày gần nhất · xanh lá = hoàn thành 100%' : 'Last 14 days · green = 100% complete'}
              </div>
            </>
          )}
        </div>
      </div>

      {/* History table */}
      <div className="card overflow-hidden">
        <h2 className="font-semibold text-sm text-navy px-4 pt-4 pb-2">{lang === 'vi' ? 'Lịch sử theo ngày' : 'Day-by-day history'}</h2>
        <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-t border-border-soft">
          <div className="col-span-5">{lang === 'vi' ? 'Ngày' : 'Date'}</div>
          <div className="col-span-2 text-center">{lang === 'vi' ? 'Thẻ' : 'Cards'}</div>
          <div className="col-span-2 text-center">{lang === 'vi' ? 'Cái' : 'Units'}</div>
          <div className="col-span-3 text-right">{lang === 'vi' ? 'Hoàn thành' : 'Completed'}</div>
        </div>
        <div className="divide-y divide-border-soft max-h-80 overflow-y-auto">
          {daily.slice().reverse().map(d => (
            <div key={d.date} className="grid grid-cols-12 px-4 py-2 text-sm items-center">
              <div className="col-span-5 text-navy capitalize">
                {new Date(d.date + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              </div>
              <div className="col-span-2 text-center text-ink-light">{d.total}</div>
              <div className="col-span-2 text-center font-semibold text-navy">{d.units.toLocaleString()}</div>
              <div className={`col-span-3 text-right font-semibold ${d.completion === 100 ? 'text-green-600' : 'text-amber-600'}`}>{d.completion}%</div>
            </div>
          ))}
          {daily.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-ink-light">{lang === 'vi' ? 'Chưa có dữ liệu' : 'No data yet'}</div>
          )}
        </div>
      </div>
    </div>
  );
}
