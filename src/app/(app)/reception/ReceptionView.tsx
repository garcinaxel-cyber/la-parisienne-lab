'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { PackageImport, PackageCheck, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

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
    for (const b of bons) for (const l of b.lines) s[l.id] = { qty: String(l.qty_sent), reason: '', note: '' };
    return s;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const upd = (id: string, patch: Partial<{ qty: string; reason: string; note: string }>) =>
    setState(p => ({ ...p, [id]: { ...p[id], ...patch } }));

  async function validate(bon: Bon) {
    const missing = bon.lines.some(l => {
      const st = state[l.id]; const qty = Number(st?.qty);
      return qty !== l.qty_sent && !(st?.reason);
    });
    if (missing) return; // reason required on discrepancy
    setSaving(bon.id);
    const { receiveStockTransferAction } = await import('./actions');
    const res = await receiveStockTransferAction(bon.id, bon.lines.map(l => ({
      lineId: l.id, qtyReceived: Number(state[l.id]?.qty ?? l.qty_sent),
      reason: state[l.id]?.reason || null, note: state[l.id]?.note || null,
    })));
    setSaving(null);
    if (res.ok) setDone(p => new Set(p).add(bon.id));
  }

  const visible = bons.filter(b => !done.has(b.id));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            <PackageImport size={24} /> {vi ? 'Nhập kho' : 'Stock reception'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi ? 'Xác nhận số lượng nhận từ các phiếu chuyển kho.' : 'Confirm the quantities received from transfer notes.'}
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
          const discrepancies = bon.lines.filter(l => Number(state[l.id]?.qty) !== l.qty_sent).length;
          const blocked = bon.lines.some(l => Number(state[l.id]?.qty) !== l.qty_sent && !state[l.id]?.reason);
          return (
            <div key={bon.id} className="card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3" style={{ backgroundColor: '#F9FAFB', borderBottom: '1px solid var(--tw-border, #eee)' }}>
                <div className="text-sm font-semibold text-navy">
                  {vi ? 'Phiếu' : 'Note'} #{bon.id.slice(0, 6).toUpperCase()}
                  <span className="text-ink-light font-normal"> · {bon.created_by_name ?? '—'} · {meta ? (vi ? meta.vi : meta.en) : bon.team} · {time}</span>
                </div>
                <span className="text-[11px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                  {vi ? 'chờ' : 'pending'}
                </span>
              </div>

              <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/40">
                <div className="col-span-6">{vi ? 'Sản phẩm' : 'Product'}</div>
                <div className="col-span-2 text-center">{vi ? 'Gửi' : 'Sent'}</div>
                <div className="col-span-4 text-center">{vi ? 'Nhận' : 'Received'}</div>
              </div>

              <div className="divide-y divide-border-soft">
                {bon.lines.map(l => {
                  const st = state[l.id] ?? { qty: String(l.qty_sent), reason: '', note: '' };
                  const qty = Number(st.qty);
                  const diff = qty - l.qty_sent;
                  const isDiff = diff !== 0;
                  return (
                    <div key={l.id} className="px-4 py-2.5" style={{ backgroundColor: isDiff ? '#FEF2F2' : undefined }}>
                      <div className="grid grid-cols-12 items-center gap-2">
                        <div className="col-span-6 flex items-center gap-2 min-w-0">
                          {l.image_url
                            ? <img src={l.image_url} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                            : <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                          <span className="text-sm text-navy truncate">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)}</span>
                        </div>
                        <div className="col-span-2 text-center font-bold text-navy">×{l.qty_sent}</div>
                        <div className="col-span-4 flex items-center justify-center gap-2">
                          <input type="number" value={st.qty}
                            onChange={e => upd(l.id, { qty: e.target.value })}
                            className="w-16 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                            style={{ border: '1px solid', borderColor: isDiff ? '#F87171' : '#D1D5DB' }} />
                          {isDiff && <span className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>{diff > 0 ? '+' : ''}{diff}</span>}
                          {!isDiff && qty > 0 && <CheckCircle2 size={16} className="text-green-600 shrink-0" />}
                        </div>
                      </div>
                      {isDiff && (
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
                    : <>{bon.lines.length} {vi ? 'sản phẩm' : 'products'}</>}
                </span>
                <button onClick={() => validate(bon)} disabled={saving === bon.id || blocked}
                  className="px-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-50"
                  style={{ backgroundColor: '#16A34A' }}>
                  {saving === bon.id ? '…' : (vi ? 'Xác nhận nhận kho' : 'Confirm reception')}
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
