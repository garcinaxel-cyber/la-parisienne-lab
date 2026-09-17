'use client';
import { useEffect, useMemo, useState } from 'react';
import { Loader2, CheckCircle2, Minus, Plus } from 'lucide-react';
import { thumb } from '@/lib/img-thumb';
import type { ShopTransfer, ShopLossForLabReception } from '@/app/shop/actions';

// "Chuyển kho Shop ↔ Lab" (Axel, 2026-09-16) — everything the Lab needs to receive back from the
// shops, grouped by DAY then by SHOP (own custom layout, not the shop-facing ShopTransfersTab
// anymore — that one is built for a shop sending+receiving, this one is Lab-side reception only,
// no send UI). Two sections: (1) real inter-shop stock transfers addressed to "Lab" (Lab is now
// just another transferEligible shop, see odoo-shop-transfer.ts), and (2) a purely in-app
// reception step for shop-declared losses/scrap (lab_shop_losses) physically sent back to the Lab
// — no Odoo call there at all, the scrap stays booked on the shop's own warehouse.
//
// Both lists are cut to "from today" (Axel: this reception step is brand new, an unbounded
// backlog would dump weeks of history on the Lab at once) -- losses are filtered server-side
// (getShopLossesForLabReceptionAction), transfers are filtered here since getMyShopTransfersAction
// is shared with the shop-facing feature and keeps its own (correct, for shops) wider window.
//
// Client-fetched (own useEffect calls into shop/actions.ts), not server-rendered from
// reception/page.tsx — keeps that page's existing props untouched, this tab is fully additive.

function vnDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
const todayVN = vnDay(new Date().toISOString());

function dayLabel(day: string, vi: boolean): string {
  const label = new Date(day + 'T12:00:00Z').toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Ho_Chi_Minh' });
  return day === todayVN ? `${label} · ${vi ? 'hôm nay' : "aujourd'hui"}` : label;
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}

// Groups a flat list into day -> shop -> items, days newest-first, shops alphabetical.
function groupByDayShop<T>(items: T[], dayOf: (t: T) => string, shopOf: (t: T) => string) {
  const byDay = new Map<string, Map<string, T[]>>();
  for (const it of items) {
    const d = dayOf(it), s = shopOf(it);
    if (!byDay.has(d)) byDay.set(d, new Map());
    const byShop = byDay.get(d)!;
    if (!byShop.has(s)) byShop.set(s, []);
    byShop.get(s)!.push(it);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, shopMap]) => ({
      day,
      shops: Array.from(shopMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([shop, items]) => ({ shop, items })),
    }));
}

const shortShop = (s: string) => s.replace(/^La Paris\s+/i, '');

export default function ShopLabReceptionTab({ vi }: { vi: boolean }) {
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <TransfersReception vi={vi} setZoomImage={setZoomImage} />
      <LossesReception vi={vi} setZoomImage={setZoomImage} />

      {zoomImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: 'rgba(0,0,0,0.8)' }} onClick={() => setZoomImage(null)}>
          <img src={thumb(zoomImage, 1200)} alt="" className="max-w-full max-h-full rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

// ── Section 1: stock transfers to Lab ────────────────────────────────────────────────────────
function TransfersReception({ vi, setZoomImage }: { vi: boolean; setZoomImage: (url: string | null) => void }) {
  const [transfers, setTransfers] = useState<ShopTransfer[] | null>(null);
  const [qtyDraft, setQtyDraft] = useState<Record<string, Record<string, string>>>({}); // transferId -> sku -> qty
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({}); // transferId -> note
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    const actions = await import('@/app/shop/actions');
    const res = await actions.getMyShopTransfersAction('Lab');
    setTransfers((res.transfers ?? []).filter(t => t.toShop === 'Lab' && vnDay(t.sentAt) >= todayVN));
  }
  useEffect(() => { load(); }, []);

  const pending = useMemo(() => (transfers ?? []).filter(t => t.status === 'sent'), [transfers]);
  const history = useMemo(() => (transfers ?? []).filter(t => t.status !== 'sent'), [transfers]);
  const pendingGrouped = useMemo(() => groupByDayShop(pending, t => vnDay(t.sentAt), t => t.fromShop), [pending]);
  const historyGrouped = useMemo(() => groupByDayShop(history, t => vnDay(t.sentAt), t => t.fromShop), [history]);

  function qtyFor(t: ShopTransfer, sku: string, fallback: number) {
    return qtyDraft[t.id]?.[sku] ?? String(fallback);
  }
  function setQty(t: ShopTransfer, sku: string, value: string) {
    setQtyDraft(p => ({ ...p, [t.id]: { ...(p[t.id] ?? {}), [sku]: value } }));
  }
  function hasDiff(t: ShopTransfer) {
    return t.lines.some(l => Math.max(0, Math.floor(Number(qtyFor(t, l.sku, l.qtySent)) || 0)) !== l.qtySent);
  }

  async function receive(t: ShopTransfer) {
    const note = (noteDraft[t.id] ?? '').trim();
    if (hasDiff(t) && !note) { setMsg(vi ? 'Số lượng khác — ghi rõ lý do' : 'Quantité différente — indique la raison'); return; }
    setBusyId(t.id); setMsg(null);
    const actions = await import('@/app/shop/actions');
    const res = await actions.receiveShopTransferAction({
      shopName: 'Lab', transferId: t.id,
      lines: t.lines.map(l => ({ sku: l.sku, qtyReceived: Math.max(0, Math.floor(Number(qtyFor(t, l.sku, l.qtySent)) || 0)) })),
      receiveNote: note || undefined,
    });
    setBusyId(null);
    if (res.error) { setMsg(res.error); return; }
    await load();
  }

  return (
    <div>
      <div className="text-sm font-bold text-navy mb-2">
        {vi ? '📦 Chuyển kho từ shop về Lab' : '📦 Transferts de stock des boutiques vers le Lab'}
      </div>
      <div className="bg-white rounded-2xl p-4 space-y-4" style={{ border: '1px solid #E5E7EB' }}>
        {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
        {!transfers ? (
          <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !pendingGrouped.length ? (
          <div className="text-center text-xs py-4" style={{ color: '#9CA3AF' }}>{vi ? 'Không có phiếu chuyển kho nào chờ nhận' : 'Aucun transfert en attente'}</div>
        ) : pendingGrouped.map(({ day, shops }) => (
          <div key={day}>
            <div className="text-xs font-bold uppercase tracking-wide mb-2 capitalize" style={{ color: '#6B7280' }}>{dayLabel(day, vi)}</div>
            <div className="space-y-3">
              {shops.map(({ shop, items }) => (
                <div key={shop}>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: '#92600A' }}>{shortShop(shop)}</div>
                  <div className="space-y-2">
                    {items.map(t => {
                      const diff = hasDiff(t);
                      return (
                        <div key={t.id} className="rounded-xl p-3 space-y-2" style={{ backgroundColor: '#FFFAEE', border: '1px solid #E0D49A' }}>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="text-sm font-bold text-navy">{t.ref}</div>
                            <div className="text-xs text-gray-500">
                              {t.odooPickingName ? `Odoo ${t.odooPickingName} · ` : ''}{t.sentByName ?? '—'} · {fmtTime(t.sentAt)}
                            </div>
                          </div>
                          {t.note && <div className="text-xs text-gray-500">📝 {t.note}</div>}
                          <div className="space-y-1.5">
                            {t.lines.map(l => {
                              const v = qtyFor(t, l.sku, l.qtySent);
                              const lineDiff = Math.max(0, Math.floor(Number(v) || 0)) !== l.qtySent;
                              return (
                                <div key={l.id} className="flex items-center gap-2">
                                  {l.imageUrl ? (
                                    <button type="button" onClick={() => setZoomImage(l.imageUrl!)} className="shrink-0 w-8 h-8 rounded overflow-hidden">
                                      <img src={thumb(l.imageUrl, 80)} alt="" className="w-full h-full object-cover" />
                                    </button>
                                  ) : <div className="shrink-0 w-8 h-8 rounded" style={{ backgroundColor: '#F3E8C8' }} />}
                                  <span className="text-sm flex-1 min-w-0 truncate">{l.name} <span className="text-xs text-gray-400">· {vi ? 'gửi' : 'envoyé'} {l.qtySent}</span></span>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button onClick={() => setQty(t, l.sku, String(Math.max(0, (Math.floor(Number(v) || 0)) - 1)))} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ border: '1px solid #E0D49A' }}><Minus size={11} /></button>
                                    <input type="number" value={v} min={0} onChange={e => setQty(t, l.sku, e.target.value)}
                                      className="w-12 text-center rounded-lg py-1 text-sm font-bold" style={{ border: '1px solid', borderColor: lineDiff ? '#F87171' : '#E0D49A' }} />
                                    <button onClick={() => setQty(t, l.sku, String((Math.floor(Number(v) || 0)) + 1))} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ border: '1px solid #E0D49A' }}><Plus size={11} /></button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {diff && (
                            <input type="text" value={noteDraft[t.id] ?? ''} onChange={e => setNoteDraft(p => ({ ...p, [t.id]: e.target.value }))}
                              placeholder={vi ? 'Lý do chênh lệch (bắt buộc)' : 'Raison de l’écart (obligatoire)'}
                              className="w-full text-xs rounded-lg px-2.5 py-1.5" style={{ border: '1px solid #F87171' }} />
                          )}
                          <button onClick={() => receive(t)} disabled={busyId === t.id}
                            className="w-full inline-flex items-center justify-center gap-1.5 text-xs font-bold rounded-lg px-3 py-2 text-white disabled:opacity-40"
                            style={{ backgroundColor: '#16A34A' }}>
                            {busyId === t.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                            {vi ? 'Xác nhận đã nhận' : 'Confirmer réception'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {historyGrouped.length > 0 && (
          <div className="pt-1 border-t" style={{ borderColor: '#F3F4F6' }}>
            <button onClick={() => setShowHistory(v => !v)} className="text-xs font-semibold text-gray-500 hover:text-navy mt-2">
              {showHistory ? (vi ? '▾ Ẩn lịch sử hôm nay' : '▾ Masquer l’historique du jour') : (vi ? '▸ Xem lịch sử hôm nay' : '▸ Voir l’historique du jour')} · {history.length}
            </button>
            {showHistory && (
              <div className="mt-2 space-y-3">
                {historyGrouped.map(({ day, shops }) => (
                  <div key={day}>
                    <div className="text-xs font-bold uppercase tracking-wide mb-1 capitalize" style={{ color: '#6B7280' }}>{dayLabel(day, vi)}</div>
                    {shops.map(({ shop, items }) => (
                      <div key={shop} className="mb-2">
                        <div className="text-xs font-semibold mb-1" style={{ color: '#92600A' }}>{shortShop(shop)}</div>
                        {items.map(t => (
                          <div key={t.id} className="text-xs text-gray-500 py-1">
                            {t.ref} — {t.status === 'received' ? (vi ? 'đã nhận' : 'reçu') : (vi ? 'đã huỷ' : 'annulé')} · {t.receivedByName ?? t.cancelledByName ?? '—'}
                            {t.receiveNote ? ` · ${t.receiveNote}` : ''}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section 2: shop-declared losses/scrap returns ────────────────────────────────────────────
function LossesReception({ vi, setZoomImage }: { vi: boolean; setZoomImage: (url: string | null) => void }) {
  const [losses, setLosses] = useState<ShopLossForLabReception[] | null>(null);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    const actions = await import('@/app/shop/actions');
    const res = await actions.getShopLossesForLabReceptionAction();
    setLosses(res.losses ?? []);
  }
  useEffect(() => { load(); }, []);

  const pending = useMemo(() => (losses ?? []).filter(l => !l.labReceivedAt), [losses]);
  const history = useMemo(() => (losses ?? []).filter(l => l.labReceivedAt), [losses]);
  const pendingGrouped = useMemo(() => groupByDayShop(pending, l => vnDay(l.reportedAt), l => l.shopName), [pending]);
  const historyGrouped = useMemo(() => groupByDayShop(history, l => vnDay(l.reportedAt), l => l.shopName), [history]);

  const qtyFor = (l: ShopLossForLabReception) => qtyDraft[l.id] ?? String(l.qty);

  async function receive(l: ShopLossForLabReception) {
    const qty = Math.max(0, Math.floor(Number(qtyFor(l)) || 0));
    const diff = qty !== l.qty;
    const note = (noteDraft[l.id] ?? '').trim();
    if (diff && !note) { setMsg(vi ? 'Số lượng khác — ghi rõ lý do' : 'Quantité différente — indique la raison'); return; }
    setBusyId(l.id); setMsg(null);
    const actions = await import('@/app/shop/actions');
    const res = await actions.receiveShopLossAction({ lossId: l.id, qtyReceived: qty, note: note || undefined });
    setBusyId(null);
    if (res.error) { setMsg(res.error); return; }
    await load();
  }

  return (
    <div>
      <div className="text-sm font-bold text-navy mb-2">
        {vi ? '🗑 Nhận lại hàng hao hụt từ shop (không ảnh hưởng Odoo)' : '🗑 Retours de pertes/scrap des boutiques (aucune incidence Odoo)'}
      </div>
      <div className="bg-white rounded-2xl p-4 space-y-4" style={{ border: '1px solid #E5E7EB' }}>
        {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
        {!losses ? (
          <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !pendingGrouped.length ? (
          <div className="text-center text-xs py-4" style={{ color: '#9CA3AF' }}>{vi ? 'Không có hàng hao hụt nào chờ nhận' : 'Aucun retour de perte en attente'}</div>
        ) : pendingGrouped.map(({ day, shops }) => (
          <div key={day}>
            <div className="flex items-center gap-1.5 mb-2">
              <div className="text-xs font-bold uppercase tracking-wide capitalize" style={{ color: '#6B7280' }}>{dayLabel(day, vi)}</div>
              {/* Axel, 2026-09-17: pending losses are no longer cut to "from today" (a forgotten
                  one must stay visible however old) — flag any day that isn't today so an old,
                  easy-to-miss backlog reads as overdue rather than as an ordinary day group. */}
              {day !== todayVN && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: '#B45309', backgroundColor: '#FEF3C7' }}>
                  {vi ? '⚠ quá hạn' : '⚠ en retard'}
                </span>
              )}
            </div>
            <div className="space-y-3">
              {shops.map(({ shop, items }) => (
                <div key={shop}>
                  <div className="text-xs font-semibold mb-1.5" style={{ color: '#92600A' }}>{shortShop(shop)}</div>
                  <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
                    {items.map(l => {
                      const qty = qtyFor(l);
                      const diff = Math.max(0, Math.floor(Number(qty) || 0)) !== l.qty;
                      return (
                        <div key={l.id} className="py-2.5 space-y-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="text-sm font-semibold text-navy">{l.productName} <span className="text-xs font-normal text-gray-500">· {l.reasonTagName}</span></div>
                            <div className="text-xs text-gray-400">{l.reportedByName} · {fmtTime(l.reportedAt)}</div>
                          </div>
                          {l.note && <div className="text-xs text-gray-500">📝 {l.note}</div>}
                          {l.followUpNote && (
                            <div className="text-xs" style={{ color: '#92600A' }}>
                              🗒️ {vi ? 'Shop cập nhật' : 'Note boutique'}: {l.followUpNote}
                            </div>
                          )}
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-gray-500">{vi ? 'Đã báo' : 'Déclaré'}: ×{l.qty}</span>
                            <input type="number" value={qty} min={0}
                              onChange={e => setQtyDraft(p => ({ ...p, [l.id]: e.target.value }))}
                              className="w-16 text-center rounded-lg px-2 py-1 text-sm font-bold"
                              style={{ border: '1px solid', borderColor: diff ? '#F87171' : '#D1D5DB' }} />
                            {diff && (
                              <input type="text" value={noteDraft[l.id] ?? ''} onChange={e => setNoteDraft(p => ({ ...p, [l.id]: e.target.value }))}
                                placeholder={vi ? 'Lý do chênh lệch (bắt buộc)' : 'Raison de l’écart (obligatoire)'}
                                className="flex-1 min-w-[10rem] text-xs rounded-lg px-2.5 py-1.5" style={{ border: '1px solid #F87171' }} />
                            )}
                            <button onClick={() => receive(l)} disabled={busyId === l.id}
                              className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 text-white disabled:opacity-40"
                              style={{ backgroundColor: '#16A34A' }}>
                              {busyId === l.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                              {vi ? 'Xác nhận đã nhận' : 'Confirmer réception'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {historyGrouped.length > 0 && (
          <div className="pt-1 border-t" style={{ borderColor: '#F3F4F6' }}>
            {/* Axel, 2026-09-17: this used to say "hôm nay"/"du jour" (today only) because the
                underlying query was hard-cut to today — now a rolling 30-day window (see
                getShopLossesForLabReceptionAction), so the label no longer claims "today". */}
            <button onClick={() => setShowHistory(v => !v)} className="text-xs font-semibold text-gray-500 hover:text-navy mt-2">
              {showHistory ? (vi ? '▾ Ẩn lịch sử (30 ngày qua)' : '▾ Masquer l’historique (30 derniers jours)') : (vi ? '▸ Xem lịch sử (30 ngày qua)' : '▸ Voir l’historique (30 derniers jours)')} · {history.length}
            </button>
            {showHistory && (
              <div className="mt-2 space-y-3">
                {historyGrouped.map(({ day, shops }) => (
                  <div key={day}>
                    <div className="text-xs font-bold uppercase tracking-wide mb-1 capitalize" style={{ color: '#6B7280' }}>{dayLabel(day, vi)}</div>
                    {shops.map(({ shop, items }) => (
                      <div key={shop} className="mb-2">
                        <div className="text-xs font-semibold mb-1" style={{ color: '#92600A' }}>{shortShop(shop)}</div>
                        {items.map(l => {
                          const diff = (l.labReceivedQty ?? 0) - l.qty;
                          return (
                            <div key={l.id} className="text-xs text-gray-500 py-1">
                              {l.productName}: {vi ? 'báo' : 'déclaré'} ×{l.qty} → {vi ? 'nhận' : 'reçu'} ×{l.labReceivedQty}
                              {diff !== 0 && <span className="font-bold ml-1" style={{ color: '#DC2626' }}>({diff > 0 ? '+' : ''}{diff}{l.labReceiveNote ? ` · ${l.labReceiveNote}` : ''})</span>}
                              {' · '}{l.labReceivedByName} · {l.labReceivedAt ? fmtTime(l.labReceivedAt) : '—'}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
