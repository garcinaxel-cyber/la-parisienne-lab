'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { Package, CheckCircle2, ClipboardList, AlertCircle, ChevronDown, ChevronUp, Clock, User } from 'lucide-react';

type Kpis = { unitsProduced: number; unitsPlanned: number; completion: number; orders: number; blocked: number };
type TeamStat = { team: string; completion: number; units: number };
type Daily = { date: string; units: number; total: number; done: number; completion: number };
type BlockedCard = { date: string; team: string; product: string; reason: string; blockedAt: string | null; blockedBy: string | null };
type BlockTrendDay = { date: string; count: number };
type TeamDominantReason = { team: string; total: number; topReason: string; topCount: number };
type DeliveryTeamStat = { team: string; expected: number; checked: number; rate: number };
type DiscrepancyTeamStat = { team: string; total: number; adjusted: number; rate: number };
type DiscrepancyProductStat = { name: string; total: number; adjusted: number; rate: number };
type CompletionGapProduct = { name: string; expected: number; checked: number; gap: number };

export default function AnalyticsView({
  range, days, kpis, teams, topProducts, reasons, blockedCards, blockTrend, teamDominantReason,
  daily, completionByTeamDelivery, completionGapsByTeam, discrepancyByTeam, discrepancyByProduct, aggregated = false,
}: {
  range: string; days: number; kpis: Kpis; teams: TeamStat[];
  topProducts: { name: string; qty: number }[];
  reasons: { reason: string; count: number }[];
  blockedCards: BlockedCard[];
  blockTrend: BlockTrendDay[];
  teamDominantReason: TeamDominantReason[];
  daily: Daily[];
  completionByTeamDelivery: DeliveryTeamStat[];
  completionGapsByTeam: Record<string, CompletionGapProduct[]>;
  discrepancyByTeam: DiscrepancyTeamStat[];
  discrepancyByProduct: DiscrepancyProductStat[];
  aggregated?: boolean;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const current = range;
  const vi = lang === 'vi';
  const [openReason, setOpenReason] = useState<string | null>(null);
  const [openGapTeam, setOpenGapTeam] = useState<string | null>(null);

  const setRange = (r: string) => router.push(`/analytics?range=${r}`);
  const maxUnits = Math.max(1, ...daily.map(d => d.units));
  const maxBlocks = Math.max(1, ...blockTrend.map(d => d.count));
  const dateLabel = (d: string, opts: Intl.DateTimeFormatOptions) =>
    new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', opts);
  const teamLabel = (t: string) => TEAM_LABELS[t as Team] ? (vi ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en) : t;
  const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(vi ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const prodCards = [
    { label: vi ? 'Đã sản xuất' : 'Units produced', value: kpis.unitsProduced.toLocaleString(), icon: Package, color: 'text-navy' },
    { label: vi ? 'Tỷ lệ hoàn thành' : 'Completion rate', value: `${kpis.completion}%`, icon: CheckCircle2, color: 'text-green-600' },
    aggregated
      ? { label: vi ? 'Ngày sản xuất' : 'Production days', value: kpis.orders, icon: ClipboardList, color: 'text-navy' }
      : { label: vi ? 'Đơn đã phát hành' : 'Published imports', value: kpis.orders, icon: ClipboardList, color: 'text-navy' },
    { label: vi ? 'Sản phẩm bị chặn' : 'Blocked products', value: kpis.blocked, icon: AlertCircle, color: kpis.blocked > 0 ? 'text-amber-600' : 'text-ink-light' },
  ];

  const blockedByReason = new Map<string, BlockedCard[]>();
  for (const c of blockedCards) (blockedByReason.get(c.reason) ?? blockedByReason.set(c.reason, []).get(c.reason)!).push(c);

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
            ? 'Khoảng dài: số liệu sản xuất từ bảng tổng hợp hằng ngày. Lý do bị chặn, hoàn thành giao hàng và chênh lệch delivery-check chỉ có chi tiết 60 ngày gần nhất.'
            : 'Long range: production figures come from the daily aggregates. Blocked reasons, delivery completion and discrepancy rate only have detail for the last 60 days.'}
        </p>
      )}

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
        {/* Completion by team — cards done/total */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-0.5">{vi ? 'Hoàn thành theo đội (thẻ)' : 'Completion by team (cards)'}</h3>
          <p className="text-[11px] text-ink-light mb-3">{vi ? '% thẻ sản xuất đã đánh dấu xong' : '% of production cards marked done'}</p>
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

        {/* Completion by team — delivery-check: demanded vs actually delivered */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-0.5">{vi ? 'Hoàn thành theo đội (giao hàng)' : 'Completion by team (delivery)'}</h3>
          <p className="text-[11px] text-ink-light mb-3">
            {vi ? 'SL trợ lý đã check thực tế / SL khách đặt' : 'Qty actually checked by assistants / qty client ordered'}
          </p>
          {completionByTeamDelivery.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-2.5">
              {completionByTeamDelivery.map(t => {
                const meta = TEAM_LABELS[t.team as Team];
                const gapProducts = completionGapsByTeam[t.team] ?? [];
                const isOpen = openGapTeam === t.team;
                return (
                  <div key={t.team}>
                    <button onClick={() => gapProducts.length > 0 && setOpenGapTeam(isOpen ? null : t.team)}
                      className="w-full text-left" disabled={gapProducts.length === 0}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-navy flex items-center gap-1">
                          {gapProducts.length > 0 && (isOpen ? <ChevronUp size={11} className="text-ink-light shrink-0" /> : <ChevronDown size={11} className="text-ink-light shrink-0" />)}
                          {teamLabel(t.team)}
                        </span>
                        <span className="text-ink-light">{t.rate}% · {t.checked.toLocaleString()}/{t.expected.toLocaleString()}</span>
                      </div>
                      <div className="h-2 rounded-full bg-border-soft overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, t.rate)}%`, backgroundColor: meta?.color ?? '#1A4731' }} />
                      </div>
                    </button>
                    {isOpen && gapProducts.length > 0 && (
                      <div className="mt-2 mb-1 space-y-1 border-l-2 pl-3" style={{ borderColor: '#F3F4F6' }}>
                        {gapProducts.map(p => (
                          <div key={p.name} className="flex justify-between items-center text-[12px]">
                            <span className="text-navy truncate pr-3">{p.name}</span>
                            <span className="text-ink-light shrink-0">
                              {p.checked.toLocaleString()}/{p.expected.toLocaleString()} ·{' '}
                              <span className="font-semibold" style={{ color: '#DC2626' }}>-{p.gap.toLocaleString()}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
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

        {/* Blocked reasons — traceable: click a reason to see the actual cards */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Lý do bị chặn' : 'Blocked reasons'}</h3>
          {reasons.length === 0 ? (
            <p className="text-xs text-ink-light">{vi ? 'Không có sản phẩm bị chặn 🎉' : 'No blocked products 🎉'}</p>
          ) : (
            <div className="space-y-1">
              {reasons.map(r => {
                const cards = blockedByReason.get(r.reason) ?? [];
                const isOpen = openReason === r.reason;
                return (
                  <div key={r.reason}>
                    <button onClick={() => setOpenReason(isOpen ? null : r.reason)}
                      className="w-full flex justify-between items-center text-[13px] py-1">
                      <span className="text-navy truncate pr-3 flex items-center gap-1">
                        {cards.length > 0 && (isOpen ? <ChevronUp size={12} className="text-ink-light shrink-0" /> : <ChevronDown size={12} className="text-ink-light shrink-0" />)}
                        {r.reason}
                      </span>
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{r.count}</span>
                    </button>
                    {isOpen && cards.length > 0 && (
                      <div className="ml-4 mb-2 space-y-1.5 border-l-2 pl-3" style={{ borderColor: '#F3F4F6' }}>
                        {cards.map((c, i) => (
                          <div key={i} className="text-[12px]">
                            <div className="text-navy truncate">{c.product}</div>
                            <div className="text-[11px] text-ink-light flex items-center gap-2 flex-wrap">
                              <span className="font-semibold px-1.5 py-0.5 rounded-full" style={{ color: TEAM_LABELS[c.team as Team]?.color, backgroundColor: TEAM_LABELS[c.team as Team]?.bg }}>{teamLabel(c.team)}</span>
                              <span>{c.date}</span>
                              {c.blockedAt && <span className="flex items-center gap-0.5"><Clock size={10} /> {fmtTime(c.blockedAt)}</span>}
                              {c.blockedBy && <span className="flex items-center gap-0.5"><User size={10} /> {c.blockedBy}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Blocking frequency over time */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Tần suất chặn theo ngày' : 'Blocking frequency over time'}</h3>
          {blockTrend.length === 0 ? (
            <p className="text-xs text-ink-light">{vi ? 'Không có dữ liệu' : 'No data'}</p>
          ) : (
            <div className="flex items-end gap-1 h-28">
              {blockTrend.slice(-14).map(d => (
                <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                  <span className="text-[10px] font-bold text-navy mb-0.5">{d.count}</span>
                  <div className="w-full rounded-t transition-all" style={{ height: `${Math.max(6, d.count / maxBlocks * 100)}%`, backgroundColor: '#DC2626' }} />
                  <span className="text-[9px] text-ink-light mt-1 truncate w-full text-center">{dateLabel(d.date, { day: 'numeric', month: 'numeric' })}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dominant blocking reason per team */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-3">{vi ? 'Lý do chặn chủ yếu theo đội' : 'Dominant blocking reason by team'}</h3>
          {teamDominantReason.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-2">
              {teamDominantReason.map(t => (
                <div key={t.team} className="flex items-center justify-between text-[13px] gap-2">
                  <span className="font-semibold px-1.5 py-0.5 rounded-full shrink-0" style={{ color: TEAM_LABELS[t.team as Team]?.color, backgroundColor: TEAM_LABELS[t.team as Team]?.bg }}>{teamLabel(t.team)}</span>
                  <span className="text-navy truncate flex-1 text-right">{t.topReason} <span className="text-ink-light">×{t.topCount}</span></span>
                  <span className="text-ink-light text-[11px] shrink-0">{vi ? `tổng ${t.total}` : `total ${t.total}`}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Discrepancy rate by team */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-0.5">{vi ? 'Tỷ lệ lệch delivery-check theo đội' : 'Delivery-check discrepancy by team'}</h3>
          <p className="text-[11px] text-ink-light mb-3">{vi ? '% dòng có SL check khác SL đặt' : '% of lines whose checked qty differed from expected'}</p>
          {discrepancyByTeam.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-2.5">
              {discrepancyByTeam.map(t => (
                <div key={t.team}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-navy">{teamLabel(t.team)}</span>
                    <span className="text-ink-light">{t.rate}% · {t.adjusted}/{t.total}</span>
                  </div>
                  <div className="h-2 rounded-full bg-border-soft overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${t.rate}%`, backgroundColor: t.rate > 20 ? '#DC2626' : '#D97706' }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Discrepancy — worst products */}
        <div className="card p-4">
          <h3 className="font-semibold text-sm text-navy mb-0.5">{vi ? 'Sản phẩm lệch nhiều nhất' : 'Most-discrepant products'}</h3>
          <p className="text-[11px] text-ink-light mb-3">{vi ? 'Sản phẩm hay có vấn đề định kỳ' : 'Products with a recurring problem'}</p>
          {discrepancyByProduct.length === 0 ? (
            <p className="text-xs text-ink-light">{vi ? 'Không có lệch nào 🎉' : 'No discrepancies 🎉'}</p>
          ) : (
            <div className="space-y-1.5">
              {discrepancyByProduct.map(p => (
                <div key={p.name} className="flex justify-between items-center text-[13px]">
                  <span className="text-navy truncate pr-3">{p.name}</span>
                  <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                    {p.adjusted}/{p.total} ({p.rate}%)
                  </span>
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
    </div>
  );
}
