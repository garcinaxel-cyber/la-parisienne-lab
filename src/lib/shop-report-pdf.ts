// Shared client-side PDF export for a shop's end-of-day report (ShopDailyReport) — extracted
// 2026-09-11 from ShopView.tsx's exportReportPdf so the shop-manager cockpit's new Report tab
// (src/app/shop-manager/ReportTab.tsx) can offer the exact same "Xuất PDF" behaviour per day
// instead of re-implementing ~170 lines of jsPDF drawing code (Axel: "optimise ... pour que
// l'usage supabase/vercel soit reduit" — this is a pure client-side/no-new-route concern, but the
// same "don't duplicate" spirit applies to the app bundle itself).
//
// Client-side only (Axel, 2026-09-03: "le rapport doit etre exportable pdf ... pdf en viet bien
// sur") — draws the report as real vector text via jsPDF's own text/shape APIs (not a DOM
// screenshot), so the PDF is sharp at any zoom, has selectable/searchable text, and stays small.
// Vietnamese diacritics need a font that actually has those glyphs (jsPDF's built-in fonts
// don't), so a Noto Sans subset is embedded from src/lib/pdf-fonts.ts (regenerating that file is
// documented there).
import type { ShopDailyReport, ShopStockCountLine } from '@/app/shop/actions';

export function groupStockByCategory(lines: ShopStockCountLine[]): { category: string; lines: ShopStockCountLine[] }[] {
  const byCategory = new Map<string, ShopStockCountLine[]>();
  for (const l of lines) {
    if (!byCategory.has(l.category)) byCategory.set(l.category, []);
    byCategory.get(l.category)!.push(l);
  }
  return Array.from(byCategory.entries()).map(([category, lines]) => ({ category, lines }));
}

export function fmtReportDate(d: string) {
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}

export async function exportShopDailyReportPdf(shopName: string, report: ShopDailyReport): Promise<void> {
  const [{ jsPDF }, { NOTO_SANS_VN_REGULAR_BASE64, NOTO_SANS_VN_BOLD_BASE64 }] = await Promise.all([
    import('jspdf'),
    import('@/lib/pdf-fonts'),
  ]);

  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  pdf.addFileToVFS('NotoSansVN-Regular.ttf', NOTO_SANS_VN_REGULAR_BASE64);
  pdf.addFont('NotoSansVN-Regular.ttf', 'NotoSansVN', 'normal');
  pdf.addFileToVFS('NotoSansVN-Bold.ttf', NOTO_SANS_VN_BOLD_BASE64);
  pdf.addFont('NotoSansVN-Bold.ttf', 'NotoSansVN', 'bold');
  pdf.setFont('NotoSansVN', 'normal');

  const MARGIN = 32;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const contentWidth = pageWidth - MARGIN * 2;
  const usableBottom = pageHeight - MARGIN - 14; // reserve room for the page-number footer

  const DARK: [number, number, number] = [31, 41, 55];
  const GRAY: [number, number, number] = [107, 114, 128];
  const LIGHT_GRAY: [number, number, number] = [156, 163, 175];
  const RED: [number, number, number] = [220, 38, 38];
  const HEADER_BG: [number, number, number] = [243, 244, 246];
  const DIVIDER: [number, number, number] = [229, 231, 235];

  // Compact rows (Axel: "reduit la taille des lignes") — small font, tight row height.
  const ROW_FONT = 8;
  const ROW_H = 12.5;
  const CAT_HEADER_FONT = 8;
  const CAT_HEADER_H = 14;
  const SECTION_TITLE_FONT = 9.5;
  const SECTION_TITLE_H = 16;

  let cursorY = MARGIN;

  const ensureSpace = (h: number) => {
    if (cursorY + h > usableBottom) {
      pdf.addPage();
      cursorY = MARGIN;
    }
  };

  // Truncates with an ellipsis instead of wrapping, so every row stays exactly one line tall.
  const fitText = (text: string, maxWidth: number): string => {
    if (pdf.getTextWidth(text) <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (pdf.getTextWidth(text.slice(0, mid) + '…') <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '…';
  };

  const drawDivider = (y: number) => {
    pdf.setDrawColor(...DIVIDER);
    pdf.setLineWidth(0.4);
    pdf.line(MARGIN, y, pageWidth - MARGIN, y);
  };

  const drawCategoryHeader = (label: string) => {
    // Never leave a lone header at the bottom of a page — it must fit alongside one row.
    if (cursorY + CAT_HEADER_H + ROW_H > usableBottom) {
      pdf.addPage();
      cursorY = MARGIN;
    }
    pdf.setFillColor(...HEADER_BG);
    pdf.rect(MARGIN, cursorY, contentWidth, CAT_HEADER_H, 'F');
    pdf.setFont('NotoSansVN', 'bold');
    pdf.setFontSize(CAT_HEADER_FONT);
    pdf.setTextColor(...GRAY);
    pdf.text(label.toUpperCase(), MARGIN + 6, cursorY + CAT_HEADER_H / 2, { baseline: 'middle' });
    cursorY += CAT_HEADER_H;
  };

  const drawProductRow = (name: string, qtyLabel: string, color: [number, number, number], bold: boolean) => {
    ensureSpace(ROW_H);
    const qtyWidth = 64;
    pdf.setFont('NotoSansVN', bold ? 'bold' : 'normal');
    pdf.setFontSize(ROW_FONT);
    pdf.setTextColor(...color);
    pdf.text(fitText(name, contentWidth - qtyWidth - 10), MARGIN + 6, cursorY + ROW_H / 2, { baseline: 'middle' });
    pdf.setFont('NotoSansVN', 'bold');
    pdf.text(qtyLabel, pageWidth - MARGIN - 6, cursorY + ROW_H / 2, { baseline: 'middle', align: 'right' });
    drawDivider(cursorY + ROW_H);
    cursorY += ROW_H;
  };

  // ── Header ──
  pdf.setFont('NotoSansVN', 'bold');
  pdf.setFontSize(13);
  pdf.setTextColor(...DARK);
  pdf.text(shopName, MARGIN, cursorY, { baseline: 'top' });
  cursorY += 17;
  pdf.setFont('NotoSansVN', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(...GRAY);
  pdf.text(`Báo cáo cuối ngày · ${fmtReportDate(report.date)}`, MARGIN, cursorY, { baseline: 'top' });
  cursorY += 14;
  drawDivider(cursorY);
  cursorY += 12;

  // ── Kiểm kho progress ──
  ensureSpace(SECTION_TITLE_H);
  pdf.setFont('NotoSansVN', 'bold');
  pdf.setFontSize(SECTION_TITLE_FONT);
  pdf.setTextColor(...GRAY);
  pdf.text('KIỂM KHO', MARGIN, cursorY, { baseline: 'top' });
  pdf.setTextColor(...DARK);
  pdf.text(`${report.stockCountedCount}/${report.stockTotalCount} đã kiểm`, pageWidth - MARGIN, cursorY, {
    baseline: 'top',
    align: 'right',
  });
  cursorY += SECTION_TITLE_H + 4;

  // ── Stock lines, by category ──
  for (const g of groupStockByCategory(report.stockLines)) {
    drawCategoryHeader(g.category);
    for (const l of g.lines) {
      if (l.qty === null) {
        drawProductRow(l.name, 'Chưa kiểm', LIGHT_GRAY, false);
      } else if (l.qty === 0) {
        drawProductRow(l.name, '0', RED, true);
      } else {
        drawProductRow(l.name, String(l.qty), DARK, false);
      }
    }
    cursorY += 8;
  }

  // ── Losses ── (drawCategoryHeader below already guards its own space + header-orphan check)
  const lossesTitle = `HAO HỤT NGÀY NÀY${report.lossesReportCount ? ` · ${report.lossesReportCount} báo cáo` : ''}`;
  drawCategoryHeader(lossesTitle);
  if (!report.losses.length) {
    ensureSpace(ROW_H);
    pdf.setFont('NotoSansVN', 'normal');
    pdf.setFontSize(ROW_FONT);
    pdf.setTextColor(...LIGHT_GRAY);
    pdf.text('Không có hao hụt ngày này', MARGIN + 6, cursorY + ROW_H / 2, { baseline: 'middle' });
    cursorY += ROW_H;
  } else {
    for (const p of report.losses) {
      drawProductRow(p.productName, `×${p.qty}`, RED, true);
    }
  }

  // ── Page numbers ──
  const totalPages = pdf.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    pdf.setFont('NotoSansVN', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(...LIGHT_GRAY);
    pdf.text(`Trang ${p}/${totalPages}`, pageWidth / 2, pageHeight - 18, { baseline: 'top', align: 'center' });
  }

  pdf.save(`bao-cao-${shopName}-${report.date}.pdf`);
}
