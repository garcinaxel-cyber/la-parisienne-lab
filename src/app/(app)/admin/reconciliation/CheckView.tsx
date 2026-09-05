'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ShieldCheck, AlertTriangle, RefreshCw, TrendingUp, TrendingDown, Truck, Package, Box, ChevronRight, ArrowLeftRight } from 'lucide-react';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { runCheckNowAction, fixStockOdooIssueAction } from './actions';

type ReconciliationIssue = { date: string; team: string; variantLabel: string; name: string; needed: number; tracked: number; gap: number };
type DeliveryCoverageIssue = { kind: 'not_materialized' | 'qty_drift'; date: string; order_ref: string; sku?: string; expected_odoo?: number; expected_app?: number };
type ProductionStockIssue = { date: string; team: string; product: string; produced: number; sent: number; gap: number; is_extra: boolean; card_id: string };
type StockOdooIssue = { date: string; kind: 'not_synced' | 'drifted' | 'no_odoo_product' | 'missing_sku' | 'error'; sku?: string; product?: string; qty?: number; mo?: string; from?: number; to?: number; detail?: string };
type LateDeliveryIssue = { date: string; order_ref: string; shop: string | null; kind: 'never_opened' | 'not_validated' | 'not_pushed'; push_error?: string | null; doneOnOdoo?: boolean };
type SafetyStockIssue = { sku: string; name: string; category: string; qty: number; threshold: number };
type OrphanStockIssue = { sku: string; name: string; category: string | null; qty: number; sent48h: number; upcoming: number; kind: 'orphan_positive' | 'negative_stuck' };
type ScrapSyncIssue = {
  source: 'shop' | 'internal'; id: string; sku: string | null; product_name: string | null; qty: number;
  reported_at: string; shop_name?: string | null;
  kind: 'not_synced' | 'missing_in_odoo' | 'not_done' | 'duplicate_odoo_id';
  odoo_scrap_id?: number | null; odoo_state?: string | null; sync_error?: string | null; duplicate_with?: string[];
};
type StockSnapshot = { at: string; items: { sku: string; name: string; qty: number; category: string | null }[]; error?: string };

type Run = {
  id: string; run_at: string; triggered_by: string;
  range_from: string; range_to: string; dates_checked: number; issue_count: number;
  issues: ReconciliationIssue[]; error: string | null;
  check_range_from: string | null; check_range_to: string | null;
  delivery_coverage_issues: DeliveryCoverageIssue[]; delivery_coverage_count: number;
  production_stock_issues: ProductionStockIssue[]; production_stock_count: number;
  stock_odoo_issues: StockOdooIssue[]; stock_odoo_count: number;
  odoo_volume?: OdooVolume | null;
  late_delivery_issues?: LateDeliveryIssue[] | null; late_delivery_count?: number | null;
  safety_stock_issues?: SafetyStockIssue[] | null; safety_stock_count?: number | null;
  orphan_stock_issues?: OrphanStockIssue[] | null; orphan_stock_count?: number | null;
  scrap_sync_issues?: ScrapSyncIssue[] | null; scrap_sync_count?: number | null;
  stock_snapshot?: StockSnapshot | null;
};
type OdooVolumeGauge = { count: number; cap: number };
type OdooVolume =
  | { sales: OdooVolumeGauge; sales_lines: OdooVolumeGauge; repl: OdooVolumeGauge; repl_lines: OdooVolumeGauge; measured_at: string }
  | { error: string; measured_at: string };

function totalOf(r: Run): number {
  return r.issue_count + (r.delivery_coverage_count ?? 0) + (r.production_stock_count ?? 0) + (r.stock_odoo_count ?? 0)
    + (r.late_delivery_count ?? 0) + (r.safety_stock_count ?? 0) + (r.orphan_stock_count ?? 0) + (r.scrap_sync_count ?? 0);
}

type Heartbeat = { last_success_at: string | null; last_error_at: string | null; last_error: string | null };

// pg_cron schedule for /api/odoo/cron (cron.job, 2026-09-01): every 15 min 00-09 UTC (peak),
// every 30 min 22-23 + 10-14 UTC (off-peak), nothing 15-21 UTC (22:00-04:59 Vietnam). So a
// success older than 45 min is only a problem INSIDE that window, and only once the window has
// been open for 45 min (the first tick after the night gap is still pending until then).
const CRON_ACTIVE_UTC_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const STALE_AFTER_MS = 45 * 60 * 1000;
function heartbeatStatus(hb: Heartbeat | null, now = new Date()): { kind: 'ok' | 'stale' | 'night' | 'unknown'; ageMin: number | null } {
  const last = hb?.last_success_at ? new Date(hb.last_success_at) : null;
  const ageMin = last ? Math.round((now.getTime() - last.getTime()) / 60000) : null;
  if (!CRON_ACTIVE_UTC_HOURS.has(now.getUTCHours())) return { kind: 'night', ageMin };
  if (!last) return { kind: 'unknown', ageMin };
  // Window (re)opens at 22:00 UTC; measure staleness from whichever is later: last success or
  // that reopening -- otherwise 22:00-22:45 UTC would always alarm on the ~7h night gap.
  const windowStart = new Date(now); windowStart.setUTCHours(22, 0, 0, 0);
  if (windowStart > now) windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const ref = Math.max(last.getTime(), windowStart.getTime());
  return { kind: now.getTime() - ref > STALE_AFTER_MS ? 'stale' : 'ok', ageMin };
}

export default function CheckView({ runs, heartbeat }: { runs: Run[]; heartbeat: Heartbeat | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixErr, setFixErr] = useState<Record<string, string>>({});
  // Onglets (Axel, 2026-09-03 : "plusieurs onglets cliquables pour pas surcharger une seule
  // page") — principal = sync Odoo + réconciliation + coverage + production→stock ;
  // les nouveaux checks vivent dans leurs propres onglets.
  const [tab, setTab] = useState<'main' | 'deliveries' | 'stock'>('main');

  const latest = runs[0] ?? null;
  const history = runs.slice(1);

  async function runNow() {
    setRunning(true);
    setErr(null);
    const res = await runCheckNowAction();
    if (res?.error) setErr(res.error);
    setRunning(false);
    router.refresh();
  }

  async function fixIssue(date: string, sku?: string) {
    if (!sku) return;
    const key = `${date}:${sku}`;
    setFixing(key);
    setFixErr(prev => { const { [key]: _drop, ...rest } = prev; return rest; });
    const res = await fixStockOdooIssueAction(date, sku);
    if (res?.error) {
      setFixErr(prev => ({ ...prev, [key]: res.error! }));
      setFixing(null);
      return;
    }
    await runCheckNowAction();
    setFixing(null);
    router.refresh();
  }

  const teamLabel = (t: string) => TEAM_LABELS[t as Team] ? (vi ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en) : t;
  // Explicit lab timezone: without it the server render (UTC) and the browser (UTC+7) disagree,
  // so the page shows UTC times until a client re-render -- "17:16" for a 00:16 sync.
  const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(vi ? 'vi-VN' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
  });

  const total = latest ? totalOf(latest) : 0;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <ShieldCheck size={26} className="text-navy" /> Check
          </h1>
          <p className="text-ink-light text-sm mt-1 max-w-xl">
            {vi
              ? 'Tất cả kiểm tra chạy trong 1 lần bấm, xếp theo 3 nhóm: Đồng bộ Odoo · Đơn hàng & giao hàng · Sản xuất & kho. Tự động mỗi sáng, lưu 7 ngày.'
              : 'Tous les checks en un clic, groupés en 3 domaines : Sync Odoo · Commandes & livraisons · Production & stock. Automatique chaque matin, historique 7 jours.'}
          </p>
        </div>
        <button onClick={runNow} disabled={running}
          className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-navy hover:bg-navy/90 disabled:opacity-60 transition-colors">
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} />
          {running ? (vi ? 'Đang kiểm tra…' : 'Running…') : (vi ? 'Kiểm tra ngay' : 'Check now')}
        </button>
      </div>

      {err && (
        <div className="card p-3 text-sm border" style={{ borderColor: '#F0B4B4', backgroundColor: '#FDF2F2', color: '#B42318' }}>{err}</div>
      )}

      {!latest ? (
        <>
      {/* Odoo sync heartbeat (lab_v52) -- live, independent of the stored runs below */}
      {(() => {
        const st = heartbeatStatus(heartbeat);
        const errIsRecent = !!heartbeat?.last_error_at && (!heartbeat?.last_success_at || heartbeat.last_error_at > heartbeat.last_success_at);
        const style = st.kind === 'stale' ? { backgroundColor: '#FDF2F2', color: '#B42318' }
          : st.kind === 'ok' ? { backgroundColor: '#ECFDF5', color: '#047857' }
          : { backgroundColor: '#F3F4F6', color: '#4B5563' };
        const label = st.kind === 'stale' ? (vi ? 'Không đồng bộ' : 'Sync late')
          : st.kind === 'ok' ? 'OK'
          : st.kind === 'night' ? (vi ? 'Ngoài giờ cron' : 'Outside cron hours')
          : (vi ? 'Chưa có dữ liệu' : 'No data yet');
        return (
          <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-1">
                {vi ? 'Đồng bộ Odoo (cron 15 phút)' : 'Odoo sync (15-min cron)'}
              </div>
              <div className="text-sm text-navy font-medium">
                {heartbeat?.last_success_at
                  ? `${vi ? 'Lần thành công gần nhất' : 'Last success'}: ${fmtDateTime(heartbeat.last_success_at)}${st.ageMin != null ? ` · ${st.ageMin} min` : ''}`
                  : (vi ? 'Chưa ghi nhận lần đồng bộ nào' : 'No sync recorded yet')}
              </div>
              {errIsRecent && (
                <div className="text-xs mt-0.5 truncate" style={{ color: '#B42318' }}>
                  {vi ? 'Lỗi gần nhất' : 'Last error'}: {fmtDateTime(heartbeat!.last_error_at!)} — {heartbeat!.last_error}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold shrink-0" style={style}>
              {st.kind === 'stale' ? <AlertTriangle size={16} /> : st.kind === 'ok' ? <ShieldCheck size={16} /> : <RefreshCw size={16} />}
              {label}
            </div>
          </div>
        );
      })()}
        <div className="card px-4 py-10 text-center text-sm text-ink-light">
          {vi ? 'Chưa có lần kiểm tra nào.' : 'No check has run yet.'}
        </div>
        </>
      ) : (
        <>
          <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-1">
                {vi ? 'Lần kiểm tra gần nhất' : 'Last check'}
              </div>
              <div className="text-sm text-navy font-medium">{fmtDateTime(latest.run_at)}</div>
              <div className="text-xs text-ink-light mt-0.5">
                {latest.triggered_by === 'cron' ? (vi ? 'Tự động' : 'Automatic') : latest.triggered_by}
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold" style={
              latest.error ? { backgroundColor: '#FDF2F2', color: '#B42318' }
              : total === 0 ? { backgroundColor: '#ECFDF5', color: '#047857' }
              : { backgroundColor: '#FFFBEB', color: '#B45309' }
            }>
              {latest.error ? <AlertTriangle size={16} /> : total === 0 ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
              {latest.error
                ? (vi ? 'Lỗi khi kiểm tra' : 'Check failed')
                : total === 0
                  ? (vi ? 'Không có bất thường' : 'No anomalies')
                  : `${total} ${vi ? 'bất thường' : 'anomalies'}`}
            </div>
          </div>

          {latest.error && (
            <div className="card p-3 text-sm border" style={{ borderColor: '#F0B4B4', backgroundColor: '#FDF2F2', color: '#B42318' }}>{latest.error}</div>
          )}

          {/* Onglets */}
          {(() => {
            const mainCount = (latest.issue_count ?? 0) + (latest.delivery_coverage_count ?? 0) + (latest.production_stock_count ?? 0) + (latest.stock_odoo_count ?? 0);
            const tabs: { id: 'main' | 'deliveries' | 'stock'; label: string; n: number }[] = [
              { id: 'main', label: vi ? '🏠 Chính' : '🏠 Principal', n: mainCount },
              { id: 'deliveries', label: vi ? '🚚 Giao hàng' : '🚚 Livraisons', n: latest.late_delivery_count ?? 0 },
              { id: 'stock', label: vi ? '📦 Kho' : '📦 Stock', n: (latest.orphan_stock_count ?? 0) + (latest.safety_stock_count ?? 0) + (latest.scrap_sync_count ?? 0) },
            ];
            return (
              <div className="flex gap-2 flex-wrap">
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      tab === t.id ? 'bg-navy text-white' : 'bg-white border border-border-soft text-ink-light hover:text-navy'}`}>
                    {t.label}
                    <span className="text-[11px] font-black rounded-full px-1.5 py-0.5"
                      style={t.n === 0 ? { backgroundColor: '#ECFDF5', color: '#047857' }
                        : tab === t.id ? { backgroundColor: '#C9A84C', color: '#1A4731' }
                        : { backgroundColor: '#FDF2F2', color: '#B42318' }}>
                      {t.n === 0 ? '✓' : t.n}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}

          {/* ══ Onglet principal : Sync Odoo ══ */}
          {tab === 'main' && (<>
      {/* Odoo sync heartbeat (lab_v52) -- live, independent of the stored runs below */}
      {(() => {
        const st = heartbeatStatus(heartbeat);
        const errIsRecent = !!heartbeat?.last_error_at && (!heartbeat?.last_success_at || heartbeat.last_error_at > heartbeat.last_success_at);
        const style = st.kind === 'stale' ? { backgroundColor: '#FDF2F2', color: '#B42318' }
          : st.kind === 'ok' ? { backgroundColor: '#ECFDF5', color: '#047857' }
          : { backgroundColor: '#F3F4F6', color: '#4B5563' };
        const label = st.kind === 'stale' ? (vi ? 'Không đồng bộ' : 'Sync late')
          : st.kind === 'ok' ? 'OK'
          : st.kind === 'night' ? (vi ? 'Ngoài giờ cron' : 'Outside cron hours')
          : (vi ? 'Chưa có dữ liệu' : 'No data yet');
        return (
          <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-1">
                {vi ? 'Đồng bộ Odoo (cron 15 phút)' : 'Odoo sync (15-min cron)'}
              </div>
              <div className="text-sm text-navy font-medium">
                {heartbeat?.last_success_at
                  ? `${vi ? 'Lần thành công gần nhất' : 'Last success'}: ${fmtDateTime(heartbeat.last_success_at)}${st.ageMin != null ? ` · ${st.ageMin} min` : ''}`
                  : (vi ? 'Chưa ghi nhận lần đồng bộ nào' : 'No sync recorded yet')}
              </div>
              {errIsRecent && (
                <div className="text-xs mt-0.5 truncate" style={{ color: '#B42318' }}>
                  {vi ? 'Lỗi gần nhất' : 'Last error'}: {fmtDateTime(heartbeat!.last_error_at!)} — {heartbeat!.last_error}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold shrink-0" style={style}>
              {st.kind === 'stale' ? <AlertTriangle size={16} /> : st.kind === 'ok' ? <ShieldCheck size={16} /> : <RefreshCw size={16} />}
              {label}
            </div>
          </div>
        );
      })()}
          {/* 0. Odoo fetch volume vs sync caps (lab_v53) -- warn before a cap silently truncates */}
          {latest.odoo_volume && (() => {
            const v = latest.odoo_volume;
            if ('error' in v) {
              return (
                <div className="card px-4 py-3 text-sm flex items-center justify-between gap-3">
                  <span className="text-navy font-medium">{vi ? 'Khối lượng Odoo / giới hạn sync' : 'Odoo volume vs sync caps'}</span>
                  <span className="text-xs" style={{ color: '#B42318' }}>{v.error}</span>
                </div>
              );
            }
            const gauges: { key: string; label: string; g: OdooVolumeGauge }[] = [
              { key: 'sales', label: vi ? 'Đơn bán' : 'Sales orders', g: v.sales },
              { key: 'sales_lines', label: vi ? 'Dòng đơn bán' : 'Sales lines', g: v.sales_lines },
              { key: 'repl', label: vi ? 'Yêu cầu bổ sung' : 'Replenishments', g: v.repl },
              { key: 'repl_lines', label: vi ? 'Dòng bổ sung' : 'Replenishment lines', g: v.repl_lines },
            ];
            const worst = Math.max(...gauges.map(x => x.g.count / x.g.cap));
            const tone = (r: number) => r >= 0.8 ? { color: '#B42318', backgroundColor: '#FDF2F2' } : r >= 0.6 ? { color: '#B45309', backgroundColor: '#FFFBEB' } : { color: '#047857', backgroundColor: '#ECFDF5' };
            return (
              <div className="card px-4 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm text-navy font-medium">{vi ? 'Khối lượng Odoo / giới hạn sync (7 ngày)' : 'Odoo volume vs sync caps (7-day window)'}</div>
                    <div className="text-xs text-ink-light">{vi ? 'Trên 80% = cần phân trang đọc Odoo trước khi mất đơn' : 'Above 80% = paginate the Odoo read before orders silently drop'}</div>
                  </div>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={tone(worst)}>
                    {worst >= 0.8 ? (vi ? 'Gần giới hạn' : 'Near cap') : `${Math.round(worst * 100)}%`}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {gauges.map(x => (
                    <div key={x.key} className="rounded-lg px-2.5 py-1.5 text-xs" style={tone(x.g.count / x.g.cap)}>
                      <div className="font-semibold">{x.label}</div>
                      <div>{x.g.count} / {x.g.cap} · {Math.round(100 * x.g.count / x.g.cap)}%</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* 4. Stock -> Odoo */}
          <Section
            icon={Box}
            title={vi ? 'Kho → Odoo' : 'Stock → Odoo'}
            subtitle={vi ? 'Đã gửi vào kho nhưng chưa lên Odoo (MO)' : 'Sent to stock but not reflected on Odoo (MO)'}
            count={latest.stock_odoo_count} vi={vi}>
            {latest.stock_odoo_issues.length > 0 && (
              <div className="divide-y divide-border-soft">
                {latest.stock_odoo_issues.map((iss, i) => {
                  const fixable = (iss.kind === 'not_synced' || iss.kind === 'drifted') && !!iss.sku;
                  const key = `${iss.date}:${iss.sku}`;
                  return (
                    <div key={i} className="px-4 py-2.5 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-navy min-w-0 truncate">
                          {iss.date} · {iss.product ?? iss.sku ?? '—'}{iss.qty != null ? ` ×${iss.qty}` : ''}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ color: '#B42318', backgroundColor: '#FDF2F2' }}>
                            {iss.kind === 'not_synced' && (vi ? 'Chưa lên Odoo' : 'Not synced to Odoo')}
                            {iss.kind === 'drifted' && `${vi ? 'Lệch MO' : 'MO drift'}: ${iss.from} → ${iss.to}`}
                            {iss.kind === 'no_odoo_product' && (vi ? 'Không thấy SP trên Odoo' : 'No matching Odoo product')}
                            {iss.kind === 'missing_sku' && (vi ? 'Gửi kho không có SKU' : 'Sent to stock with no SKU')}
                            {iss.kind === 'error' && (iss.detail ?? (vi ? 'Lỗi' : 'Error'))}
                          </span>
                          {fixable && (
                            <button onClick={() => fixIssue(iss.date, iss.sku)} disabled={fixing === key}
                              className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full text-white bg-navy hover:bg-navy/90 disabled:opacity-60 transition-colors">
                              <RefreshCw size={11} className={fixing === key ? 'animate-spin' : ''} />
                              {fixing === key ? (vi ? 'Đang tạo…' : 'Fixing…') : (vi ? 'Tạo MO' : 'Create MO')}
                            </button>
                          )}
                        </div>
                      </div>
                      {fixErr[key] && (
                        <div className="text-xs mt-1" style={{ color: '#B42318' }}>{fixErr[key]}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>
          {/* 1. Reconciliation */}
          <Section
            icon={ShieldCheck}
            title={vi ? 'Đối chiếu Odoo' : 'Odoo reconciliation'}
            subtitle={vi ? 'Nhu cầu Odoo so với thẻ đang theo dõi' : 'Odoo demand vs. tracked production cards'}
            count={latest.issue_count} vi={vi}>
            {latest.issues.length > 0 && (
              <div className="divide-y divide-border-soft">
                {latest.issues.slice().sort((a, b) => a.date.localeCompare(b.date) || Math.abs(b.gap) - Math.abs(a.gap)).map((iss, i) => (
                  <div key={i} className="grid grid-cols-12 items-center px-4 py-2.5 gap-2 text-sm">
                    <div className="col-span-2 text-navy">{iss.date}</div>
                    <div className="col-span-2">
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                        style={{ color: TEAM_LABELS[iss.team as Team]?.color, backgroundColor: TEAM_LABELS[iss.team as Team]?.bg }}>
                        {teamLabel(iss.team)}
                      </span>
                    </div>
                    <div className="col-span-4 text-navy truncate">
                      {iss.name}{iss.variantLabel && iss.variantLabel !== 'Standard' ? ` · ${iss.variantLabel}` : ''}
                    </div>
                    <div className="col-span-1 text-right text-ink-light">{iss.needed}</div>
                    <div className="col-span-1 text-right text-ink-light">{iss.tracked}</div>
                    <div className="col-span-2 flex justify-end">
                      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={iss.gap > 0 ? { color: '#B45309', backgroundColor: '#FFFBEB' } : { color: '#B42318', backgroundColor: '#FDF2F2' }}>
                        {iss.gap > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                        {iss.gap > 0 ? `+${iss.gap} (${vi ? 'thừa / doublon' : 'over / duplicate'})` : `${iss.gap} (${vi ? 'thiếu' : 'missing'})`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 2. Delivery-check coverage */}
          <Section
            icon={Truck}
            title={vi ? 'Độ phủ delivery-check' : 'Delivery-check coverage'}
            subtitle={vi ? 'Đơn/dòng Odoo có đủ trong delivery-check không' : 'Every Odoo order/line accounted for in delivery-check'}
            count={latest.delivery_coverage_count} vi={vi}>
            {latest.delivery_coverage_issues.length > 0 && (
              <div className="divide-y divide-border-soft">
                {latest.delivery_coverage_issues.map((iss, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 gap-3 text-sm">
                    <div className="text-navy">
                      <span className="font-mono text-xs">{iss.order_ref}</span> · {iss.date}
                      {iss.sku && <span className="text-ink-light"> · {iss.sku}</span>}
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                      style={iss.kind === 'not_materialized' ? { color: '#B42318', backgroundColor: '#FDF2F2' } : { color: '#B45309', backgroundColor: '#FFFBEB' }}>
                      {iss.kind === 'not_materialized'
                        ? (vi ? 'Chưa mở delivery-check' : 'Never opened')
                        : `${vi ? 'Lệch SL' : 'Qty drift'}: Odoo ${iss.expected_odoo} ≠ app ${iss.expected_app}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          </>)}

          {tab === 'deliveries' && (<>
          {/* 5. Livraisons non bouclées (7 jours glissants) */}
          <Section
            icon={Truck}
            title={vi ? 'Giao hàng chưa hoàn tất (7 ngày)' : 'Livraisons non bouclées (7 jours)'}
            subtitle={vi ? 'Quá hạn: chưa mở / chưa xác nhận / chưa đẩy Odoo — đã kiểm tra chéo với Odoo' : 'Date passée : jamais ouverte / non validée / pas poussée — vérifié en croisé avec Odoo'}
            count={latest.late_delivery_count ?? 0} vi={vi}>
            {(latest.late_delivery_issues ?? []).filter(x => !x.doneOnOdoo).length > 0 && (
              <div className="divide-y divide-border-soft">
                {(latest.late_delivery_issues ?? []).filter(x => !x.doneOnOdoo).map((iss, i) => (
                  <div key={i} className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-navy min-w-0 truncate">
                        {iss.date} · <span className="font-mono text-xs">{iss.order_ref}</span>
                        {iss.shop && <span className="text-ink-light"> · {iss.shop}</span>}
                      </div>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                        style={iss.kind === 'not_validated' ? { color: '#B45309', backgroundColor: '#FFFBEB' } : { color: '#B42318', backgroundColor: '#FDF2F2' }}>
                        {iss.kind === 'never_opened' && (vi ? 'Chưa mở delivery-check' : 'Jamais ouverte')}
                        {iss.kind === 'not_validated' && (vi ? 'Chưa xác nhận xong' : 'Non validée')}
                        {iss.kind === 'not_pushed' && (vi ? 'Chưa đẩy lên Odoo' : 'Pas poussée sur Odoo')}
                      </span>
                    </div>
                    {iss.kind === 'not_pushed' && iss.push_error && (
                      <div className="text-xs mt-1 truncate" style={{ color: '#B42318' }}>{iss.push_error}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Faites sur Odoo mais pas tracées dans l'app — vérifié picking par picking, hors
              compteur d'alerte (Axel, 2026-09-03). Le travail a eu lieu ; seul le traçage manque. */}
          {(latest.late_delivery_issues ?? []).some(x => x.doneOnOdoo) && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3">
                <div className="text-sm font-bold text-navy">✅ {vi ? 'Đã giao trên Odoo nhưng chưa ghi trong app' : "Faites sur Odoo mais pas tracées dans l'app"}</div>
                <div className="text-[11px] text-ink-light">{vi ? 'Picking Odoo đã done — chỉ thiếu bước trên app, không phải giao trễ' : 'Le picking Odoo est validé — il ne manque que le traçage côté app, pas la livraison'}</div>
              </div>
              <div className="divide-y divide-border-soft">
                {(latest.late_delivery_issues ?? []).filter(x => x.doneOnOdoo).map((iss, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2 gap-3 text-sm">
                    <div className="text-ink-light min-w-0 truncate">
                      {iss.date} · <span className="font-mono text-xs">{iss.order_ref}</span>
                      {iss.shop && <span> · {iss.shop}</span>}
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ color: '#4B5563', backgroundColor: '#F3F4F6' }}>
                      {vi ? 'Xong trên Odoo' : 'Faite sur Odoo'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>)}

          {tab === 'main' && (<>
          {/* 3. Production -> Stock */}
          <Section
            icon={Package}
            title={vi ? 'Sản xuất → Kho' : 'Production → Stock'}
            subtitle={vi ? 'Đã sản xuất xong nhưng chưa gửi hết vào kho' : 'Fully produced but not (fully) sent to stock'}
            count={latest.production_stock_count} vi={vi}>
            {latest.production_stock_issues.length > 0 && (
              <div className="divide-y divide-border-soft">
                {latest.production_stock_issues.map((iss, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 gap-3 text-sm">
                    <div className="text-navy min-w-0 truncate">
                      {iss.date} ·{' '}
                      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full"
                        style={{ color: TEAM_LABELS[iss.team as Team]?.color, backgroundColor: TEAM_LABELS[iss.team as Team]?.bg }}>
                        {teamLabel(iss.team)}
                      </span>{' '}
                      {iss.product}{iss.is_extra ? ` (${vi ? 'extra' : 'extra'})` : ''}
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ color: '#B45309', backgroundColor: '#FFFBEB' }}>
                      {vi ? 'Đã làm' : 'Made'} {iss.produced} · {vi ? 'đã gửi' : 'sent'} {iss.sent}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          </>)}

          {tab === 'stock' && (<>
          {/* 6. Stock résiduel / négatif persistant — made-to-order */}
          <Section icon={Box}
            title={vi ? 'Tồn kho bất thường (làm theo đơn)' : 'Stock résiduel (made-to-order)'}
            subtitle={vi ? 'Tồn ≠ 0 không có gửi kho <48h hay giao hàng sắp tới giải thích' : "Stock ≠ 0 sans envoi <48h ni livraison à venir qui l'explique"}
            count={latest.orphan_stock_count ?? 0} vi={vi}>
            {(latest.orphan_stock_issues ?? []).length > 0 && (
              <div className="divide-y divide-border-soft">
                {(latest.orphan_stock_issues ?? []).map((iss, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 gap-3 text-sm">
                    <div className="text-navy min-w-0 truncate">
                      <span className="font-mono text-xs">{iss.sku}</span> · {iss.name}
                      {iss.category && <span className="text-ink-light"> · {iss.category}</span>}
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ color: '#B42318', backgroundColor: '#FDF2F2' }}>
                      {iss.kind === 'orphan_positive'
                        ? `×${iss.qty} ${vi ? 'tồn không rõ lý do' : 'inexpliqué'}`
                        : `${iss.qty} ${vi ? 'âm kéo dài (thiếu gửi kho?)' : 'négatif persistant (envoi kho manquant ?)'}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 7. Sous seuil de sécurité — seuils saisis par les chefs (lab_stock_safety_thresholds) */}
          <Section icon={AlertTriangle}
            title={vi ? 'Dưới ngưỡng an toàn (kho dài hạn)' : 'Sous seuil de sécurité (stock long terme)'}
            subtitle={vi ? 'Macaron · Biscuit Voyage · Tiramisu — ngưỡng do bếp đặt ở tab Phân tích' : 'Macaron · Biscuit Voyage · Tiramisu — seuils saisis par les chefs'}
            count={latest.safety_stock_count ?? 0} vi={vi}>
            {(latest.safety_stock_issues ?? []).length > 0 && (
              <div className="divide-y divide-border-soft">
                {(latest.safety_stock_issues ?? []).map((iss, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-2.5 gap-3 text-sm">
                    <div className="text-navy min-w-0 truncate">
                      <span className="font-mono text-xs">{iss.sku}</span> · {iss.name}
                      <span className="text-ink-light"> · {iss.category}</span>
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0"
                      style={iss.qty <= 0 ? { color: '#B42318', backgroundColor: '#FDF2F2' } : { color: '#B45309', backgroundColor: '#FFFBEB' }}>
                      {iss.qty} / {vi ? 'ngưỡng' : 'seuil'} {iss.threshold}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* 8. Scraps app <-> Odoo — no duplicates, nothing missing */}
          <Section icon={ArrowLeftRight}
            title={vi ? 'Hủy hàng (app) so với Odoo' : 'Scraps app vs Odoo'}
            subtitle={vi ? 'Mỗi lần hủy hàng khai trên app phải có đúng 1 bản ghi trên Odoo' : "Chaque scrap déclaré sur l'app doit avoir exactement 1 fiche sur Odoo"}
            count={latest.scrap_sync_count ?? 0} vi={vi}>
            {(latest.scrap_sync_issues ?? []).length > 0 && (
              <div className="divide-y divide-border-soft">
                {(latest.scrap_sync_issues ?? []).map((iss, i) => {
                  const kindLabel = iss.kind === 'not_synced' ? (vi ? 'chưa đồng bộ Odoo' : 'pas encore sur Odoo')
                    : iss.kind === 'missing_in_odoo' ? (vi ? `Odoo #${iss.odoo_scrap_id} không tồn tại` : `Odoo #${iss.odoo_scrap_id} introuvable`)
                    : iss.kind === 'not_done' ? (vi ? `Odoo #${iss.odoo_scrap_id} chưa xác nhận (${iss.odoo_state})` : `Odoo #${iss.odoo_scrap_id} non validé (${iss.odoo_state})`)
                    : (vi ? `trùng Odoo #${iss.odoo_scrap_id}` : `doublon Odoo #${iss.odoo_scrap_id}`);
                  const sourceLabel = iss.source === 'shop'
                    ? (iss.shop_name ?? (vi ? 'Cửa hàng' : 'Boutique'))
                    : (vi ? 'Xưởng' : 'Labo');
                  return (
                    <div key={i} className="flex items-center justify-between px-4 py-2.5 gap-3 text-sm">
                      <div className="text-navy min-w-0 truncate">
                        {iss.sku && <span className="font-mono text-xs">{iss.sku}</span>} {iss.sku && '· '}{iss.product_name ?? '—'}
                        <span className="text-ink-light"> · {sourceLabel} · ×{iss.qty} · {fmtDateTime(iss.reported_at)}</span>
                      </div>
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ color: '#B42318', backgroundColor: '#FDF2F2' }}>
                        {kindLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {latest.stock_snapshot && (
            <div className="text-[11px] px-1" style={latest.stock_snapshot.error ? { color: '#B42318' } : { color: '#9CA3AF' }}>
              {latest.stock_snapshot.error
                ? `${vi ? 'Lỗi đọc kho Odoo' : 'Erreur lecture stock Odoo'}: ${latest.stock_snapshot.error}`
                : `📸 ${vi ? 'Ảnh chụp kho Odoo' : 'Photo du stock Odoo'}: ${fmtDateTime(latest.stock_snapshot.at)} · ${latest.stock_snapshot.items.length} SKU`}
            </div>
          )}
          </>)}
        </>
      )}

      {history.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-2 px-1">
            {vi ? 'Lịch sử (7 ngày)' : 'History (7 days)'}
          </div>
          <div className="card divide-y divide-border-soft overflow-hidden">
            {history.map(r => {
              const t = totalOf(r);
              return (
                <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm gap-3">
                  <div className="text-ink-light">{fmtDateTime(r.run_at)} · {r.triggered_by === 'cron' ? (vi ? 'Tự động' : 'Auto') : r.triggered_by}</div>
                  <div className="text-xs font-semibold" style={r.error ? { color: '#B42318' } : t === 0 ? { color: '#047857' } : { color: '#B45309' }}>
                    {r.error ? (vi ? 'Lỗi' : 'Failed') : t === 0 ? 'OK' : `${t} ${vi ? 'bất thường' : 'issues'}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, subtitle, count, vi, children }: {
  icon: any; title: string; subtitle: string; count: number; vi: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon size={17} className="text-navy shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-navy">{title}</div>
            <div className="text-[11px] text-ink-light truncate">{subtitle}</div>
          </div>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full shrink-0"
          style={count === 0 ? { color: '#047857', backgroundColor: '#ECFDF5' } : { color: '#B45309', backgroundColor: '#FFFBEB' }}>
          {count === 0 ? 'OK' : `${count} ${vi ? 'bất thường' : 'issues'}`}
        </span>
      </div>
      {count > 0 && children}
    </div>
  );
}
