'use client';
import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { PackageCheck, AlertTriangle, CheckCircle2, Clock, ChevronRight, ChevronLeft, ChevronsRight, CalendarDays } from 'lucide-react';

type RecapRow = { team: string; name: string; sku: string | null; variant: string | null; sent: number; received: number; pending: number };
type Recap = { date: string; totalSent: number; totalReceived: number; totalPending: number; notesCount: number; rows: RecapRow[] };

type Line = {
  id: string; product_name_vi: string; product_name_en: string | null;
  sku: string | null; variant_label: string | null; image_url: string | null;
  qty_sent: number; qty_received: number | null;
  discrepancy_reason?: string | null; discrepancy_note?: string | null;
};
type Bon = { id: string; team: string; created_by_name: string | null; created_at: string; lines: Line[] };
type HistBon = Bon & { received_by_name: string | null; received_at: string | null };

const REASONS = [
  { v: 'casse', vi: 'Vỡ / hỏng', en: 'Broken / damaged' },
  { v: 'miscount', vi: 'Đếm sai', en: 'Miscount' },
  { v: 'missing', vi: 'Thiếu hàng', en: 'Missing' },
  { v: 'other', vi: 'Khác', en: 'Other' },
];

export default function ReceptionView({ bons, history = [] }: { bons: Bon[]; history?: HistBon[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [showHistory, setShowHistory] = useState(false);
  const reasonLabel = (v: string | null | undefined) => {
    const r = REASONS.find(x => x.v === v); return r ? (vi ? r.vi : r.en) : (v ?? '');
  };
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

  // ── Recap consolidé, par jour d'ENVOI (date du bon de transfert) — produit x équipe ──
  const today = new Date().toISOString().split('T')[0];
  const [recapDate, setRecapDate] = useState(today);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [showRecap, setShowRecap] = useState(true);

  useEffect(() => {
    let cancel = false;
    setRecapLoading(true);
    fetch(`/api/lab/reception-recap?date=${recapDate}`)
      .then(r => r.json())
      .then(j => { if (!cancel) setRecap(j); })
      .catch(() => { if (!cancel) setRecap(null); })
      .finally(() => { if (!cancel) setRecapLoading(false); });
    return () => { cancel = true; };
  }, [recapDate]);

  function shiftDay(delta: number) {
    const d = new Date(recapDate + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    setRecapDate(d.toISOString().split('T')[0]);
  }

  // Explicit UTC parse + explicit timeZone: keeps this deterministic between server render (SSR,
  // likely UTC) and the browser (lab-local) — a bare toLocaleDateString() without timeZone can
  // format differently on each side and break hydration.
  const recapDateLabel = new Date(recapDate + 'T12:00:00Z').toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Ho_Chi_Minh',
  });

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

      {/* ── Récap consolidé par jour d'envoi × produit × équipe ── */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 flex-wrap gap-2" style={{ backgroundColor: '#F9FAFB' }}>
          <button onClick={() => setShowRecap(v => !v)} className="flex items-center gap-2 text-sm font-bold text-navy">
            <ChevronRight size={16} className={`transition-transform ${showRecap ? 'rotate-90' : ''}`} />
            <CalendarDays size={16} />
            {vi ? 'Tổng hợp theo ngày gửi' : "Récap par jour d'envoi"}
          </button>
          <div className="flex items-center gap-2">
            <button onClick={() => shiftDay(-1)} className="p-1.5 rounded-lg hover:bg-cream" style={{ border: '1px solid #E5E7EB' }}>
              <ChevronLeft size={14} />
            </button>
            <span className="text-sm font-semibold text-navy capitalize min-w-[160px] text-center">
              {recapDateLabel}{recapDate === today && <span className="text-ink-light font-normal"> · {vi ? 'hôm nay' : "aujourd'hui"}</span>}
            </span>
            <button onClick={() => shiftDay(1)} disabled={recapDate >= today} className="p-1.5 rounded-lg hover:bg-cream disabled:opacity-30" style={{ border: '1px solid #E5E7EB' }}>
              <ChevronRight size={14} />
            </button>
            {recapDate !== today && (
              <button onClick={() => setRecapDate(today)} className="p-1.5 rounded-lg hover:bg-cream" style={{ border: '1px solid #E5E7EB' }} title={vi ? 'Hôm nay' : "Aujourd'hui"}>
                <ChevronsRight size={14} />
              </button>
            )}
          </div>
        </div>
        {showRecap && (
          <div>
            {recapLoading ? (
              <div className="px-4 py-6 text-center text-sm text-ink-light">{vi ? 'Đang tải…' : 'Chargement…'}</div>
            ) : !recap || recap.rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-light">
                {vi ? 'Không có phiếu chuyển ngày này' : "Aucun bon de transfert envoyé ce jour"}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/40">
                  <div className="col-span-2">{vi ? 'Đội' : 'Équipe'}</div>
                  <div className="col-span-5">{vi ? 'Sản phẩm' : 'Produit'}</div>
                  <div className="col-span-2 text-center">{vi ? 'Gửi' : 'Envoyé'}</div>
                  <div className="col-span-3 text-center">{vi ? 'Trạng thái' : 'Statut'}</div>
                </div>
                <div className="divide-y divide-border-soft">
                  {recap.rows.map((r, i) => {
                    const meta = TEAM_LABELS[r.team as Team];
                    const missing = r.pending > 0;
                    return (
                      <div key={i} className="grid grid-cols-12 items-center gap-2 px-4 py-2 text-sm"
                        style={{ backgroundColor: missing ? '#FEF2F2' : undefined }}>
                        <div className="col-span-2 text-xs font-semibold" style={{ color: meta?.color ?? '#374151' }}>
                          {meta ? (vi ? meta.vi : meta.en) : r.team}
                        </div>
                        <div className="col-span-5 truncate text-navy">
                          {r.name}{r.variant && r.variant !== 'Standard' && <span className="text-ink-light text-xs"> · {r.variant}</span>}
                        </div>
                        <div className="col-span-2 text-center font-bold text-navy">×{r.sent}</div>
                        <div className="col-span-3 text-center">
                          {missing ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold" style={{ color: '#DC2626' }}>
                              <AlertTriangle size={12} /> {vi ? `Thiếu xác nhận · ${r.pending}` : `À confirmer · ${r.pending}`}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs font-bold" style={{ color: '#16A34A' }}>
                              <CheckCircle2 size={12} /> {vi ? 'Đã nhận' : 'Reçu'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="px-4 py-2.5 text-xs text-ink-light flex items-center gap-3 flex-wrap" style={{ backgroundColor: '#F9FAFB' }}>
                  <span>{recap.notesCount} {vi ? 'phiếu' : (recap.notesCount > 1 ? 'bons' : 'bon')}</span>
                  <span>·</span>
                  <span>{vi ? 'Gửi' : 'Envoyé'} {recap.totalSent}</span>
                  <span>·</span>
                  <span>{vi ? 'Đã nhận' : 'Reçu'} {recap.totalReceived}</span>
                  {recap.totalPending > 0 && (
                    <span className="font-bold" style={{ color: '#DC2626' }}>
                      · {vi ? 'Còn thiếu' : 'Manquant'} {recap.totalPending}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
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

      {/* History — validated transfer notes (read-only) */}
      {history.length > 0 && (
        <div className="pt-2">
          <button onClick={() => setShowHistory(v => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-ink-light hover:text-navy transition-colors">
            <ChevronRight size={16} className={`transition-transform ${showHistory ? 'rotate-90' : ''}`} />
            {vi ? 'Lịch sử đã nhận' : 'Received history'} · {history.length}
          </button>
          {showHistory && (
            <div className="mt-3 space-y-3">
              {history.map(h => {
                const meta = TEAM_LABELS[h.team as Team];
                const sentAt = h.created_at ? new Date(h.created_at).toLocaleString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
                const recAt = h.received_at ? new Date(h.received_at).toLocaleString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
                const diffs = h.lines.filter(l => l.qty_received != null && l.qty_received !== l.qty_sent).length;
                return (
                  <div key={h.id} className="card overflow-hidden" style={{ opacity: 0.95 }}>
                    <div className="flex items-center justify-between px-4 py-2.5" style={{ backgroundColor: '#F0FDF4' }}>
                      <div className="text-sm font-semibold text-navy">
                        {vi ? 'Phiếu' : 'Note'} #{h.id.slice(0, 6).toUpperCase()}
                        <span className="text-ink-light font-normal"> · {vi ? 'Gửi bởi' : 'Envoyé par'} {h.created_by_name ?? '—'} {vi ? 'lúc' : 'à'} {sentAt} · {meta ? (vi ? meta.vi : meta.en) : h.team}</span>
                      </div>
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1" style={{ backgroundColor: '#DCFCE7', color: '#166534' }}>
                        <CheckCircle2 size={12} /> {vi ? 'đã nhận' : 'received'}
                      </span>
                    </div>
                    <div className="divide-y divide-border-soft">
                      {h.lines.map(l => {
                        const diff = (l.qty_received ?? 0) - l.qty_sent;
                        return (
                          <div key={l.id} className="px-4 py-2 grid grid-cols-12 items-center gap-2 text-sm">
                            <span className="col-span-6 text-navy truncate">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)}</span>
                            <span className="col-span-2 text-center text-ink-light">×{l.qty_sent}</span>
                            <span className="col-span-4 text-center font-semibold">
                              →&nbsp;×{l.qty_received ?? '—'}
                              {diff !== 0 && <span className="ml-1 text-xs font-bold" style={{ color: '#DC2626' }}>({diff > 0 ? '+' : ''}{diff} · {reasonLabel(l.discrepancy_reason)})</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="px-4 py-2 text-xs text-ink-light" style={{ backgroundColor: '#F9FAFB' }}>
                      {vi ? 'Nhận bởi' : 'Received by'} {h.received_by_name ?? '—'} · {recAt}
                      {diffs > 0 && <span className="ml-2" style={{ color: '#DC2626' }}>· {diffs} {vi ? 'chênh lệch' : 'discrepancy'}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
