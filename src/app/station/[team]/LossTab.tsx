'use client';
// Chef losses (Axel, 2026-11-12) — pilot Team Hung. Declare (finished / raw / packaging; intermediate
// recipes "coming soon"), validate (team lead), then Odoo. Units and % only, never VND.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, Camera, Trash2, Pencil, CheckCircle2, AlertTriangle, Clock, RotateCcw, X } from 'lucide-react';
import ItemPhoto from '@/components/raw/ItemPhoto';
import { getLossDataAction, declareLossAction, updateLossAction, deleteLossAction, validateLossesAction, retryLossAction, type LossData, type LossItem } from './loss-actions';
import { uploadRawPhotoAction } from './raw-actions';
import { REASONS_FINISHED, REASONS_STOCK, type ChefLoss } from '@/lib/chef-rd';
import { TEAM_SHORT } from '@/lib/raw-materials';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318', AMBER = '#B45309';
const fmtQty = (n: number) => String(Math.round(n * 1000) / 1000).replace('.', ',');

async function compressImage(file: File): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1280; const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return await new Promise<Blob>(res => c.toBlob(b => res(b!), 'image/jpeg', 0.82));
}

type Kind = 'fin' | 'raw' | 'pack' | 'sm';
type Draft = { item: LossItem; qty: number; reasonId: number | null; beforeStock: boolean | null; note: string; photoUrl: string | null; editId?: string };

export default function LossTab({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [data, setData] = useState<LossData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<'declare' | 'today' | 'month'>('declare');
  const [kind, setKind] = useState<Kind>('fin');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await getLossDataAction(team);
    if (r.error) setErr(r.error); else { setErr(null); setData(r.data!); }
  }, [team]);
  useEffect(() => { load(); }, [load]);

  const pending = useMemo(() => (data?.losses ?? []).filter(l => l.status === 'pending'), [data]);
  const sent = useMemo(() => (data?.losses ?? []).filter(l => l.status !== 'pending' && l.labDay === data?.today), [data]);

  const items = useMemo(() => {
    if (!data || kind === 'sm') return [];
    const s = q.trim().toLowerCase();
    const list = data.items.filter(i => i.kind === kind && (!s || `${i.name} ${i.nameVi ?? ''} ${i.sku ?? ''}`.toLowerCase().includes(s)));
    return list.slice(0, s ? 80 : 40);
  }, [data, kind, q]);

  const itemName = (i: { name: string; nameVi?: string | null }) => (lang === 'vi' && i.nameVi ? i.nameVi : i.name);
  const unitLabel = (u: string) => (u === 'pcs' ? L('cái', 'pcs') : u === 'Unit' || u === 'Units' || u === 'Unité(s)' ? L('cái', 'pcs') : u);
  const isPcs = (u: string) => u === 'pcs' || /unit/i.test(u);

  const open = (item: LossItem) => { setMsg(null); setDraft({ item, qty: isPcs(item.uom) ? 1 : 0.1, reasonId: null, beforeStock: item.kind === 'fin' ? null : false, note: '', photoUrl: null }); };
  const openEdit = (l: ChefLoss) => {
    const item = data?.items.find(i => (l.kind === 'fin' ? i.sku === l.sku && i.kind === 'fin' : i.tmplId === l.tmplId))
      ?? { kind: l.kind === 'fin' ? 'fin' : l.kind === 'pack' ? 'pack' : 'raw', key: l.id, sku: l.sku, tmplId: l.tmplId, productId: l.productId, name: l.name, nameVi: null, uom: l.uom ?? 'kg', photo: null, rank: 0, category: null } as LossItem;
    setMsg(null);
    setDraft({ item, qty: l.qty, reasonId: l.reasonId, beforeStock: l.kind === 'fin' ? l.beforeStock : false, note: l.note ?? '', photoUrl: l.photoUrl, editId: l.id });
  };

  async function pickPhoto(f: File | undefined) {
    if (!f || !draft) return;
    setBusy(true);
    try {
      const blob = await compressImage(f);
      const fd = new FormData(); fd.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      const r = await uploadRawPhotoAction(fd);
      if (r.error) setMsg({ ok: false, text: r.error }); else setDraft(d => d ? { ...d, photoUrl: r.url! } : d);
    } catch { setMsg({ ok: false, text: L('Không tải được ảnh.', 'Could not upload the photo.') }); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function confirm() {
    if (!draft || !draft.reasonId || !(draft.qty > 0) || (draft.item.kind === 'fin' && draft.beforeStock === null)) return;
    setBusy(true);
    const r = draft.editId
      ? await updateLossAction(team, draft.editId, { qty: draft.qty, reasonId: draft.reasonId, beforeStock: !!draft.beforeStock, note: draft.note, photoUrl: draft.photoUrl })
      : await declareLossAction(team, {
          kind: draft.item.kind, sku: draft.item.sku, tmplId: draft.item.tmplId, productId: draft.item.productId, name: draft.item.name,
          uom: draft.item.uom, qty: draft.qty, beforeStock: !!draft.beforeStock, reasonId: draft.reasonId, note: draft.note, photoUrl: draft.photoUrl,
        });
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setDraft(null);
    setMsg({ ok: true, text: draft.editId ? L('Đã sửa.', 'Updated.') : L('Đã khai báo — chờ trưởng nhóm duyệt.', 'Declared — waiting for the team lead.') });
    load();
  }

  async function act(fn: () => Promise<{ ok?: boolean; error?: string; n?: number }>, okText: string) {
    setBusy(true); const r = await fn(); setBusy(false);
    if (r.error) setMsg({ ok: false, text: r.error }); else setMsg({ ok: true, text: okText });
    load();
  }

  if (err) return <div className="bg-white rounded-2xl p-5 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: LATE }}>{err}</div>;
  if (!data) return <div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}><Loader2 className="animate-spin inline mr-2" size={16} />{L('Đang tải…', 'Loading…')}</div>;

  const leads = data.leads.length ? data.leads.join(', ') : L('trưởng nhóm', 'the team lead');
  const reasons = draft ? (draft.item.kind === 'fin' ? REASONS_FINISHED : REASONS_STOCK) : [];
  const step = draft && isPcs(draft.item.uom) ? 1 : 0.05;
  const quick = draft ? (isPcs(draft.item.uom) ? [1, 2, 5, 10] : [0.1, 0.25, 0.5, 1]) : [];
  const canConfirm = !!draft && !!draft.reasonId && draft.qty > 0 && !(draft.item.kind === 'fin' && draft.beforeStock === null) && !busy;

  const Thumb = ({ i, size }: { i: { kind: string; tmplId: number | null; sku: string | null; photo?: string | null; name: string }; size: number }) =>
    i.kind === 'fin'
      ? (i.photo ? <img src={i.photo} alt="" loading="lazy" className="rounded-lg object-cover shrink-0" style={{ width: size, height: size, border: `1px solid ${HAIR}` }} />
        : <span className="rounded-lg shrink-0 flex items-center justify-center text-[11px] font-black" style={{ width: size, height: size, backgroundColor: PALE, color: GOLD_TEXT }}>{i.name.slice(0, 2).toUpperCase()}</span>)
      : <ItemPhoto tmplId={i.tmplId} sku={i.sku} size={size} />;

  const LossRow = ({ l, mode }: { l: ChefLoss; mode: 'pending' | 'sent' }) => {
    const item = data.items.find(i => (l.kind === 'fin' ? i.kind === 'fin' && i.sku === l.sku : i.tmplId === l.tmplId));
    const kindLabel = l.kind === 'fin' ? L('Thành phẩm', 'Finished') : l.kind === 'pack' ? L('Bao bì', 'Packaging') : l.kind === 'test' ? L('Thử công thức', 'Test trial') : L('Nguyên liệu', 'Raw mat.');
    return (
      <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${mode === 'pending' ? '#F3D58A' : BORDER}` }}>
        <div className="flex gap-2.5 items-start">
          <Thumb i={{ kind: l.kind === 'fin' ? 'fin' : 'raw', tmplId: l.tmplId, sku: l.sku, photo: item?.photo ?? null, name: l.name }} size={44} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-2">
              <span className="flex-1 min-w-0 text-[13px] font-extrabold leading-snug" style={{ color: NAVY }}>{item ? itemName(item) : l.name}</span>
              <span className="text-[14px] font-black tabular-nums whitespace-nowrap" style={{ color: '#9A3412' }}>{fmtQty(l.qty)} {unitLabel(l.uom ?? '')}</span>
            </div>
            <div className="flex flex-wrap gap-1 mt-1">
              <span className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#FDE7D2', color: '#9A3412' }}>{l.reason}</span>
              <span className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F5F5F4', color: '#57534E' }}>{kindLabel}</span>
              {l.kind === 'fin' && <span className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F5F5F4', color: '#57534E' }}>{l.beforeStock ? L('trước khi chuyển kho', 'before stock') : L('từ kho Lab', 'from Lab stock')}</span>}
              {l.photoUrl && <a href={l.photoUrl} target="_blank" rel="noreferrer" className="text-[10.5px] font-bold" style={{ color: '#2D6A4F' }}>{L('ảnh', 'photo')} ✓</a>}
            </div>
            <div className="text-[11px] mt-1" style={{ color: '#6B7280' }}>
              {new Date(l.declaredAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })} · {l.declaredBy ?? '—'}
              {l.labDay !== data.today && <> · <b style={{ color: AMBER }}>{l.labDay.slice(8, 10)}/{l.labDay.slice(5, 7)}</b></>}
              {l.note ? <> · {l.note}</> : null}
            </div>
            {mode === 'sent' && (
              <div className="text-[11px] mt-1 flex items-center gap-1 font-bold" style={{ color: l.odooState === 'done' ? '#047857' : l.odooState === 'error' ? LATE : AMBER }}>
                {l.odooState === 'done' ? <CheckCircle2 size={12} /> : l.odooState === 'error' ? <AlertTriangle size={12} /> : <Clock size={12} />}
                {l.odooState === 'done' ? `Odoo ✓${l.odooMoName ? ` · ${l.odooMoName}` : ''}` : l.odooState === 'error' ? `Odoo: ${l.odooError ?? 'error'}` : !data.odooOn ? L('Odoo tạm tắt (giai đoạn thử)', 'Odoo off (test phase)') : L('Đang gửi Odoo…', 'Sending to Odoo…')}
                <span className="font-semibold" style={{ color: '#9CA3AF' }}> · {l.status === 'auto' ? L('tự động (chưa duyệt)', 'auto (not validated)') : `${L('duyệt bởi', 'validated by')} ${l.validatedBy ?? ''}`}</span>
                {l.odooState === 'error' && data.canValidate && (
                  <button disabled={busy} onClick={() => act(() => retryLossAction(team, l.id), L('Đã gửi lại.', 'Sent again.'))} className="ml-1 inline-flex items-center gap-0.5 underline"><RotateCcw size={11} />{L('Thử lại', 'Retry')}</button>)}
              </div>
            )}
          </div>
        </div>
        {mode === 'pending' && l.kind !== 'test' && (
          <div className="flex gap-1.5">
            <button disabled={busy} onClick={() => openEdit(l)} className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl py-2 text-[12px] font-bold" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><Pencil size={12} />{L('Sửa', 'Edit')}</button>
            <button disabled={busy} onClick={() => act(() => deleteLossAction(team, l.id), L('Đã xoá — không gửi gì lên Odoo.', 'Deleted — nothing sent to Odoo.'))} className="flex-1 inline-flex items-center justify-center gap-1 rounded-xl py-2 text-[12px] font-bold" style={{ border: '1px solid #FCA5A5', color: LATE, backgroundColor: '#FEF2F2' }}><Trash2 size={12} />{L('Xoá', 'Delete')}</button>
            {data.canValidate && <button disabled={busy} onClick={() => act(() => validateLossesAction(team, [l.id]), L('Đã duyệt — gửi lên Odoo.', 'Validated — sent to Odoo.'))} className="flex-[1.4] rounded-xl py-2 text-[12px] font-extrabold text-white" style={{ backgroundColor: '#047857' }}>{L('Duyệt ✓', 'Validate ✓')}</button>}
          </div>
        )}
        {mode === 'pending' && l.kind === 'test' && data.canValidate && (
          <button disabled={busy} onClick={() => act(() => validateLossesAction(team, [l.id]), L('Đã duyệt — gửi lên Odoo.', 'Validated — sent to Odoo.'))} className="w-full rounded-xl py-2 text-[12px] font-extrabold text-white" style={{ backgroundColor: '#047857' }}>{L('Duyệt ✓', 'Validate ✓')}</button>
        )}
      </div>
    );
  };

  const m = data.month;
  const pct = m.produced > 0 ? (m.finPcs / m.produced) * 100 : null;
  const delta = m.finPrevPcs > 0 ? Math.round(((m.finPcs - m.finPrevPcs) / m.finPrevPcs) * 100) : null;
  const maxReason = Math.max(1, ...m.reasons.map(r => r.n));

  return (
    <div className="space-y-3">
      {msg && <div className="rounded-xl px-3 py-2.5 text-[12.5px] font-semibold flex items-center gap-2" style={{ backgroundColor: msg.ok ? '#EAF6EC' : '#FBEAE8', color: msg.ok ? '#067647' : LATE }}>{msg.ok && <CheckCircle2 size={15} />}{msg.text}</div>}
      {!data.odooOn && <div className="rounded-xl px-3 py-2 text-[11.5px] font-semibold" style={{ backgroundColor: '#EFF6FF', color: '#1D4ED8' }}>{L('Giai đoạn thử: khai báo và duyệt được ghi trong app, chưa gửi lên Odoo.', 'Test phase: declarations and validations are kept in the app, nothing is sent to Odoo yet.')}</div>}

      <div className="grid grid-cols-3 gap-1 bg-white rounded-xl p-1" style={{ border: `1px solid ${BORDER}` }}>
        {([['declare', L('Khai báo', 'Declare')], ['today', `${L('Hôm nay', 'Today')}${pending.length ? ` · ${pending.length}` : ''}`], ['month', L('Tháng này', 'This month')]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} className="rounded-lg py-2 text-[12.5px] font-bold relative" style={{ backgroundColor: view === k ? NAVY : 'transparent', color: view === k ? '#fff' : '#6B6455' }}>
            {label}{k === 'today' && pending.length > 0 && view !== k && <span className="absolute top-1 right-2 w-2 h-2 rounded-full" style={{ backgroundColor: LATE }} />}
          </button>))}
      </div>

      {view === 'declare' && (<>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
          {([['fin', L('Thành phẩm', 'Finished')], ['raw', L('Nguyên liệu', 'Raw mat.')], ['pack', L('Bao bì', 'Packaging')], ['sm', L('Bán thành phẩm · sắp có', 'Intermediate · soon')]] as const).map(([k, label]) => {
            const on = kind === k, soon = k === 'sm';
            return <button key={k} onClick={() => { setKind(k); setQ(''); }} className="flex-shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-bold"
              style={soon ? { backgroundColor: on ? '#E7E5E4' : '#F5F5F4', color: on ? '#57534E' : '#A8A29E', border: `1px dashed ${on ? '#A8A29E' : '#D6D3D1'}` }
                : { backgroundColor: on ? AMBER : '#fff', color: on ? '#fff' : NAVY, border: `1px solid ${on ? AMBER : BORDER}` }}>{label}</button>;
          })}
        </div>
        {kind === 'sm' ? (
          <div className="rounded-2xl p-5 text-center space-y-1.5" style={{ backgroundColor: '#F5F5F4', border: '1px dashed #D6D3D1' }}>
            <span className="inline-block text-[10.5px] font-black tracking-wider rounded-full px-2.5 py-0.5" style={{ backgroundColor: '#E7E5E4', color: '#57534E' }}>{L('SẮP CÓ', 'COMING SOON')}</span>
            <div className="text-[13px] font-bold" style={{ color: '#57534E' }}>{L('Bán thành phẩm (kem, bột, nhân…)', 'Intermediate recipes (cream, dough, filling…)')}</div>
            <div className="text-[11.5px] leading-snug" style={{ color: '#78716C' }}>{L('Tạm thời: một mẻ hỏng được khai báo qua nguyên liệu của nó (tab Nguyên liệu).', 'For now, a ruined batch is declared through its raw materials (Raw mat.).')}</div>
          </div>
        ) : (<>
          <label className="flex items-center gap-2 bg-white rounded-xl px-3" style={{ border: `1px solid ${BORDER}` }}>
            <Search size={14} style={{ color: '#9CA3AF' }} />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm tên hoặc mã…', 'Search a name or code…')} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
            {q && <button onClick={() => setQ('')} aria-label="Clear" className="p-1"><X size={14} style={{ color: '#9CA3AF' }} /></button>}
          </label>
          <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: GOLD_TEXT }}>{q ? L('KẾT QUẢ', 'RESULTS') : L('HAY BỊ HỎNG / HAY DÙNG NHẤT TRƯỚC', 'MOST LOST / MOST USED FIRST')}</div>
          <div className="grid grid-cols-2 gap-2">
            {items.map(i => (
              <button key={i.key} onClick={() => open(i)} className="text-left bg-white rounded-2xl p-2 flex items-center gap-2 min-h-[60px]" style={{ border: `1px solid ${BORDER}` }}>
                <Thumb i={i} size={42} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] font-bold leading-tight" style={{ color: NAVY }}>{itemName(i)}</span>
                  <span className="block text-[10.5px] mt-0.5" style={{ color: '#9CA3AF' }}>{i.sku ?? ''} · {unitLabel(i.uom)}</span>
                </span>
              </button>))}
          </div>
          {!items.length && <div className="bg-white rounded-2xl p-5 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B7280' }}>{L('Không tìm thấy.', 'Nothing found.')}</div>}
        </>)}
        <div className="text-[11px] leading-snug px-0.5" style={{ color: '#9C8F6A' }}>{L(`Ai trong team cũng khai báo được. ${leads} duyệt, rồi mới gửi lên Odoo. Chưa duyệt đến hết ngày: tự gửi.`, `Anyone in the team can declare. ${leads} validates, then it goes to Odoo. Not validated by the end of the day: sent anyway.`)}</div>
      </>)}

      {view === 'today' && (<>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[15px] font-extrabold" style={{ color: NAVY }}>{L('Chờ duyệt', 'To validate')} · {pending.length}</span>
          {data.canValidate && pending.length > 0 && (
            <button disabled={busy} onClick={() => act(() => validateLossesAction(team, pending.map(p => p.id)), L('Đã duyệt tất cả — gửi lên Odoo.', 'All validated — sent to Odoo.'))}
              className="rounded-xl px-3 py-2 text-[12.5px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={14} className="animate-spin inline" /> : L('Duyệt tất cả → Odoo', 'Validate all → Odoo')}</button>)}
        </div>
        <div className="text-[11px] -mt-1" style={{ color: '#9C8F6A' }}>{data.canValidate ? L('Kiểm tra, sửa nếu cần, rồi duyệt.', 'Check, correct if needed, then validate.') : L(`Chờ ${leads} duyệt. Bạn vẫn sửa / xoá được khai báo của mình.`, `Waiting for ${leads}. You can still edit or delete your own declarations.`)}</div>
        {pending.map(l => <LossRow key={l.id} l={l} mode="pending" />)}
        {!pending.length && <div className="bg-white rounded-2xl p-4 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B7280' }}>{L('Không có gì chờ duyệt.', 'Nothing waiting.')}</div>}
        <div className="text-[15px] font-extrabold pt-2" style={{ color: NAVY }}>{L('Đã gửi Odoo hôm nay', 'Sent to Odoo today')} · {sent.length}</div>
        {sent.map(l => <LossRow key={l.id} l={l} mode="sent" />)}
        {!sent.length && <div className="bg-white rounded-2xl p-4 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B7280' }}>{L('Chưa có.', 'None yet.')}</div>}
        <div className="text-[11px] leading-snug px-0.5" style={{ color: '#9C8F6A' }}>{L('Thành phẩm hỏng trước khi chuyển kho: được sản xuất (MO) rồi huỷ, để nguyên liệu được trừ đúng.', 'A finished product lost before it was sent to stock is first produced (MO), then scrapped, so its raw materials are counted.')}</div>
      </>)}

      {view === 'month' && (<>
        <div className="flex items-baseline justify-between">
          <span className="text-[15px] font-extrabold" style={{ color: NAVY }}>{L('Tháng', 'Month')} {m.month.slice(5)} · 1–{m.day}</span>
          <span className="text-[11px]" style={{ color: '#9C8F6A' }}>{L('so với cùng ngày tháng trước', 'vs same days last month')}</span>
        </div>
        <div className="bg-white rounded-2xl p-3" style={{ border: `1px solid ${BORDER}` }}>
          <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('THÀNH PHẨM HỎNG', 'FINISHED PRODUCTS LOST')}</div>
          <div className="flex items-baseline gap-2.5 mt-0.5">
            <span className="text-[28px] font-black" style={{ color: NAVY }}>{fmtQty(m.finPcs)} {L('cái', 'pcs')}</span>
            {delta !== null && <span className="text-[12.5px] font-extrabold" style={{ color: delta <= 0 ? '#047857' : LATE }}>{delta <= 0 ? '▼' : '▲'} {Math.abs(delta)} %</span>}
          </div>
          {pct !== null && <div className="text-[12px]" style={{ color: '#6B7280' }}>{pct.toFixed(1).replace('.', ',')} % {L('của', 'of the')} {Math.round(m.produced).toLocaleString('vi-VN')} {L('cái đã chuyển kho', 'pieces sent to stock')}</div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-2xl p-2.5" style={{ border: `1px solid ${BORDER}` }}><div className="text-[10px] font-extrabold" style={{ color: '#9C8F6A' }}>{L('NGUYÊN LIỆU & BAO BÌ', 'RAW MAT. & PACKAGING')}</div><div className="text-[17px] font-black" style={{ color: NAVY }}>{m.rawReports}</div><div className="text-[10.5px]" style={{ color: '#6B7280' }}>{L('lần khai báo', 'reports')}</div></div>
          <div className="bg-white rounded-2xl p-2.5" style={{ border: `1px solid ${BORDER}` }}><div className="text-[10px] font-extrabold" style={{ color: '#9C8F6A' }}>{L('THỬ CÔNG THỨC', 'TEST TRIALS')}</div><div className="text-[17px] font-black" style={{ color: NAVY }}>{m.testTrials}</div><div className="text-[10.5px]" style={{ color: '#6B7280' }}>{L('lần làm thử', 'trials')}</div></div>
        </div>
        {m.reasons.length > 0 && (
          <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
            <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('LÝ DO · THÀNH PHẨM', 'WHY · FINISHED PRODUCTS')}</div>
            {m.reasons.map(r => (
              <div key={r.reason} className="grid items-center gap-2" style={{ gridTemplateColumns: '110px minmax(0,1fr) 40px' }}>
                <span className="text-[12px] truncate">{r.reason}</span>
                <div className="h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: '#F5EFC8' }}><div className="h-full rounded-full" style={{ width: `${Math.round((r.n / maxReason) * 100)}%`, backgroundColor: GOLD }} /></div>
                <span className="text-[12px] font-extrabold text-right tabular-nums" style={{ color: NAVY }}>{fmtQty(r.n)}</span>
              </div>))}
          </div>)}
        {m.top.length > 0 && (
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
            <div className="px-3 pt-2.5 pb-1.5 text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('HỎNG NHIỀU NHẤT', 'MOST LOST')}</div>
            {m.top.map(t => { const it = data.items.find(i => i.kind === 'fin' && i.sku === t.sku); return (
              <div key={t.sku ?? t.name} className="flex items-center gap-2.5 px-3 py-2" style={{ borderTop: `1px solid ${HAIR}` }}>
                <Thumb i={{ kind: 'fin', tmplId: null, sku: t.sku, photo: it?.photo ?? null, name: t.name }} size={34} />
                <span className="flex-1 min-w-0"><span className="block text-[12.5px] font-bold" style={{ color: NAVY }}>{it ? itemName(it) : t.name}</span><span className="block text-[10.5px]" style={{ color: '#9CA3AF' }}>{t.mainReason ?? ''}</span></span>
                <span className="text-right"><span className="block text-[13px] font-black tabular-nums" style={{ color: '#9A3412' }}>{fmtQty(t.n)} {L('cái', 'pcs')}</span>{t.produced > 0 && <span className="block text-[10.5px]" style={{ color: '#6B7280' }}>{((t.n / t.produced) * 100).toFixed(1).replace('.', ',')} %</span>}</span>
              </div>); })}
          </div>)}
        {!m.finPcs && !m.rawReports && !m.testTrials && <div className="bg-white rounded-2xl p-4 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B7280' }}>{L('Chưa có khai báo trong tháng.', 'No loss declared this month yet.')}</div>}
      </>)}

      {draft && (
        <div className="fixed inset-0 z-30 flex items-end justify-center" style={{ backgroundColor: 'rgba(26,44,36,.45)' }} onClick={() => !busy && setDraft(null)}>
          <div className="bg-white w-full max-w-xl rounded-t-2xl p-4 max-h-[90vh] overflow-y-auto space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5">
              <Thumb i={draft.item} size={48} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-extrabold tracking-wide" style={{ color: AMBER }}>{draft.editId ? L('SỬA KHAI BÁO', 'EDIT LOSS') : L('KHAI BÁO HỎNG', 'DECLARE A LOSS')}</div>
                <div className="text-[15px] font-extrabold leading-tight" style={{ color: NAVY }}>{itemName(draft.item)}</div>
                <div className="text-[11px]" style={{ color: '#6B7280' }}>{draft.item.sku ?? ''} · {draft.item.kind === 'fin' && draft.beforeStock === false ? L('Kho Lab', 'Lab stock') : `Room ${TEAM_SHORT[team]?.[lang] ?? team}`}</div>
              </div>
              <button onClick={() => setDraft(null)} aria-label="Close" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: '#F3F4F6' }}><X size={15} /></button>
            </div>

            {draft.item.kind === 'fin' && (
              <div className="space-y-1.5">
                <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('HỎNG LÚC NÀO?', 'WHEN?')}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {([[true, L('Đang sản xuất', 'During production'), L('chưa chuyển kho', 'not yet sent to stock')], [false, L('Sau khi chuyển kho', 'After sent to stock'), L('trong kho Lab', 'in Lab stock')]] as const).map(([v, t, s]) => (
                    <button key={String(v)} onClick={() => setDraft(d => d ? { ...d, beforeStock: v } : d)} className="rounded-xl px-2.5 py-2 text-left"
                      style={draft.beforeStock === v ? { backgroundColor: '#F0F9F4', border: `2px solid ${NAVY}`, color: NAVY } : { backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: NAVY }}>
                      <span className="block text-[12.5px] font-extrabold">{t}</span><span className="block text-[11px] opacity-75">{s}</span>
                    </button>))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('BAO NHIÊU?', 'HOW MUCH?')}</div>
              <div className="flex items-center gap-2.5">
                <button onClick={() => setDraft(d => d ? { ...d, qty: Math.max(step, Math.round((d.qty - step) * 1000) / 1000) } : d)} className="w-12 h-12 rounded-xl text-2xl font-extrabold" style={{ border: `1px solid ${BORDER}`, color: NAVY }}>−</button>
                <div className="flex-1 text-center rounded-xl py-1.5" style={{ backgroundColor: PALE, border: '1px solid #F3D58A' }}>
                  <input inputMode="decimal" value={fmtQty(draft.qty)} onChange={e => { const v = Number(e.target.value.replace(',', '.')); if (Number.isFinite(v) && v >= 0) setDraft(d => d ? { ...d, qty: v } : d); }}
                    className="w-full text-center bg-transparent outline-none text-[26px] font-black" style={{ color: NAVY }} />
                  <div className="text-[11px] font-semibold" style={{ color: '#9C8F6A' }}>{unitLabel(draft.item.uom)}</div>
                </div>
                <button onClick={() => setDraft(d => d ? { ...d, qty: Math.round((d.qty + step) * 1000) / 1000 } : d)} className="w-12 h-12 rounded-xl text-2xl font-extrabold" style={{ border: `1px solid ${BORDER}`, color: NAVY }}>+</button>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {quick.map(v => <button key={v} onClick={() => setDraft(d => d ? { ...d, qty: v } : d)} className="rounded-xl py-2 text-[12.5px] font-extrabold"
                  style={Math.abs(draft.qty - v) < 0.0001 ? { backgroundColor: NAVY, color: '#fff' } : { border: `1px solid ${BORDER}`, color: NAVY }}>{fmtQty(v)}</button>)}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#9C8F6A' }}>{L('LÝ DO?', 'WHY?')}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {reasons.map(r => { const on = draft.reasonId === r.id; return (
                  <button key={r.id} onClick={() => setDraft(d => d ? { ...d, reasonId: r.id } : d)} className="text-left rounded-xl px-2.5 py-2 min-h-[46px]"
                    style={on ? { backgroundColor: AMBER, color: '#fff', border: `1px solid ${AMBER}` } : { backgroundColor: '#fff', color: NAVY, border: `1px solid ${BORDER}` }}>
                    <span className="block text-[12.5px] font-extrabold">{r.vi}</span>{lang === 'en' && <span className="block text-[10.5px] opacity-75">{r.en}</span>}
                  </button>); })}
              </div>
            </div>

            <div className="flex gap-2">
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => pickPhoto(e.target.files?.[0])} />
              <button onClick={() => fileRef.current?.click()} disabled={busy} className="flex-1 min-h-[46px] rounded-xl text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5"
                style={draft.photoUrl ? { border: '1px solid #A7D4B8', backgroundColor: '#F0F9F4', color: '#2D6A4F' } : { border: `1px dashed ${GOLD}`, backgroundColor: PALE, color: GOLD_TEXT }}>
                <Camera size={14} />{draft.photoUrl ? L('Có ảnh ✓', 'Photo ✓') : L('Ảnh (tuỳ chọn)', 'Photo (optional)')}</button>
              <input value={draft.note} onChange={e => setDraft(d => d ? { ...d, note: e.target.value } : d)} maxLength={200} placeholder={L('Ghi chú (tuỳ chọn)', 'Note (optional)')}
                className="flex-[1.3] min-w-0 rounded-xl px-3 text-[13px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
            </div>

            {msg && !msg.ok && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{msg.text}</div>}
            <button disabled={!canConfirm} onClick={confirm} className="w-full rounded-2xl py-3.5 text-[14.5px] font-extrabold disabled:opacity-100"
              style={canConfirm ? { backgroundColor: AMBER, color: '#fff' } : { backgroundColor: '#E5E7EB', color: '#9CA3AF' }}>
              {busy ? <Loader2 size={15} className="animate-spin inline" /> : draft.editId ? L('Lưu thay đổi', 'Save change') : `${L('Khai báo hỏng', 'Declare loss')} · ${fmtQty(draft.qty)} ${unitLabel(draft.item.uom)}`}
            </button>
            <div className="text-[11px] text-center leading-snug" style={{ color: '#9C8F6A' }}>{data.odooOn ? L(`Gửi lên Odoo sau khi ${leads} duyệt.`, `Goes to Odoo once ${leads} validates.`) : L(`${leads} duyệt · Odoo tạm tắt (giai đoạn thử).`, `${leads} validates · Odoo off (test phase).`)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
