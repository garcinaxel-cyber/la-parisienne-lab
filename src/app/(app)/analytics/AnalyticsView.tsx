'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { Package, CheckCircle2, ClipboardList, AlertCircle, ChevronDown, ChevronUp, Clock, User, RefreshCw, Box } from 'lucide-react';

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
type StockSnapshotT = { at: string; items: { sku: string; name: string; qty: number; category: string | null }[]; error?: string };
// Doit rester aligné sur STOCK_CATEGORIES de lib/checks.ts (fichier client — pas d'import server possible)
const STOCK_CATS = ['Macaron', 'Biscuit Voyage', 'Tiramisu'];
type TraceEntry = {
  team: string | null;
  lastSend: { date: string; team: string | null; by: string | null; qty: number } | null;
  deliv7: { qty: number; count: number; lastRef: string | null; lastDate: string | null; lastBy: string | null } | null;
};

export default function AnalyticsView({
  range, days, kpis, teams, topProducts, reasons, blockedCards, blockTrend, teamDominantReason,
  daily, completionByTeamDelivery, completionGapsByTeam, discrepancyByTeam, discrepancyByProduct,
  stockRunAt, stockSnapshot, stockThresholds, stockSent, stockUpcoming, stockTrace, aggregated = false,
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
  stockRunAt: string | null;
  stockSnapshot: StockSnapshotT | null;
  stockThresholds: Record<string, number>;
  stockSent: Record<string, number>;
  stockUpcoming: Record<string, number>;
  stockTrace: Record<string, TraceEntry>;
  aggregated?: boolean;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const current = range;
  const vi = lang === 'vi';
  const [openReason, setOpenReason] = useState<string | null>(null);
  const [openGapTeams, setOpenGapTeams] = useState<Set<string>>(new Set());
  const toggleGapTeam = (team: string) => setOpenGapTeams(p => { const n = new Set(p); n.has(team) ? n.delete(team) : n.add(team); return n; });

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

      {/* ══ Vision stock (2026-09-02, chantier stock phase A) ══ — rendue depuis l'instantané
          du dernier run de Check (zéro appel Odoo à l'ouverture) ; bouton refresh = lecture live. */}
      <StockSection vi={vi} runAt={stockRunAt} snapshot={stockSnapshot}
        thresholds={stockThresholds} initialSent={stockSent} initialUpcoming={stockUpcoming} initialTrace={stockTrace} />

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
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <h3 className="font-semibold text-sm text-navy">{vi ? 'Hoàn thành theo đội (giao hàng)' : 'Completion by team (delivery)'}</h3>
            {Object.values(completionGapsByTeam).some(g => g.length > 0) && (
              <button
                onClick={() => setOpenGapTeams(p => p.size > 0 ? new Set() : new Set(completionByTeamDelivery.filter(t => (completionGapsByTeam[t.team] ?? []).length > 0).map(t => t.team)))}
                className="text-[11px] font-semibold text-ink-light hover:text-navy shrink-0">
                {openGapTeams.size > 0 ? (vi ? 'Thu gọn tất cả' : 'Collapse all') : (vi ? 'Mở tất cả' : 'Expand all')}
              </button>
            )}
          </div>
          <p className="text-[11px] text-ink-light mb-3">
            {vi ? 'SL trợ lý đã check thực tế / SL khách đặt' : 'Qty actually checked by assistants / qty client ordered'}
          </p>
          {completionByTeamDelivery.length === 0 ? <p className="text-xs text-ink-light">—</p> : (
            <div className="space-y-2.5">
              {completionByTeamDelivery.map(t => {
                const meta = TEAM_LABELS[t.team as Team];
                const gapProducts = completionGapsByTeam[t.team] ?? [];
                const isOpen = openGapTeams.has(t.team);
                return (
                  <div key={t.team}>
                    <button onClick={() => gapProducts.length > 0 && toggleGapTeam(t.team)}
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
                              <span className="font-semibold" style={{ color: p.gap > 0 ? '#DC2626' : '#16A34A' }}>
                                {p.gap > 0 ? '-' : '+'}{Math.abs(p.gap).toLocaleString()}
                              </span>
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


// ── Section Stock (2026-09-02, traçabilité + regroupement 09-03) ─────────────
// Vue 1 : les 3 catégories stockées long terme, groupées PAR CATÉGORIE, seuils des chefs.
// Vue 2 : cohérence made-to-order, groupée PAR CATÉGORIE, verdict par SKU.
// Chaque ligne se déplie (clic) en traçabilité : dernier envoi en stock (équipe + personne),
// livraisons 7 j (dernière commande cliquable + qui l'a poussée), demande à venir — et le tag
// explicite « envoi manquant — Team X » ou « NON EXPLIQUÉ » (Axel, 2026-09-02).
function StockSection({ vi, runAt, snapshot, thresholds, initialSent, initialUpcoming, initialTrace }: {
  vi: boolean; runAt: string | null; snapshot: StockSnapshotT | null;
  thresholds: Record<string, number>; initialSent: Record<string, number>; initialUpcoming: Record<string, number>;
  initialTrace: Record<string, TraceEntry>;
}) {
  const [live, setLive] = useState<{ snapshot: StockSnapshotT; sent: Record<string, number>; upcoming: Record<string, number>; trace: Record<string, TraceEntry> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openSku, setOpenSku] = useState<string | null>(null);

  const snap = live?.snapshot ?? snapshot;
  const sent = live?.sent ?? initialSent;
  const upcoming = live?.upcoming ?? initialUpcoming;
  const trace = live?.trace ?? initialTrace;

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const { refreshStockLiveAction } = await import('./actions');
      const res = await refreshStockLiveAction();
      if ('error' in res) setErr(res.error ?? 'Erreur');
      else setLive({ snapshot: res.snapshot, sent: res.sent, upcoming: res.upcoming, trace: res.trace });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
    setLoading(false);
  }

  const fmtAt = (iso: string) => new Date(iso).toLocaleString(vi ? 'vi-VN' : 'en-GB',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
  const fmtD = (iso: string) => new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).toLocaleString(vi ? 'vi-VN' : 'en-GB',
    { day: '2-digit', month: '2-digit', ...(iso.length > 10 ? { hour: '2-digit', minute: '2-digit' } : {}), timeZone: 'Asia/Ho_Chi_Minh' });
  const teamName = (t: string | null | undefined) =>
    t && TEAM_LABELS[t as Team] ? (vi ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en) : (t ?? '—');
  const teamChip = (t: string | null | undefined) => t ? (
    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
      style={{ color: TEAM_LABELS[t as Team]?.color ?? '#4B5563', backgroundColor: TEAM_LABELS[t as Team]?.bg ?? '#F3F4F6' }}>
      {teamName(t)}
    </span>
  ) : null;

  // Traçabilité dépliée sous une ligne — qui / quelle commande / non expliqué.
  const traceDetail = (sku: string, qty: number) => {
    const t = trace[sku];
    const ls = t?.lastSend ?? null;
    const d7 = t?.deliv7 ?? null;
    const up = upcoming[sku] ?? 0;
    return (
      <div className="mx-3 mb-2 rounded-xl px-3 py-2 text-[11.5px] space-y-1"
        style={{ backgroundColor: '#FFFAEE', border: '1px solid #E0D49A', color: '#1A2C24' }}>
        <div>
          📤 {vi ? 'Gửi kho gần nhất' : 'Dernier envoi en stock'}:{' '}
          {ls
            ? <>{fmtD(ls.date)} · <b>{teamName(ls.team)}</b>{ls.by ? ` · ${ls.by}` : ''} · +{ls.qty}</>
            : <b style={{ color: '#B42318' }}>{vi ? 'không có trong 14 ngày' : 'aucun depuis 14 jours'}</b>}
        </div>
        <div>
          🚚 {vi ? 'Đã giao & đẩy Odoo (7 ngày)' : 'Livré & poussé Odoo (7 jours)'}:{' '}
          {d7
            ? <>×{d7.qty} · {d7.count} {vi ? 'đơn' : 'cmd'}
                {d7.lastRef && <> · {vi ? 'gần nhất' : 'dernière'}{' '}
                  <a className="underline font-semibold" style={{ color: '#1D4ED8' }}
                    href={`/delivery-check/${d7.lastDate}/${d7.lastRef}`}>{d7.lastRef}</a>
                  {d7.lastBy ? ` (${vi ? 'bởi' : 'par'} ${d7.lastBy})` : ''}</>}
              </>
            : (vi ? 'không có' : 'aucune')}
        </div>
        {up > 0 && <div>📅 {vi ? 'Sắp giao (hôm nay/mai)' : 'À livrer (auj./demain)'}: ×{up}</div>}
        {qty < 0 && !ls && (
          <div className="font-bold" style={{ color: '#B42318' }}>
            👤 {vi ? 'Thiếu GỬI KHO' : 'ENVOI EN STOCK manquant'} — {teamName(t?.team)}
          </div>
        )}
        {qty > 0 && !ls && !d7 && up === 0 && (
          <div className="font-bold" style={{ color: '#B42318' }}>
            ❓ {vi ? 'KHÔNG GIẢI THÍCH ĐƯỢC — kiểm tra thực tế' : 'NON EXPLIQUÉ — à vérifier physiquement'}
          </div>
        )}
      </div>
    );
  };

  const header = (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h3 className="font-semibold text-sm text-navy flex items-center gap-1.5">
          <Box size={15} className="text-navy" /> {vi ? 'Kho (Odoo)' : 'Stock (Odoo)'}
        </h3>
        <p className="text-[11px] text-ink-light">
          {live
            ? `${vi ? 'Đọc trực tiếp lúc' : 'Lecture live à'} ${fmtAt(live.snapshot.at)}`
            : snap
              ? `📸 ${vi ? 'Ảnh chụp từ lần Check' : 'Instantané du dernier Check'}: ${fmtAt(runAt ?? snap.at)} · ${vi ? 'bấm 1 dòng để xem truy vết' : 'clique une ligne pour la traçabilité'}`
              : (vi ? 'Chưa có ảnh chụp kho — chạy Check hoặc bấm nút bên phải' : "Aucun instantané — lance un Check ou clique Actualiser")}
        </p>
      </div>
      <button onClick={refresh} disabled={loading}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-navy hover:bg-navy/90 disabled:opacity-60 transition-colors">
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        {loading ? (vi ? 'Đang đọc…' : 'Lecture…') : (vi ? 'Đọc trực tiếp Odoo' : 'Actualiser en direct')}
      </button>
    </div>
  );

  if (!snap) {
    return (
      <div className="card p-4 space-y-2">
        {header}
        {err && <p className="text-xs" style={{ color: '#B42318' }}>{err}</p>}
      </div>
    );
  }

  const stockItems = snap.items
    .filter(i => i.category && STOCK_CATS.includes(i.category))
    .map(i => ({ ...i, threshold: thresholds[i.sku] ?? null, below: thresholds[i.sku] != null && i.qty < thresholds[i.sku] }));
  const belowCount = stockItems.filter(i => i.below).length;
  const stockByCat = new Map<string, typeof stockItems>();
  for (const cat of STOCK_CATS) {
    const items = stockItems.filter(i => i.category === cat)
      .sort((a, b) => Number(b.below) - Number(a.below) || a.qty - b.qty || a.name.localeCompare(b.name));
    if (items.length) stockByCat.set(cat, items);
  }

  type Verdict = 'negative_stuck' | 'orphan' | 'transit' | 'covered';
  const mtoItems = snap.items
    .filter(i => i.qty !== 0 && !(i.category && STOCK_CATS.includes(i.category)))
    .map(i => {
      const s = sent[i.sku] ?? 0, u = upcoming[i.sku] ?? 0;
      const verdict: Verdict = i.qty < 0 ? (s > 0 ? 'transit' : 'negative_stuck') : (s === 0 && u === 0 ? 'orphan' : 'covered');
      return { ...i, s, u, verdict };
    });
  const mtoBad = mtoItems.filter(i => i.verdict === 'negative_stuck' || i.verdict === 'orphan').length;
  const vRank = (v: Verdict) => v === 'negative_stuck' ? 0 : v === 'orphan' ? 1 : v === 'covered' ? 2 : 3;
  const mtoByCat = new Map<string, typeof mtoItems>();
  for (const i of mtoItems) {
    const cat = i.category ?? (vi ? 'Khác' : 'Autre');
    if (!mtoByCat.has(cat)) mtoByCat.set(cat, []);
    mtoByCat.get(cat)!.push(i);
  }
  const mtoCats = Array.from(mtoByCat.entries()).map(([cat, items]) => ({
    cat,
    items: items.sort((a, b) => vRank(a.verdict) - vRank(b.verdict) || Math.abs(b.qty) - Math.abs(a.qty)),
    bad: items.filter(i => i.verdict === 'negative_stuck' || i.verdict === 'orphan').length,
  })).sort((a, b) => b.bad - a.bad || a.cat.localeCompare(b.cat));

  const verdictBadge = (v: Verdict) => {
    if (v === 'negative_stuck') return { label: vi ? 'Âm — thiếu gửi kho' : 'Négatif — envoi manquant', style: { color: '#B42318', backgroundColor: '#FDF2F2' } };
    if (v === 'orphan') return { label: vi ? 'Không rõ lý do' : 'Inexpliqué', style: { color: '#B42318', backgroundColor: '#FDF2F2' } };
    if (v === 'transit') return { label: vi ? 'Đang trung chuyển' : 'En transit (normal)', style: { color: '#4B5563', backgroundColor: '#F3F4F6' } };
    return { label: vi ? 'Có lý do' : 'Expliqué', style: { color: '#047857', backgroundColor: '#ECFDF5' } };
  };

  return (
    <div className="card p-4 space-y-4">
      {header}
      {err && <p className="text-xs" style={{ color: '#B42318' }}>{err}</p>}
      {snap.error && <p className="text-xs" style={{ color: '#B42318' }}>{vi ? 'Lỗi đọc kho' : 'Erreur lecture stock'}: {snap.error}</p>}

      {/* Vue 1 — stock long terme, groupé par catégorie */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-xs font-bold text-navy uppercase tracking-wider">
            {vi ? 'Kho dài hạn' : 'Stock long terme'}
          </h4>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={belowCount ? { color: '#B42318', backgroundColor: '#FDF2F2' } : { color: '#047857', backgroundColor: '#ECFDF5' }}>
            {belowCount ? `${belowCount} ${vi ? 'dưới ngưỡng' : 'sous seuil'}` : 'OK ✓'}
          </span>
        </div>
        <div className="rounded-xl overflow-hidden max-h-96 overflow-y-auto" style={{ border: '1px solid #E5E7EB' }}>
          {Array.from(stockByCat.entries()).map(([cat, items]) => (
            <div key={cat}>
              <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderTop: '1px solid #E5E7EB' }}>
                <span>{cat} · {items.length} SKU · {items.reduce((s, i) => s + i.qty, 0)} {vi ? 'cái' : 'u.'}</span>
                {items.some(i => i.below) && (
                  <span style={{ color: '#B42318' }}>{items.filter(i => i.below).length} {vi ? 'dưới ngưỡng' : 'sous seuil'}</span>
                )}
              </div>
              {items.map(i => (
                <div key={i.sku}>
                  <div onClick={() => setOpenSku(openSku === i.sku ? null : i.sku)}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px] bg-white cursor-pointer hover:bg-gold-pale"
                    style={{ borderTop: '1px solid #F3F4F6' }}>
                    <div className="min-w-0 truncate text-navy flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-ink-light">{i.sku}</span>
                      <span className="truncate">{i.name}</span>
                      {teamChip(trace[i.sku]?.team)}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-bold" style={{ color: i.qty < 0 || i.below ? '#B42318' : '#1A4731' }}>{i.qty}</span>
                      <span className="text-[11px] text-ink-light w-16 text-right">
                        {i.threshold != null ? `${vi ? 'ngưỡng' : 'seuil'} ${i.threshold}` : '—'}
                      </span>
                      <ChevronDown size={12} className={`text-ink-light transition-transform ${openSku === i.sku ? 'rotate-180' : ''}`} />
                    </div>
                  </div>
                  {openSku === i.sku && traceDetail(i.sku, i.qty)}
                </div>
              ))}
            </div>
          ))}
          {!stockItems.length && (
            <div className="px-3 py-4 text-xs text-ink-light bg-white">{vi ? 'Không có dữ liệu' : 'Aucune donnée'}</div>
          )}
        </div>
      </div>

      {/* Vue 2 — made-to-order, groupé par catégorie */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-xs font-bold text-navy uppercase tracking-wider">
            {vi ? 'Hàng làm theo đơn — tồn phải = 0 hoặc có lý do' : 'Made-to-order — stock = 0 ou expliqué'}
          </h4>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
            style={mtoBad ? { color: '#B42318', backgroundColor: '#FDF2F2' } : { color: '#047857', backgroundColor: '#ECFDF5' }}>
            {mtoBad ? `${mtoBad} ${vi ? 'bất thường' : 'anomalies'}` : 'OK ✓'}
          </span>
        </div>
        <div className="rounded-xl overflow-hidden max-h-96 overflow-y-auto" style={{ border: '1px solid #E5E7EB' }}>
          {mtoCats.map(({ cat, items, bad }) => (
            <div key={cat}>
              <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ backgroundColor: '#FBF6E3', color: '#92600A', borderTop: '1px solid #E5E7EB' }}>
                <span>{cat} · {items.length} SKU</span>
                {bad > 0 && <span style={{ color: '#B42318' }}>{bad} {vi ? 'bất thường' : 'anomalies'}</span>}
              </div>
              {items.map(i => {
                const b = verdictBadge(i.verdict);
                return (
                  <div key={i.sku}>
                    <div onClick={() => setOpenSku(openSku === i.sku ? null : i.sku)}
                      className="flex items-center justify-between gap-3 px-3 py-1.5 text-[13px] bg-white cursor-pointer hover:bg-gold-pale"
                      style={{ borderTop: '1px solid #F3F4F6' }}>
                      <div className="min-w-0 truncate text-navy flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-ink-light">{i.sku}</span>
                        <span className="truncate">{i.name}</span>
                        {teamChip(trace[i.sku]?.team)}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-bold" style={{ color: i.qty < 0 ? '#B42318' : '#1A4731' }}>{i.qty}</span>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={b.style}>{b.label}</span>
                        <ChevronDown size={12} className={`text-ink-light transition-transform ${openSku === i.sku ? 'rotate-180' : ''}`} />
                      </div>
                    </div>
                    {openSku === i.sku && traceDetail(i.sku, i.qty)}
                  </div>
                );
              })}
            </div>
          ))}
          {!mtoItems.length && (
            <div className="px-3 py-4 text-xs text-ink-light bg-white">
              {vi ? 'Không có SKU làm theo đơn nào còn tồn ≠ 0 🎉' : 'Aucun SKU made-to-order avec du stock ≠ 0 🎉'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
