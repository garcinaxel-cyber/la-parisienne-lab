'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { PackageCheck, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

type Line = {
  id: string; product_name_vi: string; product_name_en: string | null;
  sku: string | null; variant_label: string | null; image_url: string | null;
  qty_sent: number; qty_received: number | null;
};
type Bon = { id: string; team: string; created_by_name: string | null; created_at: string; lines: Line[] };

const REASONS = [
  { v: 'casse', vi: 'Vỡ / hỏng', en: 'Broken / damaged' },
  { v: 'miscount', vi: 'Đếm sai', en: 'Miscount' },
  { v: 'missing', vi: 'Thiếu hàng', en: 'Missing' },
  { v: 'other', vi: 'Khác', en: 'Other' },
];

export default function ReceptionView({ bons }: { bons: Bon[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [state, setState] = useState<Record<string, { qty: string; reason: string; note: string }>>(() => {
    const s: Record<string, { qty: string; reason: string; note: string }> = {};
    for (const b of bons) for (const l of b.lines) s[l.id] = { qty: String(l.qty_received ?? l.qty_sent), reason: '', note: '' };
    return s;
  });
  // Lines already received (locked). Seeded from server data, grows as we validate line by line.
  const [received, setReceived] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const b of bons) for (const l of b.lines) if (l.qty_received != null) s.add(l.id);
    return s;
  });
  const [savingLine, setSavingLine] = useState<string | null>(null);
  const [savingBon, setSavingBon] = useState<string | null>(null);
  const [doneBons, setDoneBons] = useState<Set<string>>(new Set());

  const upd = (id: string, patch: Partial<{ qty: string; reason: string; note: string }>) =>
    setState(p => ({ ...p, [id]: { ...p[id], ...patch } }));

  // Validate a single line
  async function receiveLine(bon: Bon, l: Line) {
    const st = state[l.id]; const qty = Number(st?.qty);
    if (qty !== l.qty_sent && !st?.reason) return; // reason required on discrepancy
    setSavingLine(l.id);
    const { receiveTransferLineAction } = await import('./actions');
    const res = await receiveTransferLineAction(bon.id, l.id, qty, st?.reason || null, st?.note || null);
    setSavingLine(null);
    if (res.ok) {
      setReceived(p => new Set(p).add(l.id));
      if (res.closed) setDoneBons(p => new Set(p).add(bon.id));
    }
  }

  // Validate every remaining line of the note at once
  async function receiveAll(bon: Bon) {
    const remaining = bon.lines.filter(l => !received.has(l.id));
    const blocked = remaining.some(l => Number(state[l.id]?.qty) !== l.qty_sent && !state[l.id]?.reason);
    if (blocked) return;
    setSavingBon(bon.id);
    const { receiveStockTransferAction } = await import('./actions');
    const res = await receiveStockTransferAction(bon.id, remaining.map(l => ({
      lineId: l.id, qtyReceived: Number(state[l.id]?.qty ?? l.qty_sent),
      reason: state[l.id]?.reason || null, note: state[l.id]?.note || null,
    })));
    setSavingBon(null);
    if (res.ok) setDoneBons(p => new Set(p).add(bon.id));
  }

  const visible = bons.filter(b => !doneBons.has(b.id));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <PackageCheck size={24} /> {vi ? 'Nhập kho' : 'Stock reception'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi ? 'Xác nhận số lượng nhận — từng sản phẩm hoặc cả phiếu.' : 'Confirm received quantities — product by product, or the whole note.'}
          </p>
        </div>
        {visible.length > 0 && (
          <span className="text-xs font-semibold rounded-full px-3 py-1.5 inline-flex items-center gap-1.5"
            style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
            <Clock size={13} /> {visible.length} {vi ? 'phiếu chờ' : (visible.length > 1 ? 'notes waiting' : 'note waiting')}
          </span>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="card p-10 text-center">
          <PackageCheck size={44} className="mx-auto mb-3 text-green-600" />
          <p className="font-semibold text-navy">{vi ? 'Không có phiếu chờ nhận 🎉' : 'No transfer waiting 🎉'}</p>
          <p className="text-sm text-ink-light mt-1">{vi ? 'Các phiếu mới sẽ hiện ở đây.' : 'New transfer notes will appear here.'}</p>
        </div>
      ) : (
        visible.map(bon => {
          const meta = TEAM_LABELS[bon.team as Team];
          const time = new Date(bon.created_at).toLocaleString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          const remaining = bon.lines.filter(l => !received.has(l.id));
          const discrepancies = bon.lines.filter(l => Number(state[l.id]?.qty) !== l.qty_sent).length;
          const blockedAll = remaining.some(l => Number(state[l.id]?.qty) !== l.qty_sent && !state[l.id]?.reason);
          return (
            <div key={bon.id} className="card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3" style={{ backgroundColor: '#F9FAFB' }}>
                <div className="text-sm font-semibold text-navy">
                  {vi ? 'Phiếu' : 'Note'} #{bon.id.slice(0, 6).toUpperCase()}
                  <span className="text-ink-light font-normal"> · {bon.created_by_name ?? '—'} · {meta ? (vi ? meta.vi : meta.en) : bon.team} · {time}</span>
                </div>
                <span className="text-[11px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                  {received.size > 0 && remaining.length > 0 && remaining.length < bon.lines.length
                    ? `${bon.lines.length - remaining.length}/${bon.lines.length}`
                    : (vi ? 'chờ' : 'pending')}
                </span>
              </div>

              <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/40">
                <div className="col-span-5">{vi ? 'Sản phẩm' : 'Product'}</div>
                <div className="col-span-2 text-center">{vi ? 'Gửi' : 'Sent'}</div>
                <div className="col-span-5 text-center">{vi ? 'Nhận' : 'Received'}</div>
              </div>

              <div className="divide-y divide-border-soft">
                {bon.lines.map(l => {
                  const st = state[l.id] ?? { qty: String(l.qty_sent), reason: '', note: '' };
                  const qty = Number(st.qty);
                  const diff = qty - l.qty_sent;
                  const isDiff = diff !== 0;
                  const isReceived = received.has(l.id);
                  return (
                    <div key={l.id} className="px-4 py-2.5" style={{ backgroundColor: isReceived ? '#F0FDF4' : isDiff ? '#FEF2F2' : undefined }}>
                      <div className="grid grid-cols-12 items-center gap-2">
                        <div className="col-span-5 flex items-center gap-2 min-w-0">
                          {l.image_url
                            ? <img src={l.image_url} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                            : <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                          <span className="text-sm text-navy truncate">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)}</span>
                        </div>
                        <div className="col-span-2 text-center font-bold text-navy">×{l.qty_sent}</div>
                        <div className="col-span-5 flex items-center justify-center gap-2">
                          {isReceived ? (
                            <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: '#059669' }}>
                              <CheckCircle2 size={16} /> ×{st.qty}{isDiff && <span style={{ color: '#DC2626' }}> ({diff > 0 ? '+' : ''}{diff})</span>}
                            </span>
                          ) : (
                            <>
                              <input type="number" value={st.qty}
                                onChange={e => upd(l.id, { qty: e.target.value })}
                                className="w-14 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                                style={{ border: '1px solid', borderColor: isDiff ? '#F87171' : '#D1D5DB' }} />
                              {isDiff && <span className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>{diff > 0 ? '+' : ''}{diff}</span>}
                              <button onClick={() => receiveLine(bon, l)} disabled={savingLine === l.id || (isDiff && !st.reason)}
                                className="text-xs font-bold px-2.5 py-1.5 rounded-lg text-white shrink-0 disabled:opacity-40"
                                style={{ backgroundColor: '#16A34A' }}>
                                {savingLine === l.id ? '…' : (vi ? 'Nhận' : 'Receive')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {isDiff && !isReceived && (
                        <div className="mt-2 flex flex-col sm:flex-row gap-2">
                          <select value={st.reason} onChange={e => upd(l.id, { reason: e.target.value })}
                            className="rounded-lg px-2 py-1.5 text-sm sm:w-48"
                            style={{ border: '1px solid', borderColor: st.reason ? '#D1D5DB' : '#F87171', backgroundColor: 'white' }}>
                            <option value="">{vi ? '— Lý do —' : '— Reason —'}</option>
                            {REASONS.map(r => <option key={r.v} value={r.v}>{vi ? r.vi : r.en}</option>)}
                          </select>
                          <input type="text" value={st.note} onChange={e => upd(l.id, { note: e.target.value })}
                            placeholder={vi ? 'Ghi chú (tuỳ chọn)' : 'Note (optional)'}
                            className="flex-1 rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between px-4 py-3" style={{ backgroundColor: '#F9FAFB' }}>
                <span className="text-sm flex items-center gap-1.5" style={{ color: discrepancies > 0 ? '#DC2626' : '#6B7280' }}>
                  {discrepancies > 0
                    ? <><AlertTriangle size={15} /> {discrepancies} {vi ? 'chênh lệch' : (discrepancies > 1 ? 'discrepancies' : 'discrepancy')}</>
                    : <>{remaining.length} {vi ? 'còn lại' : 'left'}</>}
                </span>
                <button onClick={() => receiveAll(bon)} disabled={savingBon === bon.id || blockedAll || remaining.length === 0}
                  className="px-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-50"
                  style={{ backgroundColor: '#16A34A' }}>
                  {savingBon === bon.id ? '…' : (vi ? 'Nhận tất cả' : 'Receive all')}
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
