'use client';
import { Printer } from 'lucide-react';

// Same design as the PDF templates validated by Axel (2026-10-14): soft brown / cream, Vietnamese
// with English in small grey. Labels: 4 × A6 per A4 sheet, one per carton. Note: A4, one row per carton.
const dmy = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const n1 = (x: number) => (Math.round(x * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const CO = 'CÔNG TY CỔ PHẦN LA PARISIENNE';
const ADDR = '18 Phú Xá, Phường Phú Thượng, TP Hà Nội, Việt Nam';
const CONTACT = 'SĐT: 0985 023 553 · Email: Laparisiene09@gmail.com';

const CSS = `
@page { size: A4; margin: 0 }
.oemp * { box-sizing: border-box; margin: 0; padding: 0 }
.oemp { font-family: Lato, Carlito, Arial, sans-serif; color: #3A2E25; -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff }
.oemp .en { color: #9A8B7A; font-weight: 400 }
.oemp .sheet { width: 210mm; height: 297mm; display: grid; grid-template-columns: 105mm 105mm; grid-template-rows: 148.5mm 148.5mm; page-break-after: always; margin: 0 auto; background: #fff }
.oemp .lab { padding: 7mm 7mm 6mm; border-right: 0.4px dashed #E2DBD0; border-bottom: 0.4px dashed #E2DBD0; display: flex; flex-direction: column; gap: 2.2mm; font-size: 8pt; overflow: hidden }
.oemp .hd { display: flex; align-items: center; gap: 3mm; border-bottom: 0.6px solid #E4D9C8; padding-bottom: 2.4mm }
.oemp .hd img { height: 11mm }
.oemp .co { font-size: 6.4pt; line-height: 1.4; color: #9A8B7A } .oemp .co b { color: #3A2E25; font-size: 6.8pt; font-weight: 600 }
.oemp .ttl { font-size: 10.5pt; font-weight: 600; color: #8B6A4F; letter-spacing: 1.6px; display: flex; justify-content: space-between; align-items: baseline }
.oemp .ttl .en { font-size: 7.4pt; letter-spacing: .3px }
.oemp .serial { background: #FAF6EF; border: 0.8px solid #C9B48F; border-radius: 3mm; padding: 2mm 3mm }
.oemp .serial .k { font-size: 6.6pt; color: #8B6A4F; font-weight: 600 } .oemp .serial .v { font-size: 13pt; font-weight: 700; letter-spacing: .6px; font-family: 'DejaVu Sans Mono', Menlo, monospace }
.oemp .grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 3mm; row-gap: 1.6mm }
.oemp .f { border-bottom: 0.6px solid #E4D9C8; padding-bottom: .8mm } .oemp .f.full { grid-column: span 2 }
.oemp .f .k { font-size: 6.2pt; font-weight: 600; color: #9A8B7A; display: block } .oemp .f .v { font-size: 8.4pt; font-weight: 600; min-height: 4mm; display: block }
.oemp .note { font-size: 6.2pt; line-height: 1.4; color: #9A8B7A; margin-top: auto } .oemp .note b { color: #5C4B3D }
.oemp .resp { font-size: 6.4pt; line-height: 1.4; font-weight: 600; color: #5C4B3D; background: #FAF6EF; border-radius: 2.5mm; padding: 1.8mm 2.4mm } .oemp .resp .en { font-weight: 400 }
.oemp .pg { width: 210mm; min-height: 297mm; padding: 11mm 14mm 10mm; margin: 0 auto; background: #fff; font-size: 8.4pt }
.oemp .nhd { display: flex; justify-content: space-between; align-items: center; border-bottom: 0.6px solid #E4D9C8; padding-bottom: 4mm }
.oemp .nhd img { height: 14mm } .oemp .nco { text-align: right; font-size: 7.6pt; line-height: 1.55; color: #9A8B7A } .oemp .nco b { font-size: 8.6pt; color: #3A2E25; font-weight: 600 }
.oemp .nttl { text-align: center; margin: 5mm 0 4mm } .oemp .nttl h1 { font-size: 14pt; font-weight: 600; color: #8B6A4F; letter-spacing: 2.4px } .oemp .nttl .en { font-size: 8.4pt }
.oemp .cbox { background: #FAF6EF; border-radius: 3mm; padding: 2.6mm 4mm; line-height: 1.7; margin-bottom: 3mm }
.oemp .cbox > div { display: grid; grid-template-columns: 46mm 1fr } .oemp .cbox .lb { font-weight: 600; color: #5C4B3D } .oemp .cbox .lb .en { font-size: 7pt }
.oemp .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2mm 6mm; margin-bottom: 4mm }
.oemp .m { border-bottom: 0.6px solid #E4D9C8; padding-bottom: 1mm } .oemp .m .lb { font-size: 7pt; color: #9A8B7A; display: block } .oemp .m .v { font-weight: 600 }
.oemp table { width: 100%; border-collapse: collapse; font-size: 7.8pt }
.oemp th { background: #FAF6EF; border-bottom: 0.6px solid #E4D9C8; padding: 1.6mm 1mm; font-size: 7pt; font-weight: 600; color: #5C4B3D; text-align: left } .oemp th .en { display: block; font-size: 6.2pt; font-weight: 400 }
.oemp td { border-bottom: 0.6px solid #EFE8DC; padding: 1.3mm 1mm } .oemp td.r, .oemp th.r { text-align: right } .oemp td.mono { font-family: 'DejaVu Sans Mono', Menlo, monospace; font-size: 7.2pt }
.oemp tfoot td { font-weight: 700; background: #FAF6EF }
.oemp .chk { margin-top: 4mm; background: #FAF6EF; border-radius: 3mm; padding: 3mm 4mm; line-height: 1.75; color: #5C4B3D; page-break-inside: avoid }
.oemp .chk .h { font-weight: 600; color: #8B6A4F } .oemp .box { display: inline-block; width: 9px; height: 9px; border: 1px solid #B8A890; border-radius: 2.5px; vertical-align: -1px; margin-right: 4px }
.oemp .terms { margin-top: 3mm; font-size: 7pt; line-height: 1.55; color: #9A8B7A; page-break-inside: avoid }
.oemp .sig { margin-top: 6mm; display: grid; grid-template-columns: 1fr 1fr; gap: 10mm; text-align: center; page-break-inside: avoid }
.oemp .sig .t { font-weight: 600; color: #8B6A4F; letter-spacing: .6px } .oemp .sig .s { height: 20mm; border: 0.6px solid #E4D9C8; border-radius: 3mm; margin: 2mm 4mm }
.oemp .sig .l { text-align: left; margin: 0 4mm; font-size: 7.6pt; line-height: 1.9; color: #5C4B3D }
@media screen { .oemp { background: #EDE7DC; padding: 12px 0 } .oemp .sheet, .oemp .pg { box-shadow: 0 2px 12px rgba(0,0,0,.08); margin-bottom: 12px } }
@media print { .no-print { display: none !important } .oemp { padding: 0 } }
`;

export default function OemPrintView({ doc, note, cartons, names, client }: { doc: 'labels' | 'note'; note: any; cartons: any[]; names: Record<string, string>; client: any }) {
  const total = cartons.length;
  const kg = cartons.reduce((s, c) => s + Number(c.net_kg), 0); const bags = cartons.reduce((s, c) => s + Number(c.bags), 0);
  const F = (vi: string, en: string, v: string, full = false) => <div className={`f${full ? ' full' : ''}`}><span className="k">{vi} <span className="en">/ {en}</span></span><span className="v">{v}</span></div>;
  const pages: any[][] = []; for (let i = 0; i < cartons.length; i += 4) pages.push(cartons.slice(i, i + 4));
  return (
    <div className="oemp">
      <style>{CSS}</style>
      <div className="no-print" style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', justifyContent: 'center', gap: 12, padding: '10px 0' }}>
        <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#1A4731', color: '#fff', fontWeight: 700, borderRadius: 12, padding: '10px 18px' }}>
          <Printer size={16} /> {doc === 'labels' ? `In ${total} tem thùng` : 'In phiếu giao hàng'}
        </button>
      </div>
      {doc === 'labels' ? pages.map((pg, pi) => (
        <div className="sheet" key={pi}>
          {pg.map((c: any) => (
            <div className="lab" key={c.id}>
              <div className="hd">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/logo-print.png" alt="La Paris" /><div className="co"><b>{CO}</b><br />{ADDR}</div></div>
              <div className="ttl"><span>TEM THÙNG HÀNG <span className="en">/ Carton label</span></span><span className="en">{c.line_no} / {total}</span></div>
              <div className="serial"><div className="k">Số serial thùng <span className="en">/ Carton S/N</span></div><div className="v">{c.serial}</div></div>
              <div className="grid">
                {F('Khách hàng', 'Client', client.legal ?? note.client_name, true)}
                {F('Mã đơn hàng', 'Order ref', note.order_ref)}{F('Số phiếu giao', 'Delivery note', note.note_no)}
                {F('Sản phẩm', 'Product', names[c.sku] ?? c.sku, true)}
                {F('Mã sản phẩm', 'SKU', c.sku)}{F('Số lô', 'Lot no.', c.lot_no)}
                {F('Ngày sản xuất', 'Production date', dmy(c.prod_date))}{F('Ngày đóng gói', 'Packing date', dmy(note.pack_date))}
                {F('Hạn sử dụng', 'Best before', dmy(note.best_before))}{F('Ngày giao hàng', 'Delivery date', dmy(note.delivery_date))}
                {F('Số túi × quy cách', 'Bags × size', `${c.bags} × ${n1(Number(c.bag_kg))} kg`)}{F('KL tịnh', 'Net weight', `${n1(Number(c.net_kg))} kg`)}
                {F('Người đóng gói / KCS', 'Packed & checked by', '', true)}
              </div>
              <div className="note"><b>Bảo quản:</b> nơi khô ráo, thoáng mát (&lt; 25 °C), tránh ánh nắng và côn trùng. <span className="en">Store dry &amp; cool, away from sunlight and pests.</span></div>
              <div className="resp">Thùng được dán kín. Sau khi mở bao, bên nhận chịu trách nhiệm bảo quản và đóng gói lại.<br /><span className="en">Carton taped closed. Once opened, storage and repacking are the receiver&apos;s responsibility.</span></div>
            </div>
          ))}
        </div>
      )) : (
        <div className="pg">
          <div className="nhd">{/* eslint-disable-next-line @next/next/no-img-element */}<img src="/logo-print.png" alt="La Paris" /><div className="nco"><b>{CO}</b><br />{ADDR}<br />{CONTACT}</div></div>
          <div className="nttl"><h1>PHIẾU GIAO HÀNG</h1><span className="en">Delivery note</span></div>
          <div className="cbox">
            <div><span className="lb">Khách hàng <span className="en">/ Client</span></span><b>{client.legal ?? note.client_name}</b></div>
            {client.addr && <div><span className="lb">Địa chỉ <span className="en">/ Registered address</span></span><span>{client.addr}</span></div>}
            {(client.tax || client.phone) && <div><span className="lb">MST <span className="en">/ Tax ID</span></span><span>{client.tax}{client.phone ? `   ·   ĐT ${client.phone}` : ''}</span></div>}
            <div><span className="lb">Địa chỉ giao hàng <span className="en">/ Delivery address</span></span><span>{client.ship || '……………………………………………………'}</span></div>
            <div><span className="lb">Người nhận hàng <span className="en">/ Receiving contact</span></span><span>{client.contact || '……………………………………………………'}</span></div>
          </div>
          <div className="meta">
            <div className="m"><span className="lb">Số phiếu / Note no.</span><span className="v">{note.note_no}</span></div>
            <div className="m"><span className="lb">Mã đơn hàng (Odoo) / Order ref</span><span className="v">{note.order_ref}</span></div>
            <div className="m"><span className="lb">Ngày giao / Delivery date</span><span className="v">{dmy(note.delivery_date)}</span></div>
            <div className="m"><span className="lb">Ngày đóng gói / Packing date</span><span className="v">{dmy(note.pack_date)}</span></div>
            <div className="m"><span className="lb">Hạn sử dụng / Best before</span><span className="v">{dmy(note.best_before)}</span></div>
            <div className="m"><span className="lb">Giờ giao / Time · Xe / Vehicle</span><span className="v">&nbsp;</span></div>
          </div>
          <table>
            <thead><tr><th>STT<span className="en">No.</span></th><th>Số serial thùng<span className="en">Carton S/N</span></th><th>Sản phẩm<span className="en">Product</span></th><th>Số lô / Ngày SX<span className="en">Lot / prod. date</span></th><th className="r">Số túi<span className="en">Bags</span></th><th className="r">Quy cách<span className="en">Bag size</span></th><th className="r">KL tịnh (kg)<span className="en">Net kg</span></th><th>Ghi chú<span className="en">Notes</span></th></tr></thead>
            <tbody>{cartons.map(c => (
              <tr key={c.id}><td>{c.line_no}</td><td className="mono">{c.serial}</td><td>{names[c.sku] ?? c.sku}</td><td>{c.lot_no} · {dmy(c.prod_date)}</td><td className="r">{c.bags}</td><td className="r">{n1(Number(c.bag_kg))} kg</td><td className="r">{n1(Number(c.net_kg))}</td><td></td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={4} className="r">Tổng cộng / Total · {total} thùng</td><td className="r">{bags}</td><td></td><td className="r">{n1(kg)}</td><td></td></tr></tfoot>
          </table>
          <div className="chk">
            <div className="h">Tình trạng khi nhận hàng <span className="en">/ Condition at reception</span> — bên nhận đánh dấu <span className="en">(to be ticked by the receiver)</span></div>
            <div><span className="box" />Đủ số thùng <span className="en">/ all cartons received</span>&nbsp;&nbsp;&nbsp;&nbsp;<span className="box" />Thùng còn dán kín <span className="en">/ cartons still taped closed</span></div>
            <div><span className="box" />Bao bì nguyên vẹn, khô ráo <span className="en">/ packaging intact &amp; dry</span>&nbsp;&nbsp;&nbsp;&nbsp;<span className="box" />Không phát hiện côn trùng <span className="en">/ no pests found</span></div>
            <div>Ghi chú khi nhận <span className="en">/ remarks</span>: …………………………………………………………………………………………</div>
          </div>
          <div className="terms">
            • Hàng được giao trong thùng dán kín. Quyền sở hữu và rủi ro chuyển sang bên nhận kể từ khi ký phiếu này. <span className="en">Goods are delivered in taped cartons; ownership and risk pass to the receiver on signature.</span><br />
            • Sau khi mở bao, bên nhận chịu trách nhiệm bảo quản, vệ sinh và đóng gói lại. <span className="en">Once opened, storage, hygiene and repacking are the receiver&apos;s responsibility.</span><br />
            • Khiếu nại chỉ được chấp nhận trong vòng 48 giờ, đối với thùng chưa mở, kèm số serial. La Parisienne lưu mẫu của từng lô. <span className="en">Claims within 48 h, unopened cartons only, quoting the S/N. La Parisienne keeps a retained sample of every lot.</span>
          </div>
          <div className="sig">
            <div><div className="t">BÊN GIAO HÀNG <span className="en">/ Delivered by</span></div><div className="s" /><div className="l">Họ tên / Name: ……………………………<br />KCS đóng thùng / Packed by: ……………………</div></div>
            <div><div className="t">BÊN NHẬN HÀNG <span className="en">/ Received by</span></div><div className="s" /><div className="l">Họ tên / Name: ……………………………<br />Ngày, giờ nhận / Date &amp; time: ……………………</div></div>
          </div>
        </div>
      )}
    </div>
  );
}
