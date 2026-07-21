'use client';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { Package, CheckCircle2, ClipboardList, AlertCircle, PenLine, Ban, TrendingUp } from 'lucide-react';

type Kpis = { unitsProduced: number; unitsPlanned: number; completion: number; orders: number; blocked: number };
type TeamStat = { team: string; completion: number; units: number };
type Daily = { date: string; units: number; total: number; done: number; completion: number };
type OrderKpis = {
  received: number; modifiedOrders: number; modificationEvents: number; cancelled: number;
  modRate: number; perDayAvg: number; added: number; removed: number; qtyChanged: number;
};

export default function AnalyticsView({ range, days, kpis, teams, topProducts, reasons, daily, orderKpis, modsPerDay, mostModified, aggregated = false }: {
  range: string; days: number; kpis: Kpis; teams: TeamStat[];
  topProducts: { name: string; qty: number }[];
  reasons: { reason: string; count: number }[];
  daily: Daily[];
  orderKpis: OrderKpis;
  modsPerDay: { date: string; count: number }[];
  mostModified: { ref: string; count: number }[];
  aggregated?: boolean;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const current = range;
  const vi = lang === 'vi';

  const setRange = (r: string) => router.push(`/analytics?range=${r}`);
  const maxUnits = Math.max(1, ...daily.map(d => d.units));
  const maxMods = Math.max(1, ...modsPerDay.map(d => d.count));
  const dateLabel = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', opts);

  const orderCards = [
    { label: vi ? 'Đơn nhận được' : 'Orders received', value: orderKpis.received.toLocaleString(), sub: '', icon: ClipboardList, color: 'text-navy' },
    { label: vi ? 'Đơn bị sửa' : 'Orders modified', value: orderKpis.modifiedOrders, sub: `${orderKpis.modRate}%`, icon: PenLine, color: 'text-amber-600' },
    { label: vi ? 'Lượt sửa đổi' : 'Modifications', value: orderKpis.modificationEvents, sub: vi ? `${orderKpis.perDayAvg}/ngày` : `${orderKpis.perDayAvg}/day`, icon: TrendingUp, color: 'text-navy' },
    { label: vi ? 'Đơn đã hủy' : 'Orders cancelled', value: orderKpis.cancelled, sub: '', icon: Ban, color: orderKpis.cancelled > 0 ? 'text-red-600' : 'text-ink-light' },
  ];

  const prodCards = [
    { label: vi ? 'Đã sản xuất' : 'Units produced', value: kpis.unitsProduced.toLocaleString(), icon: Package, color: 'text-navy' },
    { label: vi ? 'Tỷ lệ hoàn thành' : 'Completion rate', value: `${kpis.completion}%`, icon: CheckCircle2, color: 'text-green-600' },
    aggregated
      ? { label: vi ? 'Ngày sản xuất' : 'Production days', value: kpis.orders, icon: ClipboardList, color: 'text-navy' }
      : { label: vi ? 'Đơn đã phát hành' : 'Published imports', value: kpis.orders, icon: ClipboardList, color: 'text-navy' },
    { label: vi ? 'Sản phẩm bị chặn' : 'Blocked products', value: kpis.blocked, icon: AlertCircle, color: kpis.blocked > 0 ? 'text-amber-600' : 'text-ink-light' },
  ];

  const breakdown = [
    { label: vi ? 'Thêm sản phẩm' : 'Products added', value: orderKpis.added, color: '#16A34A' },
    { label: vi ? 'Đổi số lượng' : 'Quantity changed', value: orderKpis.qtyChanged, color: '#D97706' },
    { label: vi ? 'Gỡ sản phẩm' : 'Products removed', value: orderKpis.removed, color: '#DC2626' },
  ];
  const breakdownTotal = orderKpis.added + orderKpis.qtyChanged + orderKpis.removed;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy">
            {vi ? 'Phân tích & lịch sử' : 'Analytics & history'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {range === 'today' ? (vi ? 'Hôm nay' : 'Today') : (vi ? `${days} ngày qua` : `Last ${days} days`)}
          </p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {[
            ['today', vi ? 'Hôm nay' : 'Today'],
            ['7', '7' + (vi ? ' ngày' : 'd')],
            ['30', '30' + (vi ? ' ngày' : 'd')],
            ['60', '60' + (vi ? ' ngày' : 'd')],
            ['180', vi ? '6 tháng' : '6 mo'],
            ['365', vi ? '1 năm' : '1 yr'],
          ].map(([r, label]) => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                current === r ? 'bg-navy text-white' : 'bg-white border border-border-soft text-ink-light hover:text-navy'
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {aggregated && (
        <p className="text-xs rounded-xl px-3 py-2" style={{ backgroundColor: '#EFF6FF', color: '#1E40AF', border: '1px solid #BFDBFE' }}>
          {vi
            ? 'Khoảng dài: số liệu sản xuất từ bảng tổng hợp hằng ngày. Phân tích đơn Odoo (sửa đổi, đơn nhận) chỉ có chi tiết 60 ngày gần nhất.'
            : 'Long range: production figures come from the daily aggregates. Odoo order analysis (modifications, received) only has the last 60 days of detail.'}
        </p>
      )}

      {/* ══════════ SECTION 1 — ORDER ANALYSIS ══════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardList size={18} className="text-navy" />
          <h2 className="font-serif text-lg font-bold text-navy">{vi ? 'Phân tích đơn hàng' : 'Order analysis'}</h2>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {orderCards.map(({ label, value, sub, icon: Icon, color }) => (
            <div key={label} className="card p-4 flex items-center gap-3">
              <Icon size={20} className={color} />
              <div>
                <div className="text-xl font-bold text-navy leading-tight">
                  {value}{sub && <span className="text-xs font-semibold text-ink-light ml-1">{sub}</span>}
                </div>
                <div className="text-[11px] text-ink-light">{label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Modifications per day */}
          <div className="card p-4">
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Sửa đổi theo ngày' : 'Modifications per day'}</h3>
            {modsPerDay.length === 0 ? (
              <p className="text-xs text-ink-light">{vi ? 'Không có thay đổi nào 🎉' : 'No changes in this period 🎉'}</p>
            ) : (
              <div className="flex items-end gap-1 h-28">
                {modsPerDay.slice(-14).map(d => (
                  <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                    <span className="text-[10px] font-bold text-navy mb-0.5">{d.count}</span>
                    <div className="w-full rounded-t transition-all"
                      style={{ height: `${Math.max(6, d.count / maxMods * 100)}%`, backgroundColor: '#D97706' }} />
                    <span className="text-[9px] text-ink-light mt-1 truncate w-full text-center">
                      {dateLabel(d.date, { day: 'numeric', month: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Modification breakdown */}
          <div className="card p-4">
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Loại sửa đổi' : 'Type of change'}</h3>
            {breakdownTotal === 0 ? (
              <p className="text-xs text-ink-light">—</p>
            ) : (
              <div className="space-y-2.5">
                {breakdown.map(b => (
                  <div key={b.label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-navy">{b.label}</span>
                      <span className="text-ink-light">{b.value}</span>
                    </div>
                    <div className="h-2 rounded-full bg-border-soft overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${b.value / breakdownTotal * 100}%`, backgroundColor: b.color }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Most-modified orders */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Đơn bị sửa nhiều nhất' : 'Most-modified orders'}</h3>
          {mostModified.length === 0 ? (
            <p className="text-xs text-ink-light">—</p>
          ) : (
            <div className="space-y-1.5">
              {mostModified.map(m => (
                <div key={m.ref} className="flex justify-between items-center text-[13px]">
                  <span className="font-mono text-xs text-navy truncate pr-3">{m.ref}</span>
                  <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                    {m.count} {vi ? 'lần' : m.count > 1 ? 'changes' : 'change'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ══════════ SECTION 2 — PRODUCTION ANALYSIS ══════════ */}
      <section className="space-y-3">
        <div className="flex items-center gap-2 pt-1">
          <Package size={18} className="text-navy" />
          <h2 className="font-serif text-lg font-bold text-navy">{vi ? 'Phân tích sản xuất' : 'Production analysis'}</h2>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {prodCards.map(({ label, value, icon: Icon, color }) => (
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
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Hoàn thành theo đội' : 'Completion by team'}</h3>
            {teams.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
              <div className="space-y-2.5">
                {teams.map(t => {
                  const meta = TEAM_LABELS[t.team as Team];
                  return (
                    <div key={t.team}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-navy">{meta ? (vi ? meta.vi : meta.en) : t.team}</span>
                        <span className="text-ink-light">{t.completion}% · {t.units.toLocaleString()} {vi ? 'cái' : 'units'}</span>
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
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Sản phẩm nhiều nhất' : 'Top products made'}</h3>
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
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Lý do bị chặn' : 'Blocked reasons'}</h3>
            {reasons.length === 0 ? (
              <p className="text-xs text-ink-light">{vi ? 'Không có sản phẩm bị chặn 🎉' : 'No blocked products 🎉'}</p>
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
            <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Sản lượng theo ngày' : 'Volume per day'}</h3>
            {daily.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
              <>
                <div className="flex items-end gap-1 h-28">
                  {daily.slice(-14).map(d => (
                    <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                      <span className="text-[10px] font-bold text-navy mb-0.5">{d.units.toLocaleString()}</span>
                      <div className="w-full rounded-t transition-all"
                        style={{ height: `${Math.max(6, d.units / maxUnits * 100)}%`, backgroundColor: d.completion === 100 ? '#16A34A' : '#0369a1' }} />
                      <span className="text-[9px] text-ink-light mt-1 truncate w-full text-center">
                        {dateLabel(d.date, { day: 'numeric', month: 'numeric' })}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="text-[10px] text-ink-light mt-1.5 text-center">
                  {vi ? '14 ngày gần nhất · xanh lá = hoàn thành 100%' : 'Last 14 days · green = 100% complete'}
                </div>
              </>
            )}
          </div>
        </div>

        {/* History table */}
        <div className="card overflow-hidden">
          <h3 className="font-semibold text-sm text-navy px-4 pt-4 pb-2">{vi ? 'Lịch sử theo ngày' : 'Day-by-day history'}</h3>
          <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-t border-border-soft">
            <div className="col-span-5">{vi ? 'Ngày' : 'Date'}</div>
            <div className="col-span-2 text-center">{vi ? 'Thẻ' : 'Cards'}</div>
            <div className="col-span-2 text-center">{vi ? 'Cái' : 'Units'}</div>
            <div className="col-span-3 text-right">{vi ? 'Hoàn thành' : 'Completed'}</div>
          </div>
          <div className="divide-y divide-border-soft max-h-80 overflow-y-auto">
            {daily.slice().reverse().map(d => (
              <div key={d.date} className="grid grid-cols-12 px-4 py-2 text-sm items-center">
                <div className="col-span-5 text-navy capitalize">
                  {dateLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                </div>
                <div className="col-span-2 text-center text-ink-light">{d.total}</div>
                <div className="col-span-2 text-center font-semibold text-navy">{d.units.toLocaleString()}</div>
                <div className={`col-span-3 text-right font-semibold ${d.completion === 100 ? 'text-green-600' : 'text-amber-600'}`}>{d.completion}%</div>
              </div>
            ))}
            {daily.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-ink-light">{vi ? 'Chưa có dữ liệu' : 'No data yet'}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
