'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { fmtQty, packHint, type PurchaseLine } from '@/lib/raw-materials';

// Same layout as the purchasing manager's Excel template (___XU_T_MUA_H_NG.xlsx, 2026-10-22):
// company header, title, "Người đề xuất / Team", "Ngày đề xuất", the 7-column table (unit price
// incl. VAT and amount left blank to be filled by hand, as on the paper form), approval box.
const MIN_ROWS = 8;

// Print-only legal names (Axel, 2026-10-22): the app keeps the short names typed by the teams
// ("Hung", "trung", "huong", "Thu Trang"…); the signed paper shows full name + team.
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
const PEOPLE: { keys: string[]; team?: string; full: string; teamLabel: string }[] = [
  { keys: ['hung', 'ta duy hung', 'chef hung'], team: 'hung', full: 'Tạ Duy Hưng', teamLabel: 'Team Macaron' },
  { keys: ['trung', 'le cong trung'], full: 'Lê Công Trung', teamLabel: 'Team Macaron' },
  { keys: ['huong', 'do thi huong'], team: 'entremet', full: 'Đỗ Thị Hường', teamLabel: 'Team Entremet' },
  { keys: ['toan', 'hoang van toan'], full: 'Hoàng Văn Toàn', teamLabel: 'Team Baker' },
  { keys: ['thu trang', 'nguyen thu trang', 'trang'], team: 'baby_mama', full: 'Nguyễn Thu Trang', teamLabel: 'Team Gato' },
  { keys: ['trang', 'thuy trang', 'le thuy trang', 'le thi thuy trang'], full: 'Lê Thùy Trang', teamLabel: 'Team Baker' },
  { keys: ['quan bm', 'quan', 'ly van quan'], team: 'baker', full: 'Lý Văn Quân', teamLabel: 'Team Baker' },
  { keys: ['lam anh', 'mai anh', 'lam mai anh'], full: 'Lâm Mai Anh', teamLabel: 'Team Baker' },
  { keys: ['miss flavor', 'flavor', 'thu huong', 'nguyen thi thu huong'], team: 'kho', full: 'Nguyễn Thị Thu Hương', teamLabel: 'Kho' },
];
const TEAM_PRINT: Record<string, string> = { hung: 'Team Macaron', entremet: 'Team Entremet', baker: 'Team Baker', baby_mama: 'Team Gato', kho: 'Kho' };
function person(name: string | null, team: string): { full: string; teamLabel: string } {
  const n = norm(name ?? '');
  const hit = PEOPLE.find(p => p.keys.includes(n) && (!p.team || p.team === team || n.split(' ').length > 1))
    ?? (team === 'kho' ? PEOPLE.find(p => p.team === 'kho') : undefined);
  return hit ? { full: hit.full, teamLabel: hit.teamLabel } : { full: name ?? '', teamLabel: TEAM_PRINT[team] ?? team };
}
// Who is written as "Người đề xuất" (Axel, 2026-10-23): the team lead signs for the team, whoever typed it.
// Team Macaron (hung): Tạ Duy Hưng for every member, except Lê Công Trung when Trung requests himself.
// Team Baker: everyone is a lead → the requester's own name. Kho: Nguyễn Thị Thu Hương.
const TEAM_LEAD: Record<string, string> = { entremet: 'huong', baby_mama: 'thu trang', kho: 'miss flavor' };
function signer(name: string | null, team: string): { full: string; teamLabel: string } {
  if (team === 'hung') {
    const trung = person(name, team).full === 'Lê Công Trung';
    return { full: trung ? 'Lê Công Trung' : 'Tạ Duy Hưng', teamLabel: 'Team Macaron' };
  }
  const lead = team === 'baker' ? undefined : TEAM_LEAD[team];
  const p = person(lead ?? name, team);
  return { full: p.full, teamLabel: TEAM_PRINT[team] ?? p.teamLabel };
}
const PURCHASER = 'Nguyễn Thị Thu Hương';


function vnDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

export default function PurchasePrintView({ lines }: { lines: PurchaseLine[]; printedBy?: string }) {
  const sorted = [...lines].sort((a, b) => a.requestNo - b.requestNo || a.name.localeCompare(b.name));
  const people = sorted.map(l => signer(l.requestedBy, l.team));
  const requesters = Array.from(new Set(people.map(p => p.full).filter(Boolean)));
  const teams = Array.from(new Set(people.map(p => p.teamLabel).filter(Boolean)));
  const nos = Array.from(new Set(sorted.map(l => l.requestNo))).filter(Boolean);
  const firstDate = sorted.map(l => l.createdAt).filter(Boolean).sort()[0];
  const empty = Math.max(0, MIN_ROWS - sorted.length);

  // One sheet = one page (Axel, 2026-10-24: the signature names were spilling onto a 2nd page).
  // Print styles are compacted below, and right before printing the sheet is scaled down to the
  // printable height of an A4 landscape page (210mm - 2×8mm margins) if it is still taller.
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const PRINTABLE_PX = (194 / 25.4) * 96; // 194mm at 96 dpi
    const fit = () => {
      const el = sheetRef.current; if (!el) return;
      (el.style as any).zoom = '';
      const h = el.scrollHeight;
      if (h > PRINTABLE_PX) (el.style as any).zoom = String(Math.max(0.6, (PRINTABLE_PX - 4) / h));
    };
    const reset = () => { const el = sheetRef.current; if (el) (el.style as any).zoom = ''; };
    window.addEventListener('beforeprint', fit);
    window.addEventListener('afterprint', reset);
    return () => { window.removeEventListener('beforeprint', fit); window.removeEventListener('afterprint', reset); };
  }, []);

  return (
    <div>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 8mm 12mm; size: A4 landscape; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .prprint-sheet { margin: 0 auto !important; padding: 0 !important; max-width: none !important; }
          .prprint-table th, .prprint-table td { padding: 3px 6px !important; }
          .prprint-sign-gap { height: 60px !important; }
        }
        .prprint-sign { break-inside: avoid; page-break-inside: avoid; }
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

      <div ref={sheetRef} className="prprint-sheet" style={{ background: '#fff', color: '#111', maxWidth: '1040px', margin: '24px auto', padding: '20px 28px', fontFamily: "'Times New Roman', serif", fontSize: 13.5 }}>
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

        <div className="prprint-sign" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 22 }}>
          <div style={{ width: 300, textAlign: 'center', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700 }}>Người lập phiếu</div>
            <div style={{ fontStyle: 'italic' }}>(Ký, ghi rõ họ tên)</div>
            <div className="prprint-sign-gap" style={{ height: 90 }} />
            <div style={{ fontWeight: 700 }}>{PURCHASER}</div>
          </div>
          <div style={{ width: 300, textAlign: 'center', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700 }}>Phê Duyệt</div>
            <div style={{ fontStyle: 'italic' }}>(Ký, ghi rõ họ tên)</div>
            <div className="prprint-sign-gap" style={{ height: 90 }} />
            <div style={{ fontWeight: 700 }}>Dương Xuân Giang</div>
          </div>
        </div>
      </div>
    </div>
  );
}
