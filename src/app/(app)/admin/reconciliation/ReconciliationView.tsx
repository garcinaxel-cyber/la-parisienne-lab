'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ShieldCheck, AlertTriangle, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { runReconciliationNowAction } from './actions';

type Issue = { date: string; team: string; variantLabel: string; name: string; needed: number; tracked: number; gap: number };
type Run = {
  id: string; run_at: string; triggered_by: string;
  range_from: string; range_to: string; dates_checked: number; issue_count: number;
  issues: Issue[]; error: string | null;
};

export default function ReconciliationView({ runs }: { runs: Run[] }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const latest = runs[0] ?? null;
  const history = runs.slice(1);

  async function runNow() {
    setRunning(true);
    setErr(null);
    const res = await runReconciliationNowAction();
    if (res?.error) setErr(res.error);
    setRunning(false);
    router.refresh();
  }

  const teamLabel = (t: string) => TEAM_LABELS[t as Team] ? (lang === 'vi' ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en) : t;
  const fmtDateTime = (iso: string) => new Date(iso).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <ShieldCheck size={26} className="text-navy" />
            {lang === 'vi' ? 'Kiểm tra đối chiếu Odoo' : 'Odoo reconciliation check'}
          </h1>
          <p className="text-ink-light text-sm mt-1 max-w-xl">
            {lang === 'vi'
              ? 'So sánh nhu cầu thực tế từ Odoo với số lượng đang theo dõi trong app, mỗi ngày tự động — phát hiện thẻ sản xuất bị thiếu HOẶC bị trùng.'
              : "Compares real Odoo demand against what the app is tracking, once a day automatically — catches production cards that are either missing or duplicated."}
          </p>
        </div>
        <button onClick={runNow} disabled={running}
          className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-navy hover:bg-navy/90 disabled:opacity-60 transition-colors">
          <RefreshCw size={16} className={running ? 'animate-spin' : ''} />
          {running
            ? (lang === 'vi' ? 'Đang kiểm tra…' : 'Running…')
            : (lang === 'vi' ? 'Kiểm tra ngay' : 'Run check now')}
        </button>
      </div>

      {err && (
        <div className="card p-3 text-sm border" style={{ borderColor: '#F0B4B4', backgroundColor: '#FDF2F2', color: '#B42318' }}>
          {err}
        </div>
      )}

      {!latest ? (
        <div className="card px-4 py-10 text-center text-sm text-ink-light">
          {lang === 'vi' ? 'Chưa có lần kiểm tra nào.' : 'No check has run yet.'}
        </div>
      ) : (
        <>
          <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-1">
                {lang === 'vi' ? 'Lần kiểm tra gần nhất' : 'Last check'}
              </div>
              <div className="text-sm text-navy font-medium">{fmtDateTime(latest.run_at)}</div>
              <div className="text-xs text-ink-light mt-0.5">
                {latest.triggered_by === 'cron' ? (lang === 'vi' ? 'Tự động' : 'Automatic') : latest.triggered_by}
                {' · '}{latest.range_from} → {latest.range_to}
                {' · '}{latest.dates_checked} {lang === 'vi' ? 'ngày' : 'days'}
              </div>
            </div>
            <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold ${
              latest.error ? '' : latest.issue_count === 0 ? '' : ''
            }`} style={
              latest.error ? { backgroundColor: '#FDF2F2', color: '#B42318' }
              : latest.issue_count === 0 ? { backgroundColor: '#ECFDF5', color: '#047857' }
              : { backgroundColor: '#FFFBEB', color: '#B45309' }
            }>
              {latest.error ? <AlertTriangle size={16} /> : latest.issue_count === 0 ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
              {latest.error
                ? (lang === 'vi' ? 'Lỗi khi kiểm tra' : 'Check failed')
                : latest.issue_count === 0
                  ? (lang === 'vi' ? 'Không có bất thường' : 'No anomalies')
                  : `${latest.issue_count} ${lang === 'vi' ? 'bất thường' : 'anomalies'}`}
            </div>
          </div>

          {latest.error && (
            <div className="card p-3 text-sm border" style={{ borderColor: '#F0B4B4', backgroundColor: '#FDF2F2', color: '#B42318' }}>
              {latest.error}
            </div>
          )}

          {latest.issues.length > 0 && (
            <div className="card overflow-hidden">
              <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 border-b border-border-soft">
                <div className="col-span-2">{lang === 'vi' ? 'Ngày' : 'Date'}</div>
                <div className="col-span-2">{lang === 'vi' ? 'Đội' : 'Team'}</div>
                <div className="col-span-4">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
                <div className="col-span-1 text-right">{lang === 'vi' ? 'Cần' : 'Needed'}</div>
                <div className="col-span-1 text-right">{lang === 'vi' ? 'Theo dõi' : 'Tracked'}</div>
                <div className="col-span-2 text-right">{lang === 'vi' ? 'Chênh lệch' : 'Gap'}</div>
              </div>
              <div className="divide-y divide-border-soft">
                {latest.issues
                  .slice()
                  .sort((a, b) => a.date.localeCompare(b.date) || Math.abs(b.gap) - Math.abs(a.gap))
                  .map((iss, i) => (
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
                          style={iss.gap > 0
                            ? { color: '#B45309', backgroundColor: '#FFFBEB' }
                            : { color: '#B42318', backgroundColor: '#FDF2F2' }}>
                          {iss.gap > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                          {iss.gap > 0
                            ? `+${iss.gap} (${lang === 'vi' ? 'thừa / doublon' : 'over / duplicate'})`
                            : `${iss.gap} (${lang === 'vi' ? 'thiếu' : 'missing'})`}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-light font-semibold mb-2 px-1">
            {lang === 'vi' ? 'Lịch sử' : 'History'}
          </div>
          <div className="card divide-y divide-border-soft overflow-hidden">
            {history.map(r => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm gap-3">
                <div className="text-ink-light">{fmtDateTime(r.run_at)} · {r.triggered_by === 'cron' ? (lang === 'vi' ? 'Tự động' : 'Auto') : r.triggered_by}</div>
                <div className={`text-xs font-semibold ${r.error ? '' : r.issue_count === 0 ? '' : ''}`}
                  style={r.error ? { color: '#B42318' } : r.issue_count === 0 ? { color: '#047857' } : { color: '#B45309' }}>
                  {r.error ? (lang === 'vi' ? 'Lỗi' : 'Failed') : r.issue_count === 0 ? 'OK' : `${r.issue_count} ${lang === 'vi' ? 'bất thường' : 'issues'}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
