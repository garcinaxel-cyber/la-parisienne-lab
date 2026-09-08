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

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}
function fmtVnd(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫';
}

export default function ShopProcessView({ date, which, recaps }: { date: string; which: 'today' | 'yesterday'; recaps: ShopRecap[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';

  const dateLabel = new Date(`${date}T12:00:00+07:00`).toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', {
    weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
  });

  const flagCount = recaps.reduce((n, r) => {
    let f = 0;
    if (r.reception && r.reception.confirmedLines < r.reception.totalLines) f++;
    if (r.reception?.discrepancies.length) f++;
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
            className={`p-2 rounded-lg border ${which === 'yesterday' ? 'bg-navy text-white border-navy' : 'border-border-soft text-ink-light hover:text-navy'}`}>
            <ChevronLeft size={16} />
          </Link>
          <div className="px-3 py-2 rounded-lg text-sm font-semibold text-navy bg-cream/60 border border-border-soft capitalize">
            {dateLabel}
          </div>
          <Link href="/admin/shop-process?date=today"
            className={`p-2 rounded-lg border ${which === 'today' ? 'bg-navy text-white border-navy' : 'border-border-soft text-ink-light hover:text-navy'}`}>
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ backgroundColor: '#1A4731', color: '#FFFAEE' }}>
          <div className="font-bold text-sm">{vi ? 'Tổng hợp các cửa hàng' : 'Récap des shops'}</div>
          <div className="text-xs opacity-90">
            {flagCount === 0
              ? (vi ? 'Không có điểm cần xem' : 'Rien à signaler')
              : `${flagCount} ${vi ? 'điểm cần xem' : 'point(s) à regarder'}`}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 1080, tableLayout: 'fixed' }}>
            <thead>
              <tr className="bg-cream/40">
                <th className="text-left px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-light" style={{ width: 140 }}>
                  {vi ? 'Cửa hàng' : 'Shop'}
                </th>
                <Th icon={Truck} label={vi ? 'Nhận hàng' : 'Réception'} />
                <Th icon={PackageCheck} label={vi ? 'Kiểm kê' : 'Comptage'} />
                <Th icon={ShoppingBag} label={vi ? 'Đặt hàng' : 'Commande'} />
                <Th icon={Trash2} label={vi ? 'Hao hụt' : 'Pertes'} />
                <Th icon={ArrowLeftRight} label={vi ? 'Chuyển kho' : 'Transferts'} />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-soft">
              {recaps.map(r => (
                <tr key={r.shop} className="align-top">
                  <td className="px-4 py-3 font-bold text-navy text-[13px] whitespace-nowrap">{r.shop}</td>

                  {/* Réception */}
                  <Cell anomaly={!!r.reception?.discrepancies.length} missing={!!r.reception && r.reception.confirmedLines < r.reception.totalLines}>
                    {!r.reception ? <None vi={vi} /> : (
                      <div className="space-y-1">
                        <div className="font-semibold text-[11.5px] text-ink">
                          {fmtTime(r.reception.lastConfirmedAt)}
                          {r.reception.confirmedBy.length > 0 && <span className="text-ink-light font-medium"> · {r.reception.confirmedBy.join(', ')}</span>}
                        </div>
                        <div className="text-[11px] text-ink-light">
                          {r.reception.confirmedLines}/{r.reception.totalLines} {vi ? 'dòng đã xác nhận' : 'lignes confirmées'}
                        </div>
                        {r.reception.discrepancies.map((d, i) => (
                          <div key={i} className="text-[11px] font-semibold" style={{ color: '#B45309' }}>
                            {d.sku ? `${d.sku} — ` : ''}{d.product}: {d.received}/{d.expected} {vi ? 'nhận' : 'reçu'} ⚠
                          </div>
                        ))}
                      </div>
                    )}
                  </Cell>

                  {/* Comptage */}
                  <Cell missing={r.count == null}>
                    {!r.count ? <None vi={vi} /> : (
                      <div className="space-y-0.5">
                        <div className="font-semibold text-[11.5px] text-ink">
                          {fmtTime(r.count.finishedAt)} <span className="text-ink-light font-medium">· {r.count.finishedBy}</span>
                        </div>
                        <div className="text-[11px] text-ink-light">
                          {r.count.skuCount} SKU · {fmtVnd(r.count.valuation)}
                          {r.count.sessionsCount > 1 && <span> · {r.count.sessionsCount} {vi ? 'lần' : 'passages'}</span>}
                        </div>
                      </div>
                    )}
                  </Cell>

                  {/* Commande */}
                  <Cell anomaly={r.orders.some(o => o.odooDirect)}>
                    {r.orders.length === 0 ? <None vi={vi} /> : (
                      <div className="space-y-1">
                        {r.orders.map((o, i) => (
                          <div key={i} className="text-[11px]">
                            {o.odooDirect ? (
                              <span className="font-semibold" style={{ color: '#B45309' }}>
                                {o.ref} · {vi ? 'tạo trực tiếp trên Odoo ⚠' : 'créée directement dans Odoo ⚠'}
                              </span>
                            ) : (
                              <span className="text-ink">
                                <span className="font-semibold">{fmtTime(o.placedAt)}</span>
                                <span className="text-ink-light"> · {o.placedBy} · {o.ref} · app</span>
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Cell>

                  {/* Pertes */}
                  <Cell>
                    {r.losses.length === 0 ? <None vi={vi} label={vi ? 'không có' : 'aucune'} /> : (
                      <div className="space-y-1">
                        {r.losses.map((l, i) => (
                          <div key={i} className="text-[11px] text-ink">
                            <span className="font-semibold">{fmtTime(l.at)}</span>
                            <span className="text-ink-light"> · {l.by} · </span>
                            {l.sku ? `${l.sku} — ` : ''}{l.product ?? ''} ×{l.qty}
                            {l.reason && <span className="text-ink-light"> ({l.reason})</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </Cell>

                  {/* Transferts */}
                  <Cell>
                    {r.transfers.length === 0 ? <None vi={vi} label={vi ? 'không có' : 'aucun'} /> : (
                      <div className="space-y-1">
                        {r.transfers.map((t, i) => (
                          <div key={i} className="text-[11px] text-ink">
                            <span className="font-semibold">{fmtTime(t.at)}</span>
                            <span className="text-ink-light"> · {t.by} · </span>
                            {t.direction === 'out' ? '→' : '←'} {t.otherShop} · {t.units} u
                          </div>
                        ))}
                      </div>
                    )}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-2.5 flex items-center gap-4 flex-wrap text-[11px] text-ink-light border-t border-border-soft">
          <Legend swatch="#6B7280" label={vi ? 'Đã làm, không có gì bất thường' : 'Fait, rien à signaler'} />
          <Legend swatch="#B45309" label={vi ? 'Lệch số lượng hoặc đặt hàng ngoài app' : 'Écart de quantité ou commande hors app'} />
          <Legend swatch="#B42318" label={vi ? 'Chưa làm' : 'Non fait'} />
        </div>
      </div>
    </div>
  );
}

function Th({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <th className="text-left px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-ink-light">
      <span className="inline-flex items-center gap-1"><Icon size={12} />{label}</span>
    </th>
  );
}

function Cell({ anomaly, missing, children }: { anomaly?: boolean; missing?: boolean; children: React.ReactNode }) {
  const style = missing
    ? { borderLeft: '3px solid #B42318', backgroundColor: 'rgba(253,242,242,0.6)' }
    : anomaly
    ? { borderLeft: '3px solid #B45309', backgroundColor: 'rgba(255,251,235,0.6)' }
    : { borderLeft: '3px solid transparent' };
  return <td className="px-4 py-3" style={style}>{children}</td>;
}

function None({ vi, label }: { vi: boolean; label?: string }) {
  return <span className="text-[11px] italic" style={{ color: '#B9B29A' }}>{label ?? (vi ? 'không có dữ liệu' : 'aucune donnée')}</span>;
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: swatch }} />
      {label}
    </span>
  );
}
