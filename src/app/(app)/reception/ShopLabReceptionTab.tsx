'use client';
import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { thumb } from '@/lib/img-thumb';
import ShopTransfersTab from '@/app/shop/ShopTransfersTab';
import type { ShopStaffName, ShopTransfer, ShopLossForLabReception } from '@/app/shop/actions';

// "Chuyển kho Shop ↔ Lab" (Axel, 2026-09-16) — everything the Lab needs to receive back from the
// shops, in one place: (1) real inter-shop stock transfers addressed to "Lab" (reuses the shop's
// own ShopTransfersTab wholesale — Lab is now just another transferEligible shop, see
// odoo-shop-transfer.ts — so sending/receiving/history/discrepancy-reason all come for free), and
// (2) a purely in-app reception step for shop-declared losses/scrap (lab_shop_losses): those
// products are physically sent back to the Lab even though the Odoo scrap stays booked on the
// shop's own warehouse (recordShopLossAction, unchanged) — so this reception has NO Odoo call at
// all, it only records that the Lab actually got them, and how many.
//
// Client-fetched (own useEffect calls into shop/actions.ts), not server-rendered from
// reception/page.tsx — keeps that page's existing props untouched, this tab is fully additive.

const RECEIVER_NAME_KEY = 'lab_reception_shoplab_receiver_name';

function fmtDT(iso: string, vi: boolean): string {
  const d = new Date(iso);
  return d.toLocaleString(vi ? 'vi-VN' : 'fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}

export default function ShopLabReceptionTab({ vi }: { vi: boolean }) {
  const [staffNames, setStaffNames] = useState<ShopStaffName[] | null>(null);
  const [transfers, setTransfers] = useState<ShopTransfer[] | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  async function loadTransfers() {
    const actions = await import('@/app/shop/actions');
    const res = await actions.getMyShopTransfersAction('Lab');
    setTransfers(res.transfers ?? []);
  }
  useEffect(() => {
    (async () => {
      const actions = await import('@/app/shop/actions');
      const [s] = await Promise.all([actions.getShopStaffNamesAction('Lab'), loadTransfers()]);
      setStaffNames(s.names ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onManageStaff() {
    const name = window.prompt(vi ? 'Tên nhân viên Lab mới:' : 'Nom du nouvel employé Lab :');
    if (!name?.trim()) return;
    const actions = await import('@/app/shop/actions');
    await actions.addShopStaffNameAction(name.trim(), 'Lab');
    const res = await actions.getShopStaffNamesAction('Lab');
    setStaffNames(res.names ?? []);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-bold text-navy mb-2">
          {vi ? '📦 Chuyển kho từ shop về Lab' : '📦 Transferts de stock des boutiques vers le Lab'}
        </div>
        <ShopTransfersTab shopName="Lab" readOnly staffNames={staffNames} onManageStaff={onManageStaff}
          setZoomImage={setZoomImage} transfers={transfers} reload={loadTransfers} />
      </div>

      <LossesReception vi={vi} setZoomImage={setZoomImage} />

      {zoomImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ backgroundColor: 'rgba(0,0,0,0.8)' }} onClick={() => setZoomImage(null)}>
          <img src={thumb(zoomImage, 1200)} alt="" className="max-w-full max-h-full rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}

function LossesReception({ vi, setZoomImage }: { vi: boolean; setZoomImage: (url: string | null) => void }) {
  const [losses, setLosses] = useState<ShopLossForLabReception[] | null>(null);
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [receiverName, setReceiverName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  async function load() {
    const actions = await import('@/app/shop/actions');
    const res = await actions.getShopLossesForLabReceptionAction();
    setLosses(res.losses ?? []);
  }
  useEffect(() => {
    try { setReceiverName(localStorage.getItem(RECEIVER_NAME_KEY) ?? ''); } catch { /* ignore */ }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { try { if (receiverName) localStorage.setItem(RECEIVER_NAME_KEY, receiverName); } catch { /* ignore */ } }, [receiverName]);

  const pending = (losses ?? []).filter(l => !l.labReceivedAt);
  const history = (losses ?? []).filter(l => l.labReceivedAt);

  const qtyFor = (l: ShopLossForLabReception) => qtyDraft[l.id] ?? String(l.qty);

  async function receive(l: ShopLossForLabReception) {
    const qty = Math.max(0, Math.floor(Number(qtyFor(l)) || 0));
    const diff = qty !== l.qty;
    const note = (noteDraft[l.id] ?? '').trim();
    if (!receiverName.trim()) { setMsg(vi ? 'Chọn tên người nhận' : 'Indique ton nom'); return; }
    if (diff && !note) { setMsg(vi ? 'Số lượng khác — ghi rõ lý do' : 'Quantité différente — indique la raison'); return; }
    setBusyId(l.id); setMsg(null);
    const actions = await import('@/app/shop/actions');
    const res = await actions.receiveShopLossAction({ lossId: l.id, qtyReceived: qty, receivedByName: receiverName.trim(), note: note || undefined });
    setBusyId(null);
    if (res.error) { setMsg(res.error); return; }
    await load();
  }

  return (
    <div>
      <div className="text-sm font-bold text-navy mb-2">
        {vi ? '🗑 Nhận lại hàng hao hụt từ shop (không ảnh hưởng Odoo)' : '🗑 Retours de pertes/scrap des boutiques (aucune incidence Odoo)'}
      </div>
      <div className="bg-white rounded-2xl p-4 space-y-3" style={{ border: '1px solid #E5E7EB' }}>
        <div>
          <label className="text-xs font-semibold text-gray-600 block mb-1">{vi ? 'Tên người nhận (Lab)' : 'Nom du réceptionnaire (Lab)'}</label>
          <input type="text" value={receiverName} onChange={e => setReceiverName(e.target.value)}
            placeholder={vi ? 'Tên của bạn' : 'Ton nom'} className="w-full text-sm rounded-lg px-3 py-2" style={{ border: '1px solid #E5E7EB' }} />
        </div>

        {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}

        {!losses ? (
          <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !pending.length ? (
          <div className="text-center text-xs py-4" style={{ color: '#9CA3AF' }}>
            {vi ? 'Không có hàng hao hụt nào chờ nhận' : 'Aucun retour de perte en attente'}
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: '#F3F4F6' }}>
            {pending.map(l => {
              const qty = qtyFor(l);
              const diff = Math.max(0, Math.floor(Number(qty) || 0)) !== l.qty;
              return (
                <div key={l.id} className="py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="text-sm font-semibold text-navy">
                      {l.productName} <span className="text-xs font-normal text-gray-500">· {l.shopName} · {l.reasonTagName}</span>
                    </div>
                    <div className="text-xs text-gray-400">
                      {vi ? 'Báo bởi' : 'Déclaré par'} {l.reportedByName} · {fmtDT(l.reportedAt, vi)}
                    </div>
                  </div>
                  {l.note && <div className="text-xs text-gray-500">📝 {l.note}</div>}
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
        )}

        {history.length > 0 && (
          <div className="pt-1">
            <button onClick={() => setShowHistory(v => !v)} className="text-xs font-semibold text-gray-500 hover:text-navy">
              {showHistory ? (vi ? '▾ Ẩn lịch sử' : '▾ Masquer l’historique') : (vi ? '▸ Xem lịch sử' : '▸ Voir l’historique')} · {history.length}
            </button>
            {showHistory && (
              <div className="mt-2 divide-y" style={{ borderColor: '#F3F4F6' }}>
                {history.map(l => {
                  const diff = (l.labReceivedQty ?? 0) - l.qty;
                  return (
                    <div key={l.id} className="py-2 text-xs text-gray-500 flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-navy font-semibold">{l.productName} <span className="font-normal text-gray-500">· {l.shopName}</span></span>
                      <span>
                        {vi ? 'Báo' : 'Déclaré'} ×{l.qty} → {vi ? 'Nhận' : 'Reçu'} ×{l.labReceivedQty}
                        {diff !== 0 && <span className="font-bold ml-1" style={{ color: '#DC2626' }}>({diff > 0 ? '+' : ''}{diff}{l.labReceiveNote ? ` · ${l.labReceiveNote}` : ''})</span>}
                        {' · '}{l.labReceivedByName} · {l.labReceivedAt ? fmtDT(l.labReceivedAt, vi) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
