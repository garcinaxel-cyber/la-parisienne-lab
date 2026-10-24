'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { REASON_LABELS, SHORT_REASONS_STOCK, SHORT_REASONS_PACKAGING, OTHER_NOTE_MIN } from '@/lib/delivery-check-reasons';
import type { GapContext } from '@/lib/delivery-gap';

// The question shown under a delivery-check line whose quantity ≠ the order (Axel, 2026-10-24 —
// maquettes real-ui-1/2/3). Simple Vietnamese first, English small. Saves the line itself, then
// fires the follow-up (card correction, forgotten transfer, Lab scrap, Odoo) WITHOUT waiting.
// Never blocks: every path ends on a confirm button.

type Opt = { code: string; vi: string; en: string; sub?: string; subEn?: string };

export default function GapResolver({ lineId, expected, qty, vi, onSaved, onRecount, demoCtx, fromTasks = false }: {
  lineId: string; expected: number; qty: number; vi: boolean; fromTasks?: boolean;
  demoCtx?: GapContext; // staff poster / training screenshots only — never set in the app
  onSaved: (reason: string, note: string) => void;
  onRecount: () => void;
}) {
  const [ctx, setCtx] = useState<GapContext | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState<string>('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Broken units already declared in the Hao hụt Lab tab: no second scrap (review 2026-10-24).
  const [alreadyReported, setAlreadyReported] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setCtx(null); setErr(null); setPick('');
    const t = setTimeout(async () => {
      if (demoCtx) {
        setCtx(demoCtx);
        if (demoCtx.family === 'mto' && demoCtx.dir === 'short' && demoCtx.autoNotMade) setPick('not_made');
        if (demoCtx.dir === 'over' && (demoCtx.family !== 'mto' || demoCtx.madeCovers)) setPick(demoCtx.family === 'mto' ? 'extra_made' : 'extra_stock');
        return;
      }
      const { getGapContextAction } = await import('@/app/(app)/delivery-check/actions');
      const r = await getGapContextAction(lineId, qty);
      if (!alive) return;
      if (r.error || !r.ctx) { setErr(r.error ?? 'Error'); return; }
      setCtx(r.ctx);
      if (r.ctx.family === 'mto' && r.ctx.dir === 'short' && r.ctx.autoNotMade) setPick('not_made');
      if (r.ctx.dir === 'over' && (r.ctx.family !== 'mto' || r.ctx.madeCovers)) setPick(r.ctx.family === 'mto' ? 'extra_made' : 'extra_stock');
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [lineId, qty]);

  const diff = Math.abs(qty - expected);
  const L = (o: { vi: string; en: string }) => vi ? o.vi : o.en;

  async function onFile(f: File | undefined) {
    if (!f) return;
    setUploading(true);
    const fd = new FormData(); fd.append('file', f);
    const { uploadLossPhotoAction } = await import('@/app/(app)/delivery-check/actions');
    const r = await uploadLossPhotoAction(fd);
    setUploading(false);
    if (r.url) setPhoto(r.url); else setErr(r.error ?? 'Upload error');
  }

  async function confirm() {
    if (!pick || saving) return;
    setSaving(true); setErr(null);
    const { checkLineAction, followUpLineAction } = await import('@/app/(app)/delivery-check/actions');
    const r = await checkLineAction(lineId, qty, pick, note.trim() || null, fromTasks);
    if (!r.ok) { setSaving(false); setErr(r.error ?? 'Error'); return; }
    // At the delivery check the assistant moves on immediately (Odoo can take seconds); from the
    // tasks tab we wait, so the card turns green (or shows the Odoo error) right away.
    if (fromTasks) { const f = await followUpLineAction(lineId, photo, pick === 'casse' && alreadyReported); if (f.error) { setSaving(false); setErr(f.error); return; } }
    else followUpLineAction(lineId, photo, pick === 'casse' && alreadyReported).catch(() => {});
    setSaving(false);
    onSaved(pick, note.trim());
  }

  const box = (children: React.ReactNode, tone: 'red' | 'amber' | 'green' = 'red') => (
    <div className="mt-2 rounded-xl px-3 py-3" style={{ backgroundColor: '#FFFBF5', border: `1px solid ${tone === 'red' ? '#F3C9C3' : tone === 'amber' ? '#F1DFB0' : '#CDE9D6'}` }}>{children}</div>
  );
  if (err && !ctx) return box(<div className="text-sm" style={{ color: '#B42318' }}>{err}</div>);
  if (!ctx) return box(<div className="text-sm text-ink-light flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{vi ? 'Đang kiểm tra…' : 'Checking…'}</div>);

  const tile = (n: string | number, vt: string, et: string, hl = false) => (
    <div className="flex-1 rounded-lg px-1.5 py-1.5 text-center" style={{ border: `1px solid ${hl ? '#DC2626' : '#E5E7EB'}`, backgroundColor: hl ? '#FEF2F2' : 'white' }}>
      <div className="font-bold text-base" style={{ color: hl ? '#B91C1C' : '#1F2937' }}>{n}</div>
      <div className="text-[11px] leading-tight text-gray-700">{vt}</div>
      <div className="text-[10px] leading-tight text-gray-400">{et}</div>
    </div>
  );
  const tiles = (
    <div className="flex gap-1.5 mb-2.5">
      {tile(ctx.made, 'Bếp đã làm', 'Made')}
      {tile(ctx.sent, 'Đã chuyển kho', 'Sent to stock')}
      {tile(ctx.otherLeft, 'Đơn khác đã lấy', 'Other orders')}
      {ctx.lost > 0 && tile(ctx.lost, 'Đã báo hỏng', 'Reported broken')}
      {tile(`${qty} / ${expected}`, 'Đơn này', 'This order', true)}
    </div>
  );
  const radio = (o: Opt) => {
    const sel = pick === o.code;
    return (
      <button key={o.code} type="button" onClick={() => { if (o.code === 'recount') { onRecount(); return; } setPick(o.code); }}
        className="w-full text-left flex gap-2.5 items-start rounded-xl px-3 py-2 mb-1.5 bg-white"
        style={{ border: sel ? '2px solid #1A4731' : '1px solid #D1D5DB' }}>
        <span className="mt-0.5 shrink-0 rounded-full" style={{ width: 16, height: 16, border: sel ? '5px solid #1A4731' : '2px solid #9CA3AF' }} />
        <span>
          <span className="block text-sm font-semibold text-navy">{vi ? o.vi : o.en}</span>
          {(o.sub || o.subEn) && <span className="block text-xs text-gray-500">{vi ? o.sub : o.subEn}</span>}
          {vi && <span className="block text-[10.5px] text-gray-400">{o.en}</span>}
        </span>
      </button>
    );
  };
  const chips = (codes: string[]) => (
    <div className="flex flex-wrap gap-1.5">
      {codes.map(c => (
        <button key={c} type="button" onClick={() => setPick(c)} className="rounded-full px-3 py-1.5 text-[13px] font-semibold"
          style={pick === c ? { backgroundColor: '#1A4731', color: 'white' } : { border: '1px solid #D1D5DB', backgroundColor: 'white', color: '#374151' }}>
          {L(REASON_LABELS[c])}
        </button>
      ))}
    </div>
  );
  const needPhoto = pick === 'casse' && !photo && !alreadyReported;
  const needNote = pick === 'other' && note.trim().length < OTHER_NOTE_MIN;
  const extras = (
    <>
      {pick === 'casse' && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold"
            style={{ border: `1px solid ${photo ? '#16A34A' : '#DC2626'}`, color: photo ? '#166534' : '#B42318', backgroundColor: 'white' }}>
            <Camera size={14} /> {uploading ? '…' : photo ? (vi ? 'Đã có ảnh ✓' : 'Photo ✓') : (vi ? 'Chụp 1 ảnh (bắt buộc)' : 'Take a photo (required)')}
          </button>
          <span className="text-xs text-gray-500">{vi ? 'Ghi vào Hao hụt Lab' : 'Goes to Lab scrap'}</span>
          {ctx && ctx.lost > 0 && (
            <label className="flex w-full items-center gap-1.5 text-xs text-gray-700">
              <input type="checkbox" checked={alreadyReported} onChange={e => setAlreadyReported(e.target.checked)} />
              {vi ? `Bánh hỏng này đã báo ở tab Hao hụt Lab rồi (${ctx.lost}) — không ghi lại` : `Already reported in the Lab scrap tab (${ctx.lost}) — do not record again`}
            </label>
          )}
        </div>
      )}
      {pick === 'out_of_stock' && <div className="mt-1.5 text-xs rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#FFF4D6', color: '#8A5A00' }}>⚑ {vi ? 'App sẽ báo kho đếm lại sản phẩm này. Không cần sửa gì khác — cửa hàng sẽ đặt lại.' : 'The app asks the stock to recount this product. Nothing else to fix — the shop re-orders.'}</div>}
      {(pick === 'other' || pick === 'order_changed' || pick === 'packing') && (
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder={pick === 'other' ? (vi ? 'Ghi rõ lý do (bắt buộc)' : 'Explain the reason (required)') : (vi ? 'Ghi chú (tuỳ chọn)' : 'Note (optional)')}
          className="mt-1.5 w-full rounded-lg px-2.5 py-1.5 text-sm" style={{ border: `1px solid ${needNote ? '#F87171' : '#D1D5DB'}` }} />
      )}
    </>
  );
  const footer = (okVi: string, okEn: string) => (
    <div className="flex items-center justify-end gap-2 mt-2">
      {err && <span className="text-xs mr-auto" style={{ color: '#B42318' }}>{err}</span>}
      <button type="button" onClick={onRecount} className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-white" style={{ border: '1px solid #D1D5DB', color: '#374151' }}>{vi ? 'Huỷ / sửa số' : 'Cancel / fix qty'}</button>
      <button type="button" onClick={confirm} disabled={!pick || needPhoto || needNote || saving || uploading}
        className="rounded-lg px-4 py-1.5 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
        {saving ? '…' : (vi ? okVi : okEn)}
      </button>
    </div>
  );

  // ── Over the order ──
  if (ctx.dir === 'over') {
    if (ctx.family !== 'mto' || ctx.madeCovers) {
      return box(<>
        <div className="font-bold text-[15px] text-navy">{vi ? `Gửi thêm ${diff} so với đơn?` : `Send ${diff} more than ordered?`}</div>
        <div className="text-xs text-gray-500">{ctx.family === 'mto'
          ? (vi ? 'Bếp đã làm đủ — chỉ cần xác nhận là cố ý (nhập 9 thay vì 6 sẽ bị phát hiện ở đây).' : 'The kitchen made enough — just confirm it is on purpose.')
          : (vi ? 'Không phải lỗi — chỉ cần xác nhận là cố ý.' : 'Not an anomaly — just confirm it is on purpose.')}</div>
        {footer(`Có, gửi thêm ${diff}`, `Yes, send +${diff}`)}
      </>, 'green');
    }
    return box(<>
      <div className="font-bold text-[15px] text-navy">{vi ? `Gửi ${qty} — bếp mới báo làm ${ctx.made}. ${diff} cái thêm lấy từ đâu?` : `You send ${qty} — kitchen declared ${ctx.made}. Where do the +${diff} come from?`}</div>
      <div className="text-xs text-gray-400 mb-2">{vi ? 'Tính cho cả ngày, tất cả các đơn' : 'Whole day, all orders'}</div>
      {tiles}
      {radio({ code: 'undeclared', vi: 'Bếp đã làm nhưng chưa báo', en: 'Made but not declared', sub: 'App tự cộng vào số bếp đã làm', subEn: 'The app adds it to the kitchen count' })}
      {radio({ code: 'from_lab_stock', vi: 'Lấy từ kho Lab (hàng hôm trước)', en: 'Taken from Lab stock', sub: 'Không thêm sản xuất', subEn: 'No production added' })}
      {radio({ code: 'recount', vi: 'Mình đếm sai', en: 'I counted wrong', sub: 'Quay lại đếm lại', subEn: 'Go back and count again' })}
      {radio({ code: 'other', vi: 'Lý do khác', en: 'Other', sub: 'Ghi rõ lý do', subEn: 'Explain' })}
      {extras}
      {footer('Xác nhận', 'Confirm')}
    </>);
  }

  // ── Short ──
  if (ctx.family === 'mto') {
    if (ctx.autoNotMade) {
      return box(<>
        <div className="font-bold text-[15px] text-navy">{vi ? `Bếp chưa làm ${diff} cái` : `${diff} not made by the kitchen`}</div>
        <div className="text-xs" style={{ color: '#8A5A00' }}>🔒 {vi ? `Theo thẻ bếp: ${ctx.autoNote}. Không cần sửa gì — cửa hàng sẽ đặt lại.` : `From the kitchen card: ${ctx.autoNote}. Nothing to fix — the shop re-orders.`}</div>
        {footer('Xác nhận', 'Confirm')}
      </>, 'amber');
    }
    return box(<>
      <div className="font-bold text-[15px] text-navy">{vi ? `Thiếu ${diff} — cái còn lại ở đâu?` : `${diff} missing — where is it?`}</div>
      <div className="text-xs text-gray-400 mb-2">{vi ? 'Hôm nay, tất cả các đơn' : 'Today, all orders'}</div>
      {tiles}
      {radio({ code: 'not_made', vi: 'Bếp chưa làm cái này', en: 'It was never made', sub: 'App tự sửa số lượng bếp đã làm', subEn: 'The app corrects the kitchen count by itself' })}
      {radio({ code: 'casse', vi: 'Bánh bị hỏng / vỡ', en: 'Broken / damaged', sub: 'Chụp 1 ảnh — ghi vào hao hụt Lab', subEn: 'Take 1 photo — goes to Lab scrap' })}
      {radio({ code: 'order_changed', vi: 'Cửa hàng / khách đổi đơn', en: 'Order changed by shop / customer' })}
      {radio({ code: 'packing', vi: 'Soạn hàng thiếu', en: 'Packing mistake', sub: 'Chỉ ghi lại — cửa hàng sẽ đặt lại', subEn: 'Recorded only — the shop re-orders' })}
      {radio({ code: 'recount', vi: 'Mình đếm sai', en: 'I counted wrong', sub: 'Quay lại đếm lại', subEn: 'Go back and count again' })}
      {radio({ code: 'other', vi: 'Lý do khác', en: 'Other', sub: 'Ghi rõ lý do', subEn: 'Explain' })}
      {extras}
      {footer('Xác nhận', 'Confirm')}
    </>);
  }
  return box(<>
    <div className="font-bold text-[15px] text-navy">{vi ? `Thiếu ${diff} — vì sao?` : `${diff} missing — why?`} <span className="font-normal text-xs text-gray-400">{vi ? '(bắt buộc)' : '(required)'}</span></div>
    <div className="mt-1.5">{chips(ctx.family === 'stock' ? SHORT_REASONS_STOCK : SHORT_REASONS_PACKAGING)}</div>
    {extras}
    {footer('Xác nhận', 'Confirm')}
  </>);
}
