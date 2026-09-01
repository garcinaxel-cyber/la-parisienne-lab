'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ShieldCheck, AlertTriangle, RefreshCw, TrendingUp, TrendingDown, Truck, Package, Box } from 'lucide-react';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { runCheckNowAction, fixStockOdooIssueAction } from './actions';

type ReconciliationIssue = { date: string; team: string; variantLabel: string; name: string; needed: number; tracked: number; gap: number };
type DeliveryCoverageIssue = { kind: 'not_materialized' | 'qty_drift'; date: string; order_ref: string; sku?: string; expected_odoo?: number; expected_app?: number };
type ProductionStockIssue = { date: string; team: string; product: string; produced: number; sent: number; gap: number; is_extra: boolean; card_id: string };
type StockOdooIssue = { date: string; kind: 'not_synced' | 'drifted' | 'no_odoo_product' | 'missing_sku' | 'error'; sku?: string; product?: string; qty?: number; mo?: string; from?: number; to?: number; detail?: string };

type Run = {
  id: string; run_at: string; triggered_by: string;
  range_from: string; range_to: string; dates_checked: number; issue_count: number;
  issues: ReconciliationIssue[]; error: string | null;
  check_range_from: string | null; check_range_to: string | null;
  delivery_coverage_issues: DeliveryCoverageIssue[]; delivery_coverage_count: number;
  production_stock_issues: ProductionStockIssue[]; production_stock_count: number;
  stock_odoo_issues: StockOdooIssue[]; stock_odoo_count: number;
};

function totalOf(r: Run): number {
  return r.issue_count + (r.delivery_coverage_count ?? 0) + (r.production_stock_count ?? 0) + (r.stock_odoo_count ?? 0);
}

export default function CheckView({ runs }: { runs: Run[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixErr, setFixErr] = useState<Record<string, string>>({});

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
  const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(vi ? 'vi-VN' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
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
              ? '4 kiểm tra tự động trong 1 lần bấm: đối chiếu Odoo, độ phủ delivery-check, sản xuất → kho, kho → Odoo. Tự động chạy mỗi sáng, lưu 7 ngày.'
              : 'All 4 checks run together in one click: Odoo reconciliation, delivery-check coverage, production → stock, stock → Odoo. Runs automatically every morning, 7-day history.'}
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
        <div className="card px-4 py-10 text-center text-sm text-ink-light">
          {vi ? 'Chưa có lần kiểm tra nào.' : 'No check has run yet.'}
        </div>
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
