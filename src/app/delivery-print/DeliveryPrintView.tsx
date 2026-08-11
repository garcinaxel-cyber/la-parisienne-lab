'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, Printer } from 'lucide-react';
import type { CheckLine, DeliveryOrderHeader } from '@/lib/delivery-check';
import { formatOdooStyleDate, withWarehouseSuffix } from '@/lib/delivery-print';

// Reproduces the Odoo "Picking Operations" LAB/OUT export as closely as possible without
// calling Odoo — same header block, same field order, same date format quirk (MM/DD/YYYY,
// not the Vietnamese DD/MM convention Odoo happens to use on this report). Validated against
// a real export (LAB/OUT/03078, REP/2026/00997) with Axel on 2026-08-11.
//
// "Số phiếu" (the Odoo picking name) is left blank: we don't call Odoo for this print, so we
// don't have that number yet. "Ghi chú" shows the product's own Odoo note (lab_delivery_check_lines.note)
// plus the assistant's discrepancy note if any, stacked on separate lines.
export default function DeliveryPrintView({ header, lines }: { header: DeliveryOrderHeader; lines: CheckLine[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  return (
    <div>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 15mm 15mm 15mm 15mm; size: A4; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        .labprint-table { border-collapse: collapse; width: 100%; }
        .labprint-table th, .labprint-table td { border: 1px solid #000; padding: 4px 6px; }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-white border-b border-border-soft px-4 py-2 flex items-center justify-between gap-4 shadow-sm">
        <Link href={`/delivery-check/${header.delivery_date}/${header.order_ref}`}
          className="flex items-center gap-1.5 text-sm text-ink-light hover:text-navy transition-colors">
          <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
        </Link>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 text-sm font-semibold text-white bg-navy rounded-xl px-4 py-2 hover:bg-navy/80 transition-colors">
          <Printer size={15} /> {vi ? 'In phiếu' : 'Imprimer'}
        </button>
      </div>

      <div style={{ background: '#fff', color: '#111', maxWidth: '720px', margin: '24px auto', padding: '28px 32px', fontFamily: "'Times New Roman', serif" }}>
        <div style={{ textAlign: 'center' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-print.png" alt="La Paris" style={{ height: 70, margin: '0 auto' }} />
          <div style={{ fontSize: 14, lineHeight: 1.5, marginTop: 6 }}>
            <div style={{ fontWeight: 500, fontSize: 16 }}>CÔNG TY CỔ PHẦN LA PARISIENNE</div>
            <div>Địa chỉ: 18 Phú Xá, Phường Phú Thượng, TP Hà Nội, Việt Nam</div>
            <div>SĐT: 0985023553&nbsp;&nbsp;&nbsp;&nbsp;Email: Laparisiene09@gmail.com</div>
            <div>Ngân hàng Techcombank : 609609 mở tại TCB Lạc Long Quân.</div>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 500, margin: '14px 0 10px' }}>Lệnh giao hàng</div>

        <div style={{ fontSize: 14, lineHeight: 1.6 }}>
          <div>Số phiếu:</div>
          <div>Khách hàng:</div>
          <div>Từ: Lab&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Đến: {withWarehouseSuffix(header.shop_name)}</div>
          <div>SĐT:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Email:</div>
          <div>Ngày giao hàng: {formatOdooStyleDate(header.delivery_date)}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Tài liệu gốc: {header.order_ref}</div>
        </div>

        <table className="labprint-table" style={{ marginTop: 12, fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'center' }}>
              <th style={{ width: '6%' }}>STT</th>
              <th style={{ width: '42%' }}>Mã hàng</th>
              <th style={{ width: '12%' }}>ĐVT</th>
              <th style={{ width: '14%' }}>S.L Yêu cầu</th>
              <th style={{ width: '14%' }}>S.L Thực tế</th>
              <th style={{ width: '22%' }}>Ghi chú</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td style={{ textAlign: 'center' }}>{i + 1}</td>
                <td>{l.product_name_vi}</td>
                <td style={{ textAlign: 'center' }}>Đơn vị</td>
                <td style={{ textAlign: 'center' }}>{l.qty_expected}</td>
                <td style={{ textAlign: 'center' }}>{l.qty_checked ?? l.qty_expected}</td>
                <td style={{ fontSize: 11, whiteSpace: 'pre-line' }}>{[l.note, l.discrepancy_note].filter(Boolean).join('\n')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 36, fontSize: 14 }}>
          <div>Khách hàng</div>
          <div>Người lập phiếu</div>
        </div>
      </div>
    </div>
  );
}
