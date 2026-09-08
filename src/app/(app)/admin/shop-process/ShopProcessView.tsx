'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, ChevronLeft, ChevronRight, Truck, PackageCheck, ShoppingBag, Trash2, ArrowLeftRight } from 'lucide-react';

export type ShopRecap = {
  shop: string;
  reception: {
    totalLines: number; confirmedLines: number; lastConfirmedAt: string | null; confirmedBy: string[];
    discrepancies: { sku: string | null; product: string; expected: number; received: number }[];
  } | null;
  count: { sessionsCount: number; finishedAt: string; finishedBy: string; skuCount: number; valuation: number } | null;
  orders: { ref: string; placedAt: string | null; placedBy: string | null; odooDirect: boolean }[];
  losses: { sku: string | null; product: string | null; qty: number; reason: string | null; by: string; at: string }[];
  transfers: { direction: 'in' | 'out'; otherShop: string; ref: string; status: string; by: string; at: string; units: number }[];
};

const AMBER = '#B45309';
const RED = '#B42318';

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}
function fmtVnd(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫';
}

// Loss/transfer lists can grow long on a busy day and would otherwise stretch the whole row —
// cap what's shown inline and fold the rest behind a plain count, matching the "synthétique"
// brief (Axel: "un ecran assez synthetique... une vue global directement").
const MAX_ROWS_SHOWN = 3;

export default function ShopProcessView({ date, which, recaps }: { date: string; which: 'today' | 'yesterday'; recaps: ShopRecap[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const dateLabel = new Date(`${date}T12:00:00+07:00`).toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', {
    weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
  });

  // Every red/amber border rendered below funnels into this one number — kept in lockstep with
  // the Cell flags so the header total never quietly under-counts what the table is showing.
  const flagCount = recaps.reduce((n, r) => {
    let f = 0;
    if (r.reception && r.reception.confirmedLines < r.reception.totalLines) f++;
    if (r.reception?.discrepancies.length) f++;
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
          <table className="w-full text-sm" style={{ minWidth: 1080, tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            <thead>
              <tr className="bg-cream/40">
                <th className="text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-ink-light" style={{ width: 150 }}>
                  {vi ? 'Cửa hàng' : 'Shop'}
                </th>
                <Th icon={Truck} label={vi ? 'Nhận hàng' : 'Réception'} />
                <Th icon={PackageCheck} label={vi ? 'Kiểm kê' : 'Comptage'} />
                <Th icon={ShoppingBag} label={vi ? 'Đặt hàng' : 'Commande'} />
                <Th icon={Trash2} label={vi ? 'Hao hụt' : 'Pertes'} />
                <Th icon={ArrowLeftRight} label={vi ? 'Chuyển kho' : 'Transferts'} />
              </tr>
            </thead>
            <tbody>
              {recaps.map((r, ri) => (
                <tr key={r.shop} style={{ backgroundColor: ri % 2 === 1 ? 'rgba(255,244,204,0.18)' : undefined }}>
                  <td className="px-4 py-3.5 font-bold text-navy text-[13px] whitespace-nowrap align-middle border-t border-border-soft">
                    {r.shop}
                  </td>

                  {/* Réception */}
                  <Cell anomaly={!!r.reception?.discrepancies.length} missing={!!r.reception && r.reception.confirmedLines < r.reception.totalLines}>
                    {!r.reception ? <None vi={vi} label={vi ? 'Không có giao hàng' : 'Pas de livraison'} /> : (
                      <div className="space-y-1">
                        {r.reception.confirmedLines > 0 ? (
                          <div className="font-semibold text-[11.5px] text-ink">
                            {fmtTime(r.reception.lastConfirmedAt)}
                            {r.reception.confirmedBy.length > 0 && <span className="text-ink-light font-medium"> · {r.reception.confirmedBy.join(', ')}</span>}
                          </div>
                        ) : (
                          <div className="font-semibold text-[11.5px]" style={{ color: RED }}>{vi ? 'Chưa xác nhận' : 'Non confirmé'}</div>
                        )}
                        <div className="text-[11px] tabular-nums" style={{ color: r.reception.confirmedLines < r.reception.totalLines ? RED : '#6B7280' }}>
                          {r.reception.confirmedLines}/{r.reception.totalLines} {vi ? 'dòng đã xác nhận' : 'lignes confirmées'}
                        </div>
                        <List items={r.reception.discrepancies} vi={vi} render={(d, i) => (
                          <div key={i} className="text-[11px] font-semibold" style={{ color: AMBER }}>
                            {d.sku ? `${d.sku} — ` : ''}{d.product}: {d.received}/{d.expected} {vi ? 'nhận' : 'reçu'} ⚠
                          </div>
                        )} />
                      </div>
                    )}
                  </Cell>

                  {/* Comptage */}
                  <Cell missing={r.count == null}>
                    {!r.count ? <None vi={vi} label={vi ? 'Chưa kiểm kê' : 'Non compté'} bad /> : (
                      <div className="space-y-0.5">
                        <div className="font-semibold text-[11.5px] text-ink">
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
                        <div key={i} className="text-[11px]">
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

                  {/* Pertes */}
                  <Cell>
                    {r.losses.length === 0 ? <None vi={vi} label={vi ? 'Không có' : 'Aucune'} ok /> : (
                      <List items={r.losses} vi={vi} render={(l, i) => (
                        <div key={i} className="text-[11px] text-ink">
                          <span className="font-semibold">{fmtTime(l.at)}</span>
                          <span className="text-ink-light"> · {l.by} · </span>
                          {l.sku ? `${l.sku} — ` : ''}{l.product ?? ''} ×{l.qty}
                          {l.reason && <span className="text-ink-light"> ({l.reason})</span>}
                        </div>
                      )} />
                    )}
                  </Cell>

                  {/* Transferts */}
                  <Cell>
                    {r.transfers.length === 0 ? <None vi={vi} label={vi ? 'Không có' : 'Aucun'} ok /> : (
                      <List items={r.transfers} vi={vi} render={(t, i) => (
                        <div key={i} className="text-[11px] text-ink">
                          <span className="font-semibold">{fmtTime(t.at)}</span>
                          <span className="text-ink-light"> · {t.by} · </span>
                          {t.direction === 'out' ? '→' : '←'} {t.otherShop} · {t.units} u
                        </div>
                      )} />
                    )}
                  </Cell>
                </tr>
              ))}
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

function Th({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <th className="text-left px-4 py-2.5 text-[10px] font-bold uppercase tracking-wider text-ink-light">
      <span className="inline-flex items-center gap-1"><Icon size={12} />{label}</span>
    </th>
  );
}

function Cell({ anomaly, missing, children }: { anomaly?: boolean; missing?: boolean; children: React.ReactNode }) {
  const style: React.CSSProperties = missing
    ? { borderLeft: `3px solid ${RED}`, backgroundColor: 'rgba(253,242,242,0.55)' }
    : anomaly
    ? { borderLeft: `3px solid ${AMBER}`, backgroundColor: 'rgba(255,251,235,0.55)' }
    : { borderLeft: '3px solid transparent' };
  return <td className="px-4 py-3.5 align-middle border-t border-border-soft" style={style}>{children}</td>;
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
        <div className="text-[11px] text-ink-light font-medium">+{hidden} {vi ? 'dòng khác' : 'autre(s)'}</div>
      )}
    </div>
  );
}

function None({ vi, label, bad, ok }: { vi: boolean; label: string; bad?: boolean; ok?: boolean }) {
  const color = bad ? RED : ok ? '#6B7280' : '#B9B29A';
  return <span className={`text-[11px] ${bad ? 'font-semibold' : 'italic'}`} style={{ color }}>{label}</span>;
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: swatch }} />
      {label}
    </span>
  );
}
