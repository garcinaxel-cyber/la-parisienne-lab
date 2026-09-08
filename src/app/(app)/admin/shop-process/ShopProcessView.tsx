'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, ChevronLeft, ChevronRight, Truck, PackageCheck, ShoppingBag, Trash2, ArrowLeftRight } from 'lucide-react';

export type ShopRecap = {
  shop: string;
  reception: {
    totalLines: number; confirmedLines: number; lastConfirmedAt: string | null; confirmedBy: string[];
    // Discrepancies kept for the flag count only -- the cell itself now shows just the two
    // totals (Axel, 2026-09-08: "juste le comparatif total quantite recu vs quantite check").
    discrepancies: { sku: string | null; product: string; expected: number; received: number }[];
    totalExpectedQty: number; totalReceivedQty: number;
  } | null;
  count: { sessionsCount: number; finishedAt: string; finishedBy: string; skuCount: number; valuation: number } | null;
  orders: { ref: string; placedAt: string | null; placedBy: string | null; odooDirect: boolean }[];
  losses: { count: number; totalQty: number };
  transfers: { direction: 'in' | 'out'; otherShop: string; ref: string; status: string; by: string; at: string; units: number }[];
};

const AMBER = '#B45309';
const RED = '#B42318';
const GREEN = '#15803D';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}
function fmtVnd(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫';
}

// Commande/Transferts lists can still grow long on a busy day -- cap what's shown inline and
// fold the rest behind a plain count (Axel: "un ecran assez synthetique").
const MAX_ROWS_SHOWN = 2;

export default function ShopProcessView({ date, which, recaps }: { date: string; which: 'today' | 'yesterday'; recaps: ShopRecap[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const dateLabel = new Date(`${date}T12:00:00+07:00`).toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', {
    weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
  });

  // Every red/amber signal rendered below funnels into this one number -- kept in lockstep
  // with the cells so the header total never quietly under-counts what the table is showing.
  const flagCount = recaps.reduce((n, r) => {
    let f = 0;
    if (r.reception && r.reception.confirmedLines < r.reception.totalLines) f++;
    if (r.reception && r.reception.confirmedLines === r.reception.totalLines && r.reception.totalReceivedQty !== r.reception.totalExpectedQty) f++;
    if (r.count == null) f++;
    if (r.orders.some(o => o.odooDirect)) f++;
    return n + f;
  }, 0);

  return (
    <div className="space-y-5 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <ClipboardList size={26} className="text-navy" />
            {vi ? 'Theo dõi quy trình cửa hàng' : 'Suivi process shops'}
          </h1>
          <p className="text-ink-light text-sm mt-1 max-w-2xl">
            {vi
              ? 'Góc nhìn từ phía cửa hàng: nhận hàng, kiểm kê, đặt hàng, hao hụt, chuyển kho. Không đánh giá đúng giờ/trễ giờ — chỉ nêu bất thường thật sự.'
              : "Vue côté shops : réception, comptage, commande, pertes, transferts. Aucun jugement à l'heure/en retard — seules les vraies anomalies sont signalées."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link href="/admin/shop-process?date=yesterday"
            className={`p-2 rounded-lg border transition-colors ${which === 'yesterday' ? 'bg-navy text-white border-navy' : 'border-border-soft text-ink-light hover:text-navy'}`}>
            <ChevronLeft size={16} />
          </Link>
          <div className="px-3 py-2 rounded-lg text-sm font-semibold text-navy bg-cream/60 border border-border-soft capitalize min-w-[150px] text-center">
            {dateLabel}
          </div>
          <Link href="/admin/shop-process?date=today"
            className={`p-2 rounded-lg border transition-colors ${which === 'today' ? 'bg-navy text-white border-navy' : 'border-border-soft text-ink-light hover:text-navy'}`}>
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ backgroundColor: '#1A4731', color: '#FFFAEE' }}>
          <div className="font-bold text-sm">{vi ? 'Tổng hợp các cửa hàng' : 'Récap des shops'}</div>
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full"
            style={flagCount === 0 ? { backgroundColor: 'rgba(255,255,255,0.16)', color: '#B7F0C7' } : { backgroundColor: '#FFFAEE', color: AMBER }}>
            {flagCount === 0
              ? (vi ? 'Không có điểm cần xem' : 'Rien à signaler')
              : `${flagCount} ${vi ? 'điểm cần xem' : 'point(s) à regarder'}`}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 980, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="bg-cream/40">
                <th className="text-left px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-light" style={{ width: 148 }}>
                  {vi ? 'Cửa hàng' : 'Shop'}
                </th>
                <Th icon={Truck} label={vi ? 'Nhận hàng' : 'Réception'} width={168} />
                <Th icon={PackageCheck} label={vi ? 'Kiểm kê' : 'Comptage'} width={168} />
                <Th icon={ShoppingBag} label={vi ? 'Đặt hàng' : 'Commande'} />
                <Th icon={Trash2} label={vi ? 'Hao hụt' : 'Pertes'} width={128} />
                <Th icon={ArrowLeftRight} label={vi ? 'Chuyển kho' : 'Transferts'} />
              </tr>
            </thead>
            <tbody>
              {recaps.map((r, ri) => {
                const fullyConfirmed = !!r.reception && r.reception.confirmedLines === r.reception.totalLines;
                const qtyMismatch = fullyConfirmed && r.reception!.totalReceivedQty !== r.reception!.totalExpectedQty;
                return (
                <tr key={r.shop} style={{ backgroundColor: ri % 2 === 1 ? 'rgba(255,244,204,0.18)' : undefined }}>
                  <td className="px-4 py-3 font-bold text-navy text-[13px] whitespace-nowrap align-middle border-t border-border-soft">
                    {r.shop}
                  </td>

                  {/* Réception — status + a single qty-comparison line, no more per-line list */}
                  <Cell anomaly={qtyMismatch} missing={!!r.reception && !fullyConfirmed}>
                    {!r.reception ? <None vi={vi} label={vi ? 'Không có giao hàng' : 'Pas de livraison'} /> : (
                      <div className="space-y-1">
                        {r.reception.confirmedLines > 0 ? (
                          <div className="font-semibold text-[11.5px] text-ink truncate">
                            {fmtTime(r.reception.lastConfirmedAt)}
                            {r.reception.confirmedBy.length > 0 && <span className="text-ink-light font-medium"> · {r.reception.confirmedBy.join(', ')}</span>}
                          </div>
                        ) : (
                          <div className="font-semibold text-[11.5px]" style={{ color: RED }}>{vi ? 'Chưa xác nhận' : 'Non confirmé'}</div>
                        )}
                        <Ratio
                          a={r.reception.confirmedLines} b={r.reception.totalLines}
                          suffix={vi ? 'dòng' : 'lignes'} color={!fullyConfirmed ? RED : '#6B7280'} />
                        <Ratio
                          a={r.reception.totalReceivedQty} b={r.reception.totalExpectedQty}
                          suffix={vi ? 'sp nhận' : 'sp reçus'} color={qtyMismatch ? AMBER : '#6B7280'} warn={qtyMismatch} />
                      </div>
                    )}
                  </Cell>

                  {/* Comptage */}
                  <Cell missing={r.count == null}>
                    {!r.count ? <None vi={vi} label={vi ? 'Chưa kiểm kê' : 'Non compté'} bad /> : (
                      <div className="space-y-0.5">
                        <div className="font-semibold text-[11.5px] text-ink truncate">
                          {fmtTime(r.count.finishedAt)} <span className="text-ink-light font-medium">· {r.count.finishedBy}</span>
                        </div>
                        <div className="text-[11px] text-ink-light tabular-nums">
                          {r.count.skuCount} SKU · {fmtVnd(r.count.valuation)}
                          {r.count.sessionsCount > 1 && <span> · {r.count.sessionsCount} {vi ? 'lần' : 'passages'}</span>}
                        </div>
                      </div>
                    )}
                  </Cell>

                  {/* Commande */}
                  <Cell anomaly={r.orders.some(o => o.odooDirect)}>
                    {r.orders.length === 0 ? <None vi={vi} label={vi ? 'Không có đơn' : 'Aucune commande'} /> : (
                      <List items={r.orders} vi={vi} render={(o, i) => (
                        <div key={i} className="text-[11px] truncate">
                          {o.odooDirect ? (
                            <span className="font-semibold" style={{ color: AMBER }}>
                              {o.ref} · {vi ? 'tạo trực tiếp trên Odoo ⚠' : 'créée directement dans Odoo ⚠'}
                            </span>
                          ) : (
                            <span className="text-ink">
                              <span className="font-semibold">{fmtTime(o.placedAt)}</span>
                              <span className="text-ink-light"> · {o.placedBy} · {o.ref} · app</span>
                            </span>
                          )}
                        </div>
                      )} />
                    )}
                  </Cell>

                  {/* Pertes — one number, no more per-line list */}
                  <Cell>
                    {r.losses.totalQty === 0 ? <None vi={vi} label={vi ? 'Không có' : 'Aucune'} ok /> : (
                      <div>
                        <span className="font-bold text-[13px] tabular-nums" style={{ color: AMBER }}>{r.losses.totalQty}</span>
                        <span className="text-[11px] text-ink-light"> {vi ? 'sp hao hụt' : 'unités perdues'}</span>
                        <div className="text-[10.5px] text-ink-light">{r.losses.count} {vi ? 'lần báo cáo' : 'signalement(s)'}</div>
                      </div>
                    )}
                  </Cell>

                  {/* Transferts */}
                  <Cell>
                    {r.transfers.length === 0 ? <None vi={vi} label={vi ? 'Không có' : 'Aucun'} ok /> : (
                      <List items={r.transfers} vi={vi} render={(t, i) => (
                        <div key={i} className="text-[11px] text-ink truncate">
                          <span className="font-semibold">{fmtTime(t.at)}</span>
                          <span className="text-ink-light"> · {t.by} · </span>
                          {t.direction === 'out' ? '→' : '←'} {t.otherShop} · {t.units} u
                        </div>
                      )} />
                    )}
                  </Cell>
                </tr>
              );})}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-2.5 flex items-center gap-4 flex-wrap text-[11px] text-ink-light border-t border-border-soft">
          <Legend swatch="#6B7280" label={vi ? 'Đã làm, không có gì bất thường' : 'Fait, rien à signaler'} />
          <Legend swatch={AMBER} label={vi ? 'Lệch số lượng hoặc đặt hàng ngoài app' : 'Écart de quantité ou commande hors app'} />
          <Legend swatch={RED} label={vi ? 'Chưa làm' : 'Non fait'} />
        </div>
      </div>
    </div>
  );
}

function Th({ icon: Icon, label, width }: { icon: any; label: string; width?: number }) {
  return (
    <th className="text-left px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-light" style={width ? { width } : undefined}>
      <span className="inline-flex items-center gap-1"><Icon size={12} />{label}</span>
    </th>
  );
}

function Cell({ anomaly, missing, children }: { anomaly?: boolean; missing?: boolean; children: React.ReactNode }) {
  const style: React.CSSProperties = missing
    ? { borderLeft: `2.5px solid ${RED}`, backgroundColor: 'rgba(253,242,242,0.5)' }
    : anomaly
    ? { borderLeft: `2.5px solid ${AMBER}`, backgroundColor: 'rgba(255,251,235,0.5)' }
    : { borderLeft: '2.5px solid transparent' };
  return <td className="px-4 py-2.5 align-middle border-t border-border-soft" style={style}>{children}</td>;
}

// Compact "a/b unit" line shared by the two quantity comparisons in Réception -- replaces what
// used to be a per-line discrepancy list with one glance-able ratio.
function Ratio({ a, b, suffix, color, warn }: { a: number; b: number; suffix: string; color: string; warn?: boolean }) {
  return (
    <div className="text-[11px] tabular-nums" style={{ color }}>
      <span className={warn ? 'font-bold' : undefined}>{a}/{b}</span> {suffix}{warn ? ' ⚠' : ''}
    </div>
  );
}

// Caps a busy shop's list to MAX_ROWS_SHOWN lines + a plain "+N" so one loaded shop never
// stretches the whole table's row height for every other shop on the same line.
function List<T>({ items, render, vi }: { items: T[]; render: (item: T, i: number) => React.ReactNode; vi: boolean }) {
  const shown = items.slice(0, MAX_ROWS_SHOWN);
  const hidden = items.length - shown.length;
  return (
    <div className="space-y-1">
      {shown.map(render)}
      {hidden > 0 && (
        <div className="text-[10.5px] text-ink-light font-medium">+{hidden} {vi ? 'dòng khác' : 'autre(s)'}</div>
      )}
    </div>
  );
}

function None({ vi, label, bad, ok }: { vi: boolean; label: string; bad?: boolean; ok?: boolean }) {
  const color = bad ? RED : ok ? GREEN : '#B9B29A';
  return <span className={`text-[11px] ${bad ? 'font-semibold' : ok ? 'font-medium' : 'italic'}`} style={{ color }}>{label}</span>;
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: swatch }} />
      {label}
    </span>
  );
}
