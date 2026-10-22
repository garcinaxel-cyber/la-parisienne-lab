'use client';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { fmtQty, packHint, TEAM_SHORT, type PurchaseLine } from '@/lib/raw-materials';

// Same layout as the purchasing manager's Excel template (___XU_T_MUA_H_NG.xlsx, 2026-10-22):
// company header, title, "Người đề xuất / Team", "Ngày đề xuất", the 7-column table (unit price
// incl. VAT and amount left blank to be filled by hand, as on the paper form), approval box.
const MIN_ROWS = 8;

function vnDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export default function PurchasePrintView({ lines, printedBy }: { lines: PurchaseLine[]; printedBy: string }) {
  const sorted = [...lines].sort((a, b) => a.requestNo - b.requestNo || a.name.localeCompare(b.name));
  const requesters = Array.from(new Set(sorted.map(l => l.requestedBy).filter(Boolean))) as string[];
  const teams = Array.from(new Set(sorted.map(l => TEAM_SHORT[l.team]?.vi ?? l.team).filter(Boolean)));
  const nos = Array.from(new Set(sorted.map(l => l.requestNo))).filter(Boolean);
  const firstDate = sorted.map(l => l.createdAt).filter(Boolean).sort()[0];
  const empty = Math.max(0, MIN_ROWS - sorted.length);

  return (
    <div>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 10mm 12mm; size: A4 landscape; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        .prprint-table { border-collapse: collapse; width: 100%; }
        .prprint-table th, .prprint-table td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
        .prprint-table th { font-weight: 700; text-align: center; vertical-align: middle; }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-white border-b px-4 py-2 flex items-center justify-between gap-4 shadow-sm">
        <Link href="/purchasing" className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900">
          <ArrowLeft size={15} /> Quay lại / Back
        </Link>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 text-sm font-semibold text-white rounded-xl px-4 py-2" style={{ backgroundColor: '#1f2937' }}>
          <Printer size={15} /> In phiếu / Print
        </button>
      </div>

      <div style={{ background: '#fff', color: '#111', maxWidth: '1040px', margin: '24px auto', padding: '20px 28px', fontFamily: "'Times New Roman', serif", fontSize: 13.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-print.png" alt="La Paris" style={{ height: 56 }} />
          <div style={{ lineHeight: 1.45 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>CÔNG TY CỔ PHẦN LA PARISIENNE</div>
            <div>Địa chỉ: Số 18 Phú Xá, Phường Phú Thượng, Thành Phố Hà Nội, Việt Nam</div>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 700, margin: '16px 0 12px' }}>PHIẾU ĐỀ XUẤT MUA HÀNG</div>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, lineHeight: 1.7 }}>
          <div>Người đề xuất: <b>{requesters.join(', ')}</b></div>
          <div>Team: <b>{teams.join(', ')}</b></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, lineHeight: 1.7, marginBottom: 8 }}>
          <div>Ngày đề xuất: <b>{vnDate(firstDate)}</b></div>
          {nos.length > 0 && <div style={{ fontSize: 12, color: '#444' }}>Yêu cầu số: {nos.map(n => `#${n}`).join(', ')}</div>}
        </div>

        <table className="prprint-table">
          <thead>
            <tr>
              <th style={{ width: '5%' }}>STT</th>
              <th style={{ width: '35%' }}>TÊN VẬT TƯ</th>
              <th style={{ width: '9%' }}>ĐƠN VỊ TÍNH</th>
              <th style={{ width: '9%' }}>SỐ LƯỢNG</th>
              <th style={{ width: '13%' }}>ĐƠN GIÁ<br />(ĐÃ BAO GỒM VAT)</th>
              <th style={{ width: '12%' }}>THÀNH TIỀN</th>
              <th style={{ width: '17%' }}>GHI CHÚ</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l, i) => {
              const ph = packHint(l);
              const note = [l.brand ? `${l.brandStrict ? 'Chỉ ' : ''}${l.brand}` : '', ph ? `(${ph})` : '', l.note ?? ''].filter(Boolean).join(' · ');
              return (
                <tr key={l.id}>
                  <td style={{ textAlign: 'center' }}>{i + 1}</td>
                  <td>{l.name}{l.sku ? <span style={{ color: '#555', fontSize: 11.5 }}> [{l.sku}]</span> : null}</td>
                  <td style={{ textAlign: 'center' }}>{l.uom}</td>
                  <td style={{ textAlign: 'center' }}>{fmtQty(l.qty)}</td>
                  <td></td>
                  <td></td>
                  <td style={{ fontSize: 12 }}>{note}</td>
                </tr>
              );
            })}
            {Array.from({ length: empty }, (_, k) => (
              <tr key={`e${k}`}><td style={{ textAlign: 'center' }}>{sorted.length + k + 1}</td><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22 }}>
          <div style={{ width: 300, textAlign: 'center', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700 }}>Phê Duyệt</div>
            <div style={{ fontStyle: 'italic' }}>(Ký, ghi rõ họ tên)</div>
            <div style={{ height: 90 }} />
            <div style={{ fontWeight: 700 }}>Nguyễn Thị Thu Hương</div>
          </div>
        </div>
        <div className="no-print" style={{ fontSize: 11, color: '#888', marginTop: 16 }}>In bởi {printedBy}</div>
      </div>
    </div>
  );
}
