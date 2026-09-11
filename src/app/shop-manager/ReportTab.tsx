'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { getDailyReportRangeForStaffAction, type ShopDailyReport } from '@/app/shop/actions';
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
    title: 'Báo cáo cuối ngày', subtitle: '7 ngày gần nhất', today: 'Hôm nay',
    loading: 'Đang tải…', notCounted: 'Chưa kiểm kho', countedSuffix: 'đã kiểm',
    lossReports: 'báo cáo hao hụt', backToList: '7 ngày gần nhất',
    stockCount: 'Kiểm kho', valuation: '💰 Valorisation kho',
    notCountedDay: 'Chưa kiểm kho ngày này.',
    lossesTitle: 'Hao hụt ngày này', lossReportsSuffix: 'báo cáo', noLosses: 'Không có hao hụt ngày này',
    exportPdf: 'Xuất PDF', exportError: 'Lỗi khi xuất PDF, vui lòng thử lại.',
    empty: 'Chưa có dữ liệu.',
  },
  en: {
    title: 'End-of-day report', subtitle: 'Last 7 days', today: 'Today',
    loading: 'Loading…', notCounted: 'Not counted', countedSuffix: 'counted',
    lossReports: 'loss reports', backToList: 'Last 7 days',
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
  const [reports, setReports] = useState<ShopDailyReport[] | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeShop) return;
    setReports(null);
    setSelectedDate(null);
    const res = await getDailyReportRangeForStaffAction(activeShop);
    setReports(res.reports ?? []);
  }, [activeShop]);
  useEffect(() => { load(); }, [load]);

  const selected = selectedDate ? reports?.find(r => r.date === selectedDate) ?? null : null;

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
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('title')} · {tr('subtitle')}</div>
          <div className="text-sm font-bold mt-0.5" style={{ color: NAVY }}>{activeShop}</div>
        </div>

        {!reports ? (
          <div className="text-center py-10"><Loader2 className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
        ) : !reports.length ? (
          <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: INK_LIGHT, border: `1px solid ${BORDER}` }}>{tr('empty')}</div>
        ) : (
          <div className="space-y-2">
            {reports.map((r, i) => (
              <button key={r.date} onClick={() => setSelectedDate(r.date)}
                className="w-full text-left bg-white rounded-2xl p-3.5 flex items-center justify-between gap-3"
                style={{ border: `1px solid ${BORDER}` }}>
                <div className="min-w-0">
                  <div className="text-sm font-bold" style={{ color: NAVY }}>{fmtReportDate(r.date)}{i === 0 ? ` · ${tr('today')}` : ''}</div>
                  <div className="text-xs mt-0.5" style={{ color: r.stockCounted ? INK_LIGHT : '#9CA3AF' }}>
                    {r.stockCounted ? `${r.stockCountedCount}/${r.stockTotalCount} ${tr('countedSuffix')}` : tr('notCounted')}
                    {r.lossesReportCount ? ` · ${r.lossesReportCount} ${tr('lossReports')}` : ''}
                  </div>
                </div>
                {r.stockCounted && <div className="text-sm font-bold shrink-0" style={{ color: '#1D4ED8' }}>{fmtVnd(r.stockValuationTotal)}</div>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button onClick={() => setSelectedDate(null)} className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: INK_LIGHT }}>
        <ArrowLeft size={15} /> {tr('backToList')}
      </button>

      <div className="bg-white rounded-2xl p-4" style={{ border: `1px solid ${BORDER}` }}>
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>
          {tr('title')}{selected ? ` · ${fmtReportDate(selected.date)}` : ''}
        </div>
        <div className="text-sm font-bold mt-0.5" style={{ color: NAVY }}>{activeShop}</div>
      </div>

      {!selected ? null : !selected.stockCounted ? (
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
                  <div key={p.productName} className="px-4 py-2 flex items-center justify-between gap-2">
                    <span className="text-sm overflow-x-auto whitespace-nowrap no-scrollbar" style={{ WebkitOverflowScrolling: 'touch' }}>{p.productName}</span>
                    <span className="text-sm font-bold shrink-0" style={{ color: '#DC2626' }}>×{p.qty}</span>
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
