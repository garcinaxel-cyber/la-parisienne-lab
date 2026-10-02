'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { getDailyReportMonthForStaffAction, getDailyReportDayForStaffAction, type ShopDailyReport, type ShopDailyReportSummary } from '@/app/shop/actions';
import { groupStockByCategory, exportShopDailyReportPdf, fmtReportDate } from '@/lib/shop-report-pdf';
import { NAVY, CREAM, INK, INK_LIGHT, BORDER } from './ShopManagerView';

// New tab (Axel, 2026-09-11: "idem pour l onglet des managers il faudrait un onglet report avec
// les rapports telechargable des 7 jours glissant") — the manager cockpit had no Report tab at
// all before this. Same data + same "Xuất PDF" export as ShopView's own Báo cáo tab (now a
// rolling 7-day list there too, see actions.ts's fetchDailyReportRange), reusing the exact same
// server action (getDailyReportRangeForStaffAction already accepts role='shop_manager', checked
// against the manager's own lab_shop_managers.shops) and the extracted PDF drawer in
// src/lib/shop-report-pdf.ts — no new backend, no new routes (Axel: "optimise ... pour que
// l'usage supabase/vercel soit reduit"), just this cockpit-styled shell around them.

const L = {
  vi: {
    title: 'Báo cáo cuối ngày', month: 'Tháng', today: 'Hôm nay',
    loading: 'Đang tải…', notCounted: 'Chưa kiểm kho', countedSuffix: 'đã kiểm',
    lossReports: 'báo cáo hao hụt', backToList: 'Danh sách', loadError: 'Lỗi tải dữ liệu',
    stockCount: 'Kiểm kho', valuation: '💰 Valorisation kho',
    notCountedDay: 'Chưa kiểm kho ngày này.',
    lossesTitle: 'Hao hụt ngày này', lossReportsSuffix: 'báo cáo', noLosses: 'Không có hao hụt ngày này',
    exportPdf: 'Xuất PDF', exportError: 'Lỗi khi xuất PDF, vui lòng thử lại.',
    empty: 'Chưa có dữ liệu.',
  },
  en: {
    title: 'End-of-day report', month: 'Month', today: 'Today',
    loading: 'Loading…', notCounted: 'Not counted', countedSuffix: 'counted',
    lossReports: 'loss reports', backToList: 'Day list', loadError: 'Could not load the data',
    stockCount: 'Stock count', valuation: '💰 Stock valuation',
    notCountedDay: 'No stock count for this day.',
    lossesTitle: 'Losses this day', lossReportsSuffix: 'reports', noLosses: 'No losses this day',
    exportPdf: 'Export PDF', exportError: 'Error exporting PDF, please try again.',
    empty: 'No data yet.',
  },
} as const;
type LKey = keyof typeof L.vi;
function useL() {
  const { lang } = useI18n();
  const d = (lang === 'en' ? L.en : L.vi) as Record<LKey, string>;
  return { tr: (k: LKey) => d[k], lang };
}

function fmtVnd(v: number): string {
  return `${Math.round(v).toLocaleString('vi-VN')} ₫`;
}

export default function ReportTab({ activeShop }: { activeShop: string }) {
  const { tr } = useL();
  // 2026-10-02 (Axel: history = current month + previous month, M-2 hidden): `reports` is one
  // month of per-day summaries; a day's full report (`selected`) is fetched when it is opened.
  // Same server actions/window as the shop's own Báo cáo tab.
  const [reports, setReports] = useState<ShopDailyReportSummary[] | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShopDailyReport | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (m?: string) => {
    if (!activeShop) return;
    setReports(null);
    setSelectedDate(null);
    setSelected(null);
    setMsg(null);
    if (m) setMonth(m);
    const res = await getDailyReportMonthForStaffAction(activeShop, m);
    if (res.error || !res.data) { setMsg(res.error ?? tr('loadError')); setReports([]); return; }
    setMonths(res.data.months);
    setMonth(res.data.month);
    setToday(res.data.today);
    setReports(res.data.days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShop]);
  useEffect(() => { load(); }, [load]);

  async function openDay(date: string) {
    setSelectedDate(date);
    setSelected(null);
    setMsg(null);
    setDayLoading(true);
    const res = await getDailyReportDayForStaffAction(activeShop, date);
    setDayLoading(false);
    if (res.error || !res.report) { setMsg(res.error ?? tr('loadError')); return; }
    setSelected(res.report);
  }

  const fmtMonth = (m: string) => `${tr('month')} ${Number(m.slice(5, 7))}/${m.slice(0, 4)}`;

  async function exportPdf() {
    if (!selected) return;
    setExporting(true);
    setMsg(null);
    try {
      await exportShopDailyReportPdf(activeShop, selected);
    } catch {
      setMsg(tr('exportError'));
    } finally {
      setExporting(false);
    }
  }

  if (!selectedDate) {
    return (
      <div className="space-y-3">
        <div className="bg-white rounded-2xl p-4" style={{ border: `1px solid ${BORDER}` }}>
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('title')}{month ? ` · ${fmtMonth(month)}` : ''}</div>
          <div className="text-sm font-bold mt-0.5" style={{ color: NAVY }}>{activeShop}</div>
          {months.length > 1 && (
            <div className="flex gap-2 mt-3">
              {months.map(m => (
                <button key={m} onClick={() => { if (m !== month) load(m); }} disabled={!reports}
                  className="flex-1 rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-60"
                  style={m === month
                    ? { backgroundColor: NAVY, color: '#FFFAEE' }
                    : { backgroundColor: '#fff', color: NAVY, border: `1px solid ${BORDER}` }}>
                  {fmtMonth(m)}
                </button>
              ))}
            </div>
          )}
        </div>

        {!reports ? (
          <div className="text-center py-10"><Loader2 className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
        ) : !reports.length ? (
          <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: INK_LIGHT, border: `1px solid ${BORDER}` }}>{tr('empty')}</div>
        ) : (
          <div className="space-y-2">
            {reports.map(r => (
              <button key={r.date} onClick={() => openDay(r.date)}
                className="w-full text-left bg-white rounded-2xl p-3.5 flex items-center justify-between gap-3"
                style={{ border: `1px solid ${BORDER}` }}>
                <div className="min-w-0">
                  <div className="text-sm font-bold" style={{ color: NAVY }}>{fmtReportDate(r.date)}{r.date === today ? ` · ${tr('today')}` : ''}</div>
                  <div className="text-xs mt-0.5" style={{ color: r.stockCounted ? INK_LIGHT : '#9CA3AF' }}>
                    {r.stockCounted ? `${r.stockCountedCount}/${r.stockTotalCount} ${tr('countedSuffix')}${r.stockSource === 'official' ? ' · Kiểm kê chính thức / Official inventory' : ''}` : tr('notCounted')}
                    {r.lossesReportCount ? ` · ${r.lossesReportCount} ${tr('lossReports')}` : ''}
                  </div>
                </div>
                {r.stockCounted && <div className="text-sm font-bold shrink-0" style={{ color: '#1D4ED8' }}>{fmtVnd(r.stockValuationTotal)}</div>}
              </button>
            ))}
          </div>
        )}
        {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button onClick={() => { setSelectedDate(null); setSelected(null); setMsg(null); }} className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: INK_LIGHT }}>
        <ArrowLeft size={15} /> {month ? fmtMonth(month) : tr('backToList')}
      </button>

      <div className="bg-white rounded-2xl p-4" style={{ border: `1px solid ${BORDER}` }}>
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>
          {tr('title')}{selectedDate ? ` · ${fmtReportDate(selectedDate)}` : ''}
        </div>
        <div className="text-sm font-bold mt-0.5" style={{ color: NAVY }}>{activeShop}</div>
      </div>

      {dayLoading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
      ) : !selected ? null : !selected.stockCounted ? (
        <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: INK_LIGHT, border: `1px solid ${BORDER}` }}>{tr('notCountedDay')}</div>
      ) : (
        <>
          <div className="bg-white rounded-2xl px-4 py-3 flex items-center justify-between" style={{ border: `1px solid ${BORDER}` }}>
            <span className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('stockCount')}</span>
            <span className="text-sm font-bold" style={{ color: NAVY }}>{selected.stockCountedCount}/{selected.stockTotalCount} {tr('countedSuffix')}</span>
          </div>

          <div className="bg-white rounded-2xl px-4 py-3 flex items-center justify-between" style={{ border: `1px solid ${BORDER}` }}>
            <span className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('valuation')}</span>
            <span className="text-sm font-bold" style={{ color: '#1D4ED8' }}>{fmtVnd(selected.stockValuationTotal)}</span>
          </div>

          <div className="space-y-3">
            {groupStockByCategory(selected.stockLines).map(g => (
              <div key={g.category} className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
                <div className="px-4 py-2" style={{ backgroundColor: CREAM }}>
                  <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{g.category}</div>
                </div>
                <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                  {g.lines.map(l => (
                    <div key={l.sku} className="px-4 py-2 flex items-center justify-between gap-3">
                      <span className="text-sm overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch', color: l.qty === 0 ? '#DC2626' : INK, fontWeight: l.qty === 0 ? 700 : 400 }}>{l.name}</span>
                      <span className="text-sm font-bold shrink-0" style={{ color: l.qty === 0 ? '#DC2626' : l.qty === null ? '#9CA3AF' : INK }}>
                        {l.qty === null ? tr('notCounted') : l.qty}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
            <div className="px-4 py-2.5" style={{ backgroundColor: CREAM }}>
              <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>
                {tr('lossesTitle')}{selected.lossesReportCount ? ` · ${selected.lossesReportCount} ${tr('lossReportsSuffix')}` : ''}
              </div>
            </div>
            {!selected.losses.length ? (
              <div className="px-4 py-3 text-sm" style={{ color: '#9CA3AF' }}>{tr('noLosses')}</div>
            ) : (
              <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                {selected.losses.map(p => (
                  <div key={p.productName + p.reasonTagName} className="px-4 py-2 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>{p.productName}</span>
                      <span className="text-sm font-bold shrink-0" style={{ color: '#DC2626' }}>×{p.qty}</span>
                    </div>
                    <div className="text-xs" style={{ color: INK_LIGHT }}>{p.reasonTagName}{p.note ? ` · ${p.note}` : ''}</div>
                    {p.followUpNote && <div className="text-xs" style={{ color: '#8A6D14' }}>🗒️ {p.followUpNote}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {selected?.stockCounted && (
        <button onClick={exportPdf} disabled={exporting}
          className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-bold rounded-lg px-3 py-2 disabled:opacity-40"
          style={{ backgroundColor: NAVY, color: '#FFFAEE' }}>
          {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {tr('exportPdf')}
        </button>
      )}
      {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
    </div>
  );
}
