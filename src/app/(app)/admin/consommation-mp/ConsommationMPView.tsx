'use client';
// UI du rapport "Consommation matières premières" (2026-09-17, Axel) — lignes claires/blanches,
// une seule colonne mise en avant (le total, en gras navy) plutôt qu'un tableau tout coloré,
// détail par produit fini en accordéon (même pattern que le drill-down "Completion by team
// (delivery)" d'/analytics) plutôt qu'un tableau plat géant.
import { useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { getMpConsumptionReportAction, type MPReport } from './actions';

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days + 1);
  return d.toISOString().split('T')[0];
}
function todayIso(): string {
  return new Date().toISOString().split('T')[0];
}

const TEAMS: Team[] = ['baby_mama', 'hung', 'entremet', 'baker'];

export default function ConsommationMPView() {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [team, setTeam] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MPReport | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const setPreset = (days: number) => { setFrom(isoDaysAgo(days)); setTo(todayIso()); };
  const toggle = (code: string) => setOpen(p => { const n = new Set(p); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const teamLabel = (t: string) => TEAM_LABELS[t as Team] ? (vi ? TEAM_LABELS[t as Team].vi : TEAM_LABELS[t as Team].en) : t;

  async function run() {
    setLoading(true); setError(null);
    const res = await getMpConsumptionReportAction(from, to, team);
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setReport(res.data ?? { rows: [], unresolved: [] });
    setOpen(new Set());
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy">
          {vi ? 'Tiêu thụ nguyên liệu' : 'Consommation matières premières'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {vi
            ? 'Lý thuyết: định mức Odoo × số lượng đã sản xuất trong kỳ'
            : 'Théorique : nomenclature Odoo × quantité produite sur la période'}
        </p>
      </div>

      {/* Filtres */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1.5">
            {[7, 30, 90].map(d => (
              <button key={d} onClick={() => setPreset(d)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-border-soft text-ink-light hover:text-navy transition-colors">
                {d}{vi ? ' ngày' : 'j'}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-xs text-ink-light">
            {vi ? 'Từ ngày' : 'Du'}
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm text-navy" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-light">
            {vi ? 'Đến ngày' : 'Au'}
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm text-navy" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-light">
            {vi ? 'Đội' : 'Équipe'}
            <select value={team} onChange={e => setTeam(e.target.value)}
              className="border border-border-soft rounded-lg px-2 py-1.5 text-sm text-navy">
              <option value="all">{vi ? 'Tất cả' : 'Toutes'}</option>
              {TEAMS.map(t => <option key={t} value={t}>{teamLabel(t)}</option>)}
            </select>
          </label>
          <button onClick={run} disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-navy text-white disabled:opacity-50">
            <RefreshCw size={15} />
            {loading ? (vi ? 'Đang tính...' : 'Calcul en cours...') : (vi ? 'Tính toán' : 'Calculer')}
          </button>
        </div>
        <p className="text-[11px] text-ink-light">
          {vi
            ? 'Chỉ tính khi bạn bấm "Tính toán" — không tự động chạy khi mở trang.'
            : 'Ne se déclenche qu\'au clic sur "Calculer" — jamais automatiquement à l\'ouverture de la page.'}
        </p>
      </div>

      {error && (
        <p className="text-xs rounded-xl px-3 py-2 bg-red-50 text-red-700 border border-red-200">{error}</p>
      )}

      {report && report.unresolved.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={15} className="text-amber-600 shrink-0" />
            <h3 className="font-semibold text-sm text-navy">
              {vi ? 'Không tìm thấy định mức' : 'Sans nomenclature trouvée'}
            </h3>
          </div>
          <p className="text-[11px] text-ink-light mb-2">
            {vi
              ? 'Các SKU này đã được sản xuất trong kỳ nhưng không có BOM trên Odoo — không được tính trong bảng dưới.'
              : 'Ces SKU ont été produits sur la période mais n\'ont pas de nomenclature (BOM) sur Odoo — ils ne sont pas comptés ci-dessous.'}
          </p>
          <div className="space-y-1">
            {report.unresolved.map(u => (
              <div key={u.sku} className="flex justify-between text-[12px]">
                <span className="text-navy truncate pr-3">{u.sku} · {u.name}</span>
                <span className="text-ink-light shrink-0">{u.qtyProduced.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-border-soft flex items-center justify-between">
            <h3 className="font-semibold text-sm text-navy">
              {vi ? 'Theo mã nguyên liệu (MP)' : 'Par SKU de matière première'}
            </h3>
            <span className="text-[11px] text-ink-light">
              {report.rows.length} {vi ? 'nguyên liệu' : 'matières premières'}
            </span>
          </div>
          {report.rows.length === 0 ? (
            <p className="text-xs text-ink-light p-4">
              {vi ? 'Không có dữ liệu cho kỳ này.' : 'Aucune donnée pour cette période.'}
            </p>
          ) : (
            <div className="divide-y divide-border-soft">
              {report.rows.map(row => {
                const isOpen = open.has(row.code);
                return (
                  <div key={row.code}>
                    <button onClick={() => toggle(row.code)} className="w-full text-left px-4 py-3 hover:bg-cream-dark/20 transition-colors">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {isOpen ? <ChevronUp size={13} className="text-ink-light shrink-0" /> : <ChevronDown size={13} className="text-ink-light shrink-0" />}
                          <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-navy truncate">{row.code}</div>
                            <div className="text-[12px] text-ink-light truncate">{row.name}</div>
                          </div>
                        </div>
                        <div className="text-sm font-bold text-navy shrink-0">
                          {row.total.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-[11px] font-normal text-ink-light">{row.uom}</span>
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-3 pl-9 space-y-1.5 bg-gold-pale/40">
                        {row.breakdown.map((b, i) => (
                          <div key={`${b.sku}-${b.team}-${i}`} className="flex items-center justify-between text-[12px]">
                            <div className="flex items-center gap-1.5 min-w-0 pr-3">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: TEAM_LABELS[b.team as Team]?.color ?? '#9CA3AF' }} />
                              <span className="text-navy truncate">{b.name}</span>
                              <span className="text-ink-light shrink-0">· {teamLabel(b.team)}</span>
                            </div>
                            <div className="text-ink-light shrink-0">
                              {b.qtyProduced.toLocaleString()} {vi ? 'cái' : 'u.'} ·{' '}
                              <span className="font-semibold text-navy">
                                {b.contributed.toLocaleString(undefined, { maximumFractionDigits: 2 })} {row.uom}
                              </span>
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
      )}
    </div>
  );
}
