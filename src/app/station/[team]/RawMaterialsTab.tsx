'use client';
// "Nguyên liệu" station tab (Axel, 2026-10-08) — test phase on team Hưng only. Two modes:
//   Lấy từ kho : the chef records what he takes from the main storage (replaces the paper slip).
//                Recorded at once; the storage manager only corrects if needed.
//   Đặt mua    : purchase request to the purchasing team (quantities only, never prices), plus
//                "new product" with a photo, and the follow-up of the team's own requests.
// Phase 1: nothing is written to Odoo.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Minus, Plus, Search, Check, Package, ShoppingBag, Upload, Loader2, X, User, CheckCircle2 } from 'lucide-react';
import { RAW_TYPES, subLabel, typeLabel, rawName, fmtQty, vnDayTime, type RawMaterial, type RawType, type PurchaseLine, type Withdrawal } from '@/lib/raw-materials';
import { Track } from '@/components/raw/PurchaseTrack';
import {
  getRawCatalogForChefAction, recordWithdrawalAction, getTeamWithdrawalsTodayAction, submitPurchaseRequestAction,
  getTeamRequestsAction, uploadRawPhotoAction,
} from './raw-actions';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318';
const NAME_KEY = 'lab_raw_name';
type CartLine = { tmplId: number; qty: number; brand: string; strict: boolean; note: string };
type NewItem = { name: string; qty: number; uom: string; note: string; photoUrl: string | null };

async function compressImage(file: File): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1280; const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return await new Promise<Blob>(res => c.toBlob(b => res(b!), 'image/jpeg', 0.82));
}

export default function RawMaterialsTab({ team, lang, userName }: { team: string; lang: 'vi' | 'en'; userName: string | null }) {
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [mode, setMode] = useState<'take' | 'request'>('take');
  const [items, setItems] = useState<RawMaterial[] | null>(null);
  const [type, setType] = useState<'all' | RawType>('all');
  const [sub, setSub] = useState<string>('all');
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [editName, setEditName] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // take
  const [qty, setQty] = useState<Record<number, number>>({});
  const [unit, setUnit] = useState<Record<number, number>>({});
  const [sheet, setSheet] = useState<null | 'take' | 'cart' | 'new'>(null);
  const [today, setToday] = useState<Withdrawal[]>([]);
  // request
  const [cart, setCart] = useState<CartLine[]>([]);
  const [newItems, setNewItems] = useState<NewItem[]>([]);
  const [draft, setDraft] = useState<NewItem>({ name: '', qty: 1, uom: 'kg', note: '', photoUrl: null });
  const [uploading, setUploading] = useState(false);
  const [mine, setMine] = useState<PurchaseLine[]>([]);
  const [days, setDays] = useState(30);
  // Axel, 2026-10-08: "il faut scroller tout en bas de la liste pour voir l'historique, c'est pas
  // pratique" — the list and the history are two views of each mode, switched at the top.
  const [view, setView] = useState<'list' | 'history'>('list');

  useEffect(() => {
    try { setName(localStorage.getItem(NAME_KEY) || userName || ''); } catch { setName(userName || ''); }
    getRawCatalogForChefAction().then(r => setItems(r.items ?? []));
  }, [userName]);
  const loadToday = useCallback(() => getTeamWithdrawalsTodayAction(team).then(r => setToday(r.items ?? [])), [team]);
  const loadMine = useCallback(() => getTeamRequestsAction(team, days).then(r => setMine(r.items ?? [])), [team, days]);
  useEffect(() => { loadToday(); }, [loadToday]);
  useEffect(() => { loadMine(); }, [loadMine]);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 3500); return () => clearTimeout(t); }, [msg]);
  function saveName(v: string) { setName(v); try { localStorage.setItem(NAME_KEY, v); } catch {} }

  const byId = useMemo(() => new Map((items ?? []).map(m => [m.tmplId, m])), [items]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items ?? []).filter(m => (type === 'all' || m.type === type) && (sub === 'all' || m.sub === sub)
      && (!s || m.name.toLowerCase().includes(s) || (m.nameVi ?? '').toLowerCase().includes(s) || (m.sku ?? '').toLowerCase().includes(s)))
      .sort((a, b) => rawName(a, lang).localeCompare(rawName(b, lang), lang === 'vi' ? 'vi' : 'en'));
  }, [items, type, sub, q, lang]);
  // Lines already saved keep the Odoo name of the day; show them in the screen's language when the product is known.
  const lineName = (l: { tmplId: number | null; name: string }) => { const m = l.tmplId != null ? byId.get(l.tmplId) : undefined; return m ? rawName(m, lang) : l.name; };
  const toBase = (m: RawMaterial, n: number) => { const u = unit[m.tmplId] ?? -1; return u >= 0 && m.packs[u] ? n * m.packs[u].factor : n; };
  const unitLabel = (m: RawMaterial) => { const u = unit[m.tmplId] ?? -1; return u >= 0 && m.packs[u] ? m.packs[u].label : m.uom; };
  const picked = Object.entries(qty).filter(([, v]) => v > 0).map(([k, v]) => ({ m: byId.get(Number(k))!, n: v })).filter(x => x.m);

  async function confirmTake() {
    if (!name.trim()) { setEditName(true); setMsg({ ok: false, text: L('Nhập tên người lấy trước.', 'Enter who is taking first.') }); return; }
    setBusy(true);
    const res = await recordWithdrawalAction(team, name.trim(), picked.map(({ m, n }) => {
      const u = unit[m.tmplId] ?? -1;
      return { tmplId: m.tmplId, qty: toBase(m, n), packLabel: u >= 0 ? m.packs[u]?.label ?? null : null, packCount: u >= 0 ? n : null };
    }));
    setBusy(false);
    if (res.error) { setMsg({ ok: false, text: res.error }); return; }
    setQty({}); setUnit({}); setSheet(null); setView('history');
    setMsg({ ok: true, text: L(`Đã ghi phiếu #${res.no}.`, `Slip #${res.no} recorded.`) });
    loadToday();
  }
  async function sendRequest() {
    if (!name.trim()) { setEditName(true); setMsg({ ok: false, text: L('Nhập tên người yêu cầu trước.', 'Enter your name first.') }); return; }
    setBusy(true);
    const res = await submitPurchaseRequestAction(team, name.trim(),
      cart.filter(c => c.qty > 0).map(c => ({ tmplId: c.tmplId, qty: c.qty, brand: c.brand || null, brandStrict: c.strict, note: c.note || null })),
      newItems.map(n => ({ name: n.name, qty: n.qty, uom: n.uom, note: n.note || null, photoUrl: n.photoUrl })));
    setBusy(false);
    if (res.error) { setMsg({ ok: false, text: res.error }); return; }
    const n = cart.length + newItems.length;
    setCart([]); setNewItems([]); setSheet(null); setView('history');
    setMsg({ ok: true, text: L(`Đã gửi ${n} dòng cho bộ phận mua hàng.`, `${n} lines sent to purchasing.`) });
    loadMine();
  }
  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const blob = await compressImage(file);
      const fd = new FormData(); fd.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      const r = await uploadRawPhotoAction(fd);
      if (r.error) setMsg({ ok: false, text: r.error }); else setDraft(d => ({ ...d, photoUrl: r.url! }));
    } catch { setMsg({ ok: false, text: L('Không tải được ảnh.', 'Could not upload the photo.') }); }
    setUploading(false);
  }

  const chip = (on: boolean) => ({ backgroundColor: on ? NAVY : '#fff', color: on ? '#fff' : NAVY, border: `1px solid ${on ? NAVY : BORDER}` });
  const chipSm = (on: boolean) => ({ backgroundColor: on ? PALE : '#fff', color: on ? GOLD_TEXT : '#344054', border: `1px solid ${on ? GOLD : BORDER}` });
  const inCart = (id: number) => cart.some(c => c.tmplId === id);
  const pending = mine.filter(l => l.status === 'pending');
  const ordered = mine.filter(l => l.status === 'ordered' || l.status === 'received');
  const cancelled = mine.filter(l => l.status === 'cancelled');

  return (
    <div className="space-y-3 pb-24">
      <div className="grid grid-cols-2 gap-1 bg-white rounded-xl p-1" style={{ border: `1px solid ${BORDER}` }}>
        {([['take', L('Lấy từ kho', 'Take from storage'), Package], ['request', L('Đặt mua', 'Request purchase'), ShoppingBag]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setMode(k)} className="inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-extrabold"
            style={{ backgroundColor: mode === k ? NAVY : 'transparent', color: mode === k ? '#fff' : '#6B7280' }}><Icon size={15} /> {label}</button>
        ))}
      </div>
      <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-2 text-[12.5px]" style={{ border: `1px solid ${BORDER}` }}>
        <User size={14} style={{ color: '#9CA3AF' }} />
        <span style={{ color: '#6B7280' }}>{mode === 'take' ? L('Người lấy', 'Taken by') : L('Người yêu cầu', 'Requested by')}</span>
        {editName ? <input autoFocus value={name} onChange={e => saveName(e.target.value)} onBlur={() => setEditName(false)} className="flex-1 font-bold outline-none" placeholder={L('Tên của bạn', 'Your name')} />
          : <><b className="flex-1">{name || '—'}</b><button onClick={() => setEditName(true)} className="text-xs font-extrabold" style={{ color: GOLD_TEXT }}>{L('Đổi', 'Change')}</button></>}
      </div>

      {msg && <div className="rounded-xl px-3 py-2.5 text-[12.5px] font-semibold flex items-center gap-2" style={{ backgroundColor: msg.ok ? '#EAF6EC' : '#FBEAE8', color: msg.ok ? '#067647' : LATE }}>{msg.ok && <CheckCircle2 size={15} />}{msg.text}</div>}

      <div className="flex gap-1.5">
        {([['list', L('Chọn nguyên liệu', 'Pick items'), null],
           ['history', mode === 'take' ? L('Phiếu lấy hôm nay', "Today's slips") : L('Yêu cầu của team', "Team's requests"), mode === 'take' ? today.length : mine.length]] as const).map(([k, label, n]) => (
          <button key={k} onClick={() => setView(k)} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 text-[12.5px] font-extrabold"
            style={{ backgroundColor: view === k ? PALE : '#fff', color: view === k ? GOLD_TEXT : '#6B7280', border: `1.5px solid ${view === k ? GOLD : BORDER}` }}>
            {label}
            {n != null && <span className="rounded-full px-1.5 text-[11px] tabular-nums" style={{ backgroundColor: view === k ? GOLD : '#F2F4F7', color: view === k ? '#fff' : '#344054' }}>{n}</span>}
          </button>
        ))}
      </div>

      {view === 'list' && (<>

      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {(['all', 'dry', 'fresh', 'frozen'] as const).map(t => (
          <button key={t} onClick={() => { setType(t); setSub('all'); }} className="flex-shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-bold" style={chip(type === t)}>{t === 'all' ? L('Tất cả', 'All') : typeLabel(t, lang)}</button>))}
      </div>
      {type !== 'all' && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          {['all', ...Object.keys(RAW_TYPES[type].subs)].map(s => (
            <button key={s} onClick={() => setSub(s)} className="flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-bold" style={chipSm(sub === s)}>{s === 'all' ? L('Tất cả nhóm', 'All groups') : subLabel(type, s, lang)}</button>))}
        </div>
      )}
      <label className="flex items-center gap-2 bg-white rounded-xl px-3" style={{ border: `1px solid ${BORDER}` }}>
        <Search size={14} style={{ color: '#9CA3AF' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nguyên liệu hoặc mã…', 'Search a raw material or code…')} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
      </label>
      {mode === 'request' && (
        <button onClick={() => { setDraft({ name: '', qty: 1, uom: 'kg', note: '', photoUrl: null }); setSheet('new'); }} className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-bold" style={{ border: `1.5px dashed ${BORDER}`, color: GOLD_TEXT }}>
          <Plus size={15} /> {L('Sản phẩm mới (chưa có trong danh sách)', 'New product (not in the list)')}</button>
      )}

      {!items ? <div className="text-center py-8 text-sm" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>
        : !items.length ? <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Danh mục nguyên liệu chưa sẵn sàng — bộ phận mua hàng cần đồng bộ từ Odoo.', 'The raw material list is not ready yet — purchasing needs to sync it from Odoo.')}</div>
        : (
        <div className="bg-white rounded-2xl px-3" style={{ border: `1px solid ${BORDER}` }}>
          {rows.slice(0, 200).map(m => {
            const n = qty[m.tmplId] ?? 0; const u = unit[m.tmplId] ?? -1;
            return (
              <div key={m.tmplId} className="flex items-center gap-2.5 py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-bold leading-snug">{rawName(m, lang)}</div>
                  <div className="text-[10.5px] mt-0.5" style={{ color: '#9CA3AF' }}>{subLabel(m.type, m.sub, lang)} · {m.sku ?? '—'}{mode === 'request' ? ` · ${m.uom}` : ''}</div>
                  {mode === 'take' && m.packs.length > 0 && (
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {[-1, ...m.packs.map((_, i) => i)].map(i => (
                        <button key={i} onClick={() => setUnit(s => ({ ...s, [m.tmplId]: i }))} className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5"
                          style={{ border: `1px solid ${u === i ? GOLD : HAIR}`, backgroundColor: u === i ? PALE : '#fff', color: u === i ? GOLD_TEXT : '#6B7280' }}>{i < 0 ? m.uom : m.packs[i].label}</button>))}
                    </div>
                  )}
                </div>
                {mode === 'take' ? (
                  <div className="text-center flex-none">
                    <div className="flex items-center rounded-lg overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
                      <button onClick={() => setQty(s => ({ ...s, [m.tmplId]: Math.max(0, (s[m.tmplId] ?? 0) - 1) }))} className="w-9 h-9 flex items-center justify-center" style={{ color: NAVY }}><Minus size={15} /></button>
                      <input inputMode="decimal" value={n ? fmtQty(n) : ''} placeholder="0" onChange={e => { const v = parseFloat(e.target.value.replace(',', '.')); setQty(s => ({ ...s, [m.tmplId]: isNaN(v) ? 0 : Math.max(0, v) })); }}
                        className="w-12 h-9 text-center font-extrabold text-[13.5px] outline-none tabular-nums" style={{ borderLeft: `1px solid ${HAIR}`, borderRight: `1px solid ${HAIR}` }} />
                      <button onClick={() => setQty(s => ({ ...s, [m.tmplId]: (s[m.tmplId] ?? 0) + 1 }))} className="w-9 h-9 flex items-center justify-center" style={{ color: NAVY }}><Plus size={15} /></button>
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#9CA3AF' }}>{unitLabel(m)}</div>
                  </div>
                ) : (
                  <button onClick={() => setCart(c => inCart(m.tmplId) ? c.filter(x => x.tmplId !== m.tmplId) : [...c, { tmplId: m.tmplId, qty: 1, brand: '', strict: false, note: '' }])}
                    className="flex-none inline-flex items-center gap-1 rounded-lg px-3 py-2 text-[12.5px] font-extrabold" style={inCart(m.tmplId) ? { backgroundColor: NAVY, color: '#fff' } : { border: `1px solid ${NAVY}`, color: NAVY }}>
                    {inCart(m.tmplId) ? <><Check size={13} /> {L('Đã thêm', 'Added')}</> : <><Plus size={13} /> {L('Thêm', 'Add')}</>}
                  </button>
                )}
              </div>
            );
          })}
          {!rows.length && <div className="py-4 text-center text-xs" style={{ color: '#9CA3AF' }}>{L('Không tìm thấy', 'Nothing found')}</div>}
          {rows.length > 200 && <div className="py-2 text-center text-xs" style={{ color: '#9CA3AF' }}>{L('Dùng tìm kiếm để xem thêm', 'Use the search to see more')}</div>}
        </div>
      )}

      </>)}

      {view === 'history' && (mode === 'take' ? (
        <>
          <div className="flex justify-between items-baseline px-1 pt-1"><b className="text-[13px]">{L('Phiếu lấy hôm nay', 'Today\'s withdrawals')}</b><span className="text-[11.5px]" style={{ color: '#6B7280' }}>{today.length}</span></div>
          <div className="bg-white rounded-2xl px-3" style={{ border: `1px solid ${BORDER}` }}>
            {!today.length && <div className="py-4 text-center text-xs" style={{ color: '#9CA3AF' }}>{L('Chưa có phiếu nào hôm nay.', 'No withdrawal today yet.')}</div>}
            {today.map(w => (
              <div key={w.id} className="py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                <div className="flex items-baseline gap-2"><b className="text-[13px] tabular-nums">#{w.no}</b><span className="text-[11.5px] flex-1" style={{ color: '#6B7280' }}>{vnDayTime(w.createdAt).time} · {w.takenBy}</span>
                  {w.lines.some(l => l.correctedQty != null) ? <span className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F2F4F7', color: '#344054' }}>{L('Kho đã sửa', 'Corrected')}</span>
                    : <span className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#ECFDF3', color: '#067647' }}>{L('Đã ghi', 'Recorded')}</span>}</div>
                <div className="text-[12px] mt-1 leading-relaxed">{w.lines.map((l, i) => <span key={l.id}>{i > 0 && ' · '}{lineName(l)} <b>{fmtQty(l.correctedQty ?? l.qty)} {l.uom}</b>{l.correctedQty != null && <span className="line-through ml-1" style={{ color: '#9CA3AF' }}>{fmtQty(l.qty)}</span>}</span>)}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {([[L('Đang chờ', 'Waiting'), pending], [L('Đã đặt', 'Ordered'), ordered], [L('Đã huỷ', 'Cancelled'), cancelled]] as const).map(([title, ls]) => ls.length ? (
            <div key={title} className="space-y-2">
              <div className="flex justify-between items-baseline px-1 pt-1"><b className="text-[13px]">{title}</b><span className="text-[11.5px]" style={{ color: '#6B7280' }}>{ls.length}</span></div>
              {ls.map(l => (
                <div key={l.id} className="bg-white rounded-xl px-3 py-2.5" style={{ border: `1px solid ${BORDER}` }}>
                  <div className="flex items-baseline gap-2"><b className="flex-1 text-[13px]">{lineName(l)}</b><b className="tabular-nums text-[13px]">{fmtQty(l.qty)} {l.uom}</b></div>
                  <div className="text-[11px] mb-2" style={{ color: '#6B7280' }}>{vnDayTime(l.createdAt).day} {vnDayTime(l.createdAt).time} · {l.requestedBy}{l.poRef ? ` · PO ${l.poRef}` : ''}{l.brand ? ` · ${l.brand}` : ''}</div>
                  <Track l={l} L={L} />
                </div>
              ))}
            </div>
          ) : null)}
          {!mine.length && <div className="text-center text-xs py-3" style={{ color: '#9CA3AF' }}>{L('Chưa có yêu cầu nào trong thời gian này.', 'No request in this period.')}</div>}
          <button onClick={() => setDays(d => d + 60)} className="w-full rounded-xl py-2.5 text-[12.5px] font-extrabold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L(`Xem thêm (hiện ${days} ngày)`, `Show more (showing ${days} days)`)}</button>
        </>
      ))}

      {/* Bottom bar */}
      {mode === 'take' && picked.length > 0 && !sheet && (
        <button onClick={() => setSheet('take')} className="fixed left-3 right-3 bottom-3 z-20 rounded-2xl px-4 py-3 flex items-center gap-3 text-white shadow-lg max-w-xl mx-auto" style={{ backgroundColor: NAVY }}>
          <b className="flex-1 text-left text-[13.5px]">{picked.length} {L('nguyên liệu', 'items')}</b><span className="text-[13px] font-extrabold" style={{ color: '#F0D98A' }}>{L('Ghi phiếu lấy', 'Record withdrawal')} ›</span></button>
      )}
      {mode === 'request' && (cart.length + newItems.length) > 0 && !sheet && (
        <button onClick={() => setSheet('cart')} className="fixed left-3 right-3 bottom-3 z-20 rounded-2xl px-4 py-3 flex items-center gap-3 text-white shadow-lg max-w-xl mx-auto" style={{ backgroundColor: NAVY }}>
          <b className="flex-1 text-left text-[13.5px]">{cart.length + newItems.length} {L('dòng', 'lines')}</b><span className="text-[13px] font-extrabold" style={{ color: '#F0D98A' }}>{L('Gửi yêu cầu', 'Send request')} ›</span></button>
      )}

      {sheet && (
        <div className="fixed inset-0 z-30 flex items-end justify-center" style={{ backgroundColor: 'rgba(26,44,36,.45)' }} onClick={() => setSheet(null)}>
          <div className="bg-white w-full max-w-xl rounded-t-2xl p-4 max-h-[88vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            {sheet === 'take' && (<>
              <div className="text-[15px] font-extrabold">{L('Xác nhận phiếu lấy', 'Confirm withdrawal')}</div>
              <div className="text-xs mb-2" style={{ color: '#6B7280' }}>{name} · {L('hôm nay', 'today')}</div>
              {picked.map(({ m, n }) => { const u = unit[m.tmplId] ?? -1; return (
                <div key={m.tmplId} className="flex justify-between gap-3 py-2 text-[13px]" style={{ borderTop: `1px solid ${HAIR}` }}><span>{rawName(m, lang)}</span>
                  <b className="whitespace-nowrap tabular-nums">{u >= 0 ? `${fmtQty(n)} × ${m.packs[u].label}` : `${fmtQty(n)} ${m.uom}`}{u >= 0 && <span className="font-semibold" style={{ color: '#9CA3AF' }}> = {fmtQty(toBase(m, n))} {m.uom}</span>}</b></div>); })}
              <div className="rounded-xl px-3 py-2 text-xs mt-2" style={{ backgroundColor: PALE, color: GOLD_TEXT, border: `1px solid ${BORDER}` }}>{L('Phiếu được ghi ngay. Kho chỉ sửa nếu số lượng thực tế khác.', 'Recorded at once. Storage only corrects it if the real quantity differs.')}</div>
              <button disabled={busy} onClick={confirmTake} className="w-full mt-3 rounded-xl py-3 font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Xác nhận', 'Confirm')}</button>
              <button onClick={() => setSheet(null)} className="w-full mt-2 rounded-xl py-2.5 font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L('Sửa lại', 'Go back')}</button>
            </>)}
            {sheet === 'cart' && (<>
              <div className="text-[15px] font-extrabold">{L('Yêu cầu mua', 'Purchase request')}</div>
              <div className="text-xs mb-2" style={{ color: '#6B7280' }}>{name} · {L('không hiển thị giá', 'prices are not shown')}</div>
              {cart.map((c, i) => { const m = byId.get(c.tmplId); if (!m) return null; const upd = (p: Partial<CartLine>) => setCart(xs => xs.map((x, j) => j === i ? { ...x, ...p } : x)); return (
                <div key={c.tmplId} className="py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                  <div className="flex items-center gap-2"><b className="flex-1 text-[13px]">{rawName(m, lang)}</b>
                    <div className="flex items-center rounded-lg overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
                      <button onClick={() => upd({ qty: Math.max(0, c.qty - 1) })} className="w-8 h-8 flex items-center justify-center"><Minus size={13} /></button>
                      <input inputMode="decimal" value={fmtQty(c.qty)} onChange={e => { const v = parseFloat(e.target.value.replace(',', '.')); upd({ qty: isNaN(v) ? 0 : Math.max(0, v) }); }} className="w-12 h-8 text-center font-extrabold text-[13px] outline-none" />
                      <button onClick={() => upd({ qty: c.qty + 1 })} className="w-8 h-8 flex items-center justify-center"><Plus size={13} /></button>
                    </div><span className="text-[11.5px] w-6" style={{ color: '#6B7280' }}>{m.uom}</span>
                    <button onClick={() => setCart(xs => xs.filter((_, j) => j !== i))} style={{ color: '#9CA3AF' }}><X size={14} /></button></div>
                  <div className="flex gap-1.5 items-center mt-1.5 flex-wrap">
                    <input value={c.brand} onChange={e => upd({ brand: e.target.value })} placeholder={L('Thương hiệu mong muốn (tuỳ chọn)', 'Preferred brand (optional)')} className="flex-1 min-w-[150px] rounded-lg px-2 py-1.5 text-xs outline-none" style={{ border: `1px solid ${HAIR}` }} />
                    <div className="flex rounded-lg overflow-hidden text-[11px] font-bold" style={{ border: `1px solid ${HAIR}` }}>
                      <button onClick={() => upd({ strict: false })} className="px-2 py-1.5" style={{ backgroundColor: !c.strict ? PALE : '#fff', color: !c.strict ? GOLD_TEXT : '#6B7280' }}>{L('Nếu có', 'If possible')}</button>
                      <button onClick={() => upd({ strict: true })} className="px-2 py-1.5" style={{ backgroundColor: c.strict ? PALE : '#fff', color: c.strict ? GOLD_TEXT : '#6B7280' }}>{L('Bắt buộc', 'Required')}</button></div>
                  </div>
                  <input value={c.note} onChange={e => upd({ note: e.target.value })} placeholder={L('Ghi chú cho bộ phận mua hàng', 'Note for purchasing')} className="w-full mt-1.5 rounded-lg px-2 py-1.5 text-xs outline-none" style={{ border: `1px solid ${HAIR}` }} />
                </div>); })}
              {newItems.map((n, i) => (
                <div key={i} className="py-2.5 flex items-center gap-2" style={{ borderTop: `1px solid ${HAIR}` }}>
                  {n.photoUrl ? <img src={n.photoUrl} alt="" className="w-10 h-10 rounded-lg object-cover" /> : <div className="w-10 h-10 rounded-lg" style={{ backgroundColor: PALE }} />}
                  <div className="flex-1 text-[13px]"><b>{n.name}</b> <span className="text-[10px] font-extrabold rounded px-1" style={{ backgroundColor: '#F2F4F7' }}>{L('MỚI', 'NEW')}</span><div className="text-[11.5px]" style={{ color: '#6B7280' }}>{fmtQty(n.qty)} {n.uom}{n.note ? ` · ${n.note}` : ''}</div></div>
                  <button onClick={() => setNewItems(xs => xs.filter((_, j) => j !== i))} style={{ color: '#9CA3AF' }}><X size={14} /></button>
                </div>))}
              <button disabled={busy} onClick={sendRequest} className="w-full mt-3 rounded-xl py-3 font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Gửi cho bộ phận mua hàng', 'Send to purchasing')}</button>
              <button onClick={() => setSheet(null)} className="w-full mt-2 rounded-xl py-2.5 font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L('Tiếp tục chọn', 'Keep adding')}</button>
            </>)}
            {sheet === 'new' && (<>
              <div className="text-[15px] font-extrabold">{L('Sản phẩm mới', 'New product')}</div>
              <div className="text-xs mb-2" style={{ color: '#6B7280' }}>{L('Bộ phận mua hàng sẽ tìm hoặc tạo sản phẩm trước khi đặt.', 'Purchasing finds or creates it before ordering.')}</div>
              <label className="block mt-2"><span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Tên sản phẩm', 'Product name')}</span>
                <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
              <label className="mt-2 flex items-center gap-3 rounded-xl p-2.5 cursor-pointer" style={{ border: `1.5px dashed ${BORDER}`, color: GOLD_TEXT }}>
                {draft.photoUrl ? <img src={draft.photoUrl} alt="" className="w-12 h-12 rounded-lg object-cover" /> : uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                <span className="text-[13px] font-bold">{draft.photoUrl ? L('Đã có ảnh · đổi', 'Photo added · change') : L('Chụp hoặc chọn ảnh', 'Take or choose a photo')}</span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => pickPhoto(e.target.files?.[0])} />
              </label>
              <div className="flex gap-2 mt-2">
                <label className="flex-1"><span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Số lượng', 'Quantity')}</span>
                  <input inputMode="decimal" value={draft.qty ? String(draft.qty) : ''} onChange={e => { const v = parseFloat(e.target.value.replace(',', '.')); setDraft(d => ({ ...d, qty: isNaN(v) ? 0 : v })); }} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
                <label className="w-28"><span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Đơn vị', 'Unit')}</span>
                  <select value={draft.uom} onChange={e => setDraft(d => ({ ...d, uom: e.target.value }))} className="w-full rounded-lg px-2 py-2 text-[13.5px] bg-white" style={{ border: `1px solid ${BORDER}` }}><option>kg</option><option>L</option><option value="Unit">{L('Cái', 'Unit')}</option></select></label>
              </div>
              <label className="block mt-2"><span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Ghi chú', 'Note')}</span>
                <textarea value={draft.note} onChange={e => setDraft(d => ({ ...d, note: e.target.value }))} placeholder={L('Dùng cho món nào, loại nào…', 'What for, which kind…')} className="w-full rounded-lg px-3 py-2 text-[13.5px] outline-none min-h-[60px]" style={{ border: `1px solid ${BORDER}` }} /></label>
              <button disabled={!draft.name.trim() || !(draft.qty > 0) || uploading} onClick={() => { setNewItems(xs => [...xs, draft]); setSheet('cart'); }} className="w-full mt-3 rounded-xl py-3 font-extrabold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>{L('Thêm vào yêu cầu', 'Add to the request')}</button>
              <button onClick={() => setSheet(null)} className="w-full mt-2 rounded-xl py-2.5 font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L('Huỷ', 'Cancel')}</button>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}
