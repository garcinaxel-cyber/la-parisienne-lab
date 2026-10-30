'use client';
// "Kiểm kê room" — the team counts its own room (Axel, 2026-10-20). Phase 1: kept in the app only.
//   * one session per room = one cut-off for the whole room (never one count per product);
//   * several people count at the same time: each save is its own entry (id made here, so a double tap
//     or a resend never makes a second one), the product total is the sum, and every phone sees the
//     others' entries live (Realtime broadcast + a 20 s refresh as a safety net);
//   * leaving the screen loses nothing: entries are saved at once, unsent ones wait on the phone and go
//     out when the network is back, the quantity being typed is kept too;
//   * units: typed in the catalogue unit, g / ml, a pack (bao 25 kg…) or pieces (eggs), stored in the
//     catalogue unit like the withdrawal slips;
//   * a listed product nobody counts is left out of the count with a reason; "= 0" is said explicitly;
//     the team lead confirms.
import ItemPhoto from '@/components/raw/ItemPhoto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Check, Loader2, ClipboardCheck, AlertTriangle, Trash2, AlertCircle, Plus, ChevronDown, ChevronRight, Camera } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import { RAW_TYPES, fmtQty, vnDayTime, pieceUnit, type RawMaterial, type RawType } from '@/lib/raw-materials';
import { LEFT_OUT_REASONS, FREE_UNITS, lineTotal, unitAlert, type RoomCountState, type RoomEntry, type RoomLine, type LeftOutReason } from '@/lib/room-count';
import { getRoomCountAction, openRoomCountAction, saveRoomEntryAction, deleteRoomEntryAction, setLeftOutReasonAction, confirmRoomCountAction, saveFreeItemAction, deleteFreeItemAction, searchCountCatalogAction, type EntryInput } from './room-count-actions';
import { uploadRawPhotoAction } from './raw-actions';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318', OK = '#067647', OKBG = '#EAF6EC';
type Unit = { label: string; factor: number };   // factor = catalogue units in one typed unit
type Draft = { tmplId: number; txt: string; unit: number; mode: 'add' | 'correct' };
type Queued = EntryInput & { name: string };

const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const lsGet = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d; } catch { return d; } };
const lsSet = (k: string, v: unknown) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
const parseQty = (t: string) => { const v = parseFloat(t.replace(/\s+/g, '').replace(',', '.')); return isNaN(v) ? 0 : Math.max(0, v); };

export default function RoomCountPanel({ team, lang, items }: { team: string; lang: 'vi' | 'en'; items: RawMaterial[] | null }) {
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [st, setSt] = useState<RoomCountState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'summary'>('list');
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dup, setDup] = useState<EntryInput | null>(null);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [offline, setOffline] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openDup, setOpenDup] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const chan = useRef<any>(null);
  const sid = st?.session?.id ?? null;
  const qKey = sid ? `room_q_${sid}` : null, dKey = sid ? `room_draft_${sid}` : null;

  const load = useCallback(async () => {
    try { const r = await getRoomCountAction(team); if (r.error) setErr(r.error); else if (r.state) { setSt(r.state); setErr(null); } }
    catch { setOffline(true); }
  }, [team]);
  useEffect(() => { load(); }, [load]);

  // Live: a teammate's save is broadcast to every phone of the team, which reloads; plus a 20 s safety net.
  useEffect(() => {
    const sb = createClient();
    const ch = sb.channel(`room-count-${team}`).on('broadcast', { event: 'changed' }, () => load()).subscribe();
    chan.current = ch;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 20000);
    return () => { clearInterval(t); sb.removeChannel(ch); chan.current = null; };
  }, [team, load]);
  const ping = () => { try { chan.current?.send({ type: 'broadcast', event: 'changed', payload: {} }); } catch { /* best effort */ } };

  // Restore unsent entries and the quantity being typed when coming back to the count.
  useEffect(() => { if (!qKey || !dKey) return; setQueue(lsGet<Queued[]>(qKey, [])); const d = lsGet<Draft | null>(dKey, null); if (d) setDraft(d); }, [qKey, dKey]);
  useEffect(() => { if (dKey) lsSet(dKey, draft); }, [dKey, draft]);
  useEffect(() => { if (qKey) lsSet(qKey, queue.length ? queue : null); }, [qKey, queue]);

  const flush = useCallback(async () => {
    if (!sid || !queue.length) return;
    const left: Queued[] = [];
    for (const e of queue) {
      try {
        const { name: _n, ...input } = e;
        const r = await saveRoomEntryAction(team, sid, { ...input, force: true });
        if (r.state) setSt(r.state);
        if (r.error) setErr(r.error);
      } catch { left.push(e); }
    }
    setQueue(left); setOffline(left.length > 0);
    if (left.length < queue.length) ping();
  }, [sid, queue, team]);
  useEffect(() => {
    const on = () => flush();
    window.addEventListener('online', on);
    const t = setInterval(() => { if (queue.length) flush(); }, 15000);
    return () => { window.removeEventListener('online', on); clearInterval(t); };
  }, [flush, queue.length]);

  const catById = useMemo(() => new Map((items ?? []).map(m => [m.tmplId, m])), [items]);
  const lineName = useCallback((l: { name: string; nameVi: string | null }) => (lang === 'vi' && l.nameVi ? l.nameVi : l.name), [lang]);
  const unitsFor = useCallback((l: RoomLine): Unit[] => {
    const u = l.uom.toLowerCase(); const out: Unit[] = [{ label: l.uom, factor: 1 }];
    if (u === 'kg') out.push({ label: 'g', factor: 0.001 }); else if (u === 'l') out.push({ label: 'ml', factor: 0.001 });
    for (const p of catById.get(l.tmplId)?.packs ?? []) out.push({ label: p.label, factor: p.factor });
    // Eggs now carry a "quả" pack in the catalogue (2026-10-21) — don't list the piece unit twice.
    const pu = pieceUnit(l.sku); if (pu && !out.some(x => Math.abs(x.factor - pu.kg) < 1e-9)) out.push({ label: L(pu.vi, pu.en), factor: pu.kg });
    return out;
  }, [catById, L]);

  const entries: RoomEntry[] = useMemo(() => {
    const live = st?.entries ?? [];
    const ids = new Set(live.map(e => e.id));
    // unsent entries show at once, marked "waiting"
    return [...live, ...queue.filter(e => !ids.has(e.id)).map(e => ({ id: e.id, tmplId: e.tmplId, qty: e.isZero ? 0 : e.qty, isZero: !!e.isZero,
      packLabel: e.packLabel ?? null, packCount: e.packCount ?? null, countedBy: st?.meId ?? null, countedByName: e.name, createdAt: '', updatedAt: '' }))];
  }, [st, queue]);
  const lines = useMemo(() => st?.lines ?? [], [st]);
  const totals = useMemo(() => new Map(lines.map(l => [l.tmplId, lineTotal(entries, l.tmplId)])), [lines, entries]);
  const nDone = lines.filter(l => totals.get(l.tmplId) && !totals.get(l.tmplId)!.zero).length;
  const nZero = lines.filter(l => totals.get(l.tmplId)?.zero).length;
  const nTodo = lines.length - nDone - nZero;
  const recentNames = useMemo(() => {
    const since = Date.now() - 10 * 60 * 1000;
    return Array.from(new Set((st?.entries ?? []).filter(e => new Date(e.updatedAt).getTime() > since).map(e => e.countedByName).filter(Boolean) as string[]));
  }, [st]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return lines.filter(l => {
      const t = totals.get(l.tmplId);
      if (filter === 'todo' && t) return false;
      if (filter === 'done' && !t) return false;
      return !s || l.name.toLowerCase().includes(s) || (l.nameVi ?? '').toLowerCase().includes(s) || (l.sku ?? '').toLowerCase().includes(s);
    }).sort((a, b) => lineName(a).localeCompare(lineName(b), lang === 'vi' ? 'vi' : 'en'));
  }, [lines, totals, filter, q, lineName, lang]);
  const groups = (['dry', 'fresh', 'frozen'] as RawType[]).map(t => [t, shown.filter(l => (l.type ?? 'dry') === t)] as const).filter(([, ls]) => ls.length);

  async function open() {
    setBusy(true);
    try { const r = await openRoomCountAction(team); if (r.error) setErr(r.error); else if (r.state) { setSt(r.state); ping(); } }
    catch { setErr(L('Mất kết nối, thử lại.', 'Connection lost, try again.')); }
    setBusy(false);
  }

  async function save(input: EntryInput) {
    if (!sid) return;
    setBusy(true); setDup(null);
    try {
      const r = await saveRoomEntryAction(team, sid, input);
      if (r.duplicate) { setDup(input); setBusy(false); return; }
      if (r.error) { setErr(r.error); setBusy(false); return; }
      if (r.state) setSt(r.state);
      setDraft(null); ping();
    } catch {
      // no network: keep it on the phone, it goes out when the connection is back
      setQueue(x => x.some(e => e.id === input.id) ? x : [...x, { ...input, name: L('Bạn', 'You') }]);
      setOffline(true); setDraft(null);
    }
    setBusy(false);
  }
  async function act(p: Promise<{ state?: RoomCountState; error?: string }>) {
    setBusy(true);
    try { const r = await p; if (r.error) setErr(r.error); else if (r.state) { setSt(r.state); ping(); } }
    catch { setErr(L('Mất kết nối, thử lại.', 'Connection lost, try again.')); }
    setBusy(false);
  }

  if (!st) return <div className="text-center py-8 text-sm" style={{ color: '#6B7280' }}>{err ?? L('Đang tải…', 'Loading…')}</div>;

  if (!st.session) return (
    <div className="bg-white rounded-2xl p-4 space-y-3" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-2 font-extrabold" style={{ color: NAVY }}><ClipboardCheck size={18} /> {L('Kiểm kê room của team', "Count the team's room")}</div>
      <p className="text-[12.5px] leading-snug" style={{ color: '#6B7280' }}>
        {L('Cả team đếm cùng lúc trên điện thoại. Thời điểm chốt (cut-off) là lúc bắt đầu. Nguyên liệu không có trong room: bấm "= 0". Trưởng nhóm xác nhận ở cuối.',
          'The whole team counts at the same time on their phones. The cut-off is the moment you start. Items not in the room: tap "= 0". The team lead confirms at the end.')}
      </p>
      {err && <div className="text-[12.5px] font-semibold" style={{ color: LATE }}>{err}</div>}
      <button disabled={busy} onClick={open} className="w-full rounded-xl py-3 font-extrabold text-white disabled:opacity-50" style={{ backgroundColor: NAVY }}>
        {busy ? <Loader2 size={16} className="inline animate-spin" /> : L('Bắt đầu kiểm kê', 'Start the count')}</button>
    </div>
  );

  const s = st.session;
  const cut = vnDayTime(s.cutoffAt);
  const multi = lines.map(l => [l, entries.filter(e => e.tmplId === l.tmplId)] as const).filter(([, es]) => es.length > 1);
  const left = lines.filter(l => !totals.get(l.tmplId));
  const alerts = lines.filter(l => { const t = totals.get(l.tmplId); return t && unitAlert(t.total, l.takenRecent); });

  // ---------- entry sheet ----------
  const dLine = draft ? lines.find(l => l.tmplId === draft.tmplId) ?? null : null;
  const sheet = draft && dLine && (() => {
    const units = unitsFor(dLine);
    const u = units[draft.unit] ?? units[0];
    const n = parseQty(draft.txt);
    const base = Math.round(n * u.factor * 1000) / 1000;
    const es = entries.filter(e => e.tmplId === dLine.tmplId);
    const mine = es.filter(e => e.countedBy === st.meId);
    const cur = lineTotal(entries, dLine.tmplId)?.total ?? 0;
    const myLast = mine[mine.length - 1];
    const newTotal = draft.mode === 'correct' && myLast ? cur - myLast.qty + base : cur + base;
    const warn = unitAlert(newTotal, dLine.takenRecent);
    const mk = (isZero: boolean): EntryInput => ({ id: uuid(), tmplId: dLine.tmplId, qty: isZero ? 0 : base, isZero,
      packLabel: isZero || u.factor === 1 ? null : u.label, packCount: isZero || u.factor === 1 ? null : n, mode: draft.mode });
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,.35)' }} onClick={() => setDraft(null)}>
        <div className="bg-white w-full max-w-md rounded-t-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0"><div className="font-extrabold leading-snug">{lineName(dLine)}</div>
              <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{dLine.sku ?? '—'} · {L('Đơn vị lưu', 'Stored in')}: {dLine.uom}</div></div>
            <button onClick={() => setDraft(null)} className="p-1" style={{ color: '#6B7280' }}><X size={18} /></button>
          </div>
          {es.length > 0 && (
            <div className="rounded-xl p-2.5 space-y-1.5" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}` }}>
              {es.map(e => (
                <div key={e.id} className="flex items-center gap-2 text-[12.5px]">
                  <span className="flex-1 min-w-0 truncate">{e.countedByName ?? '—'}{e.countedBy === st.meId && <b style={{ color: GOLD_TEXT }}> ({L('bạn', 'you')})</b>}
                    <span style={{ color: '#9CA3AF' }}> · {e.createdAt ? vnDayTime(e.createdAt).time : L('chờ gửi', 'waiting')}</span></span>
                  <b className="tabular-nums whitespace-nowrap">{e.isZero ? '= 0' : e.packLabel ? `${fmtQty(e.packCount ?? 0)} × ${e.packLabel}` : `${fmtQty(e.qty)} ${dLine.uom}`}</b>
                  {e.createdAt && (e.countedBy === st.meId || st.canConfirm) && (
                    <button disabled={busy} onClick={() => act(deleteRoomEntryAction(team, s.id, e.id))} className="p-0.5" style={{ color: LATE }} aria-label="delete"><Trash2 size={14} /></button>)}
                </div>))}
              <div className="flex justify-between text-[12.5px] pt-1.5" style={{ borderTop: `1px solid ${BORDER}` }}><b>{L('Tổng hiện tại', 'Total so far')}</b><b className="tabular-nums">{fmtQty(cur)} {dLine.uom}</b></div>
            </div>)}
          {mine.length > 0 && (
            <div className="grid grid-cols-2 rounded-xl overflow-hidden text-[12.5px] font-bold" style={{ border: `1px solid ${HAIR}` }}>
              {(['add', 'correct'] as const).map(m => (
                <button key={m} onClick={() => setDraft({ ...draft, mode: m })} className="py-2" style={{ backgroundColor: draft.mode === m ? PALE : '#fff', color: draft.mode === m ? GOLD_TEXT : '#6B7280' }}>
                  {m === 'add' ? L('Đếm thêm phần khác', 'Add another part') : L('Sửa lượt của tôi', 'Correct my entry')}</button>))}
            </div>)}
          <div className="flex gap-1.5 flex-wrap">
            {units.map((x, i) => (
              <button key={i} onClick={() => setDraft({ ...draft, unit: i })} className="text-[12px] font-bold rounded-lg px-2.5 py-1"
                style={{ border: `1px solid ${draft.unit === i ? GOLD : HAIR}`, backgroundColor: draft.unit === i ? PALE : '#fff', color: draft.unit === i ? GOLD_TEXT : '#6B7280' }}>{x.label}</button>))}
          </div>
          <div className="flex items-baseline gap-2 rounded-xl px-3 py-2" style={{ border: `1.5px solid ${GOLD}` }}>
            <input autoFocus inputMode="decimal" value={draft.txt} placeholder="0" onChange={e => setDraft({ ...draft, txt: e.target.value.replace(/[^0-9.,]/g, '') })}
              className="w-28 text-[26px] font-extrabold outline-none tabular-nums bg-transparent" />
            <span className="text-[13px]" style={{ color: '#6B7280' }}>{u.factor === 1 ? u.label : `× ${u.label}`}</span>
          </div>
          <div className="text-[12px]" style={{ color: '#6B7280' }}>
            = <b style={{ color: '#111' }}>{fmtQty(base)} {dLine.uom}</b> · {L('tổng mới', 'new total')} <b style={{ color: '#111' }}>{fmtQty(newTotal)} {dLine.uom}</b></div>
          {warn && <div className="rounded-xl px-3 py-2 text-[12px] font-semibold flex gap-1.5" style={{ backgroundColor: '#FBEAE8', color: LATE }}><AlertTriangle size={14} className="flex-none mt-0.5" />
            {L(`Cao hơn nhiều so với lượng team lấy 14 ngày qua (${fmtQty(dLine.takenRecent ?? 0)} ${dLine.uom}). Kiểm tra lại đơn vị?`,
              `Much higher than what the team took in the last 14 days (${fmtQty(dLine.takenRecent ?? 0)} ${dLine.uom}). Check the unit?`)}</div>}
          {dup && <div className="rounded-xl p-2.5 space-y-2 text-[12.5px]" style={{ backgroundColor: '#FFF4CC', border: `1.5px solid ${GOLD}` }}>
            <b style={{ color: GOLD_TEXT }}>{L('Bạn vừa lưu đúng số lượng này. Trùng?', 'You just saved this same quantity. Duplicate?')}</b>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => { setDup(null); setDraft(null); }} className="rounded-lg py-2 font-bold" style={{ border: `1px solid ${BORDER}` }}>{L('Trùng, bỏ qua', 'Duplicate, skip')}</button>
              <button onClick={() => save({ ...dup, force: true })} className="rounded-lg py-2 font-bold text-white" style={{ backgroundColor: NAVY }}>{L('Không, lưu thêm', 'No, save it')}</button>
            </div></div>}
          {!dup && <>
            <button disabled={busy || !(base > 0)} onClick={() => save(mk(false))} className="w-full rounded-xl py-3 font-extrabold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>
              {busy ? <Loader2 size={16} className="inline animate-spin" /> : draft.mode === 'correct' ? L('Lưu sửa', 'Save correction') : L('Lưu lượt đếm', 'Save count')}</button>
            <button disabled={busy} onClick={() => save(mk(true))} className="w-full rounded-xl py-2.5 font-bold" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>
              {L('Không có trong room (= 0)', 'Not in the room (= 0)')}</button>
          </>}
        </div>
      </div>
    );
  })();

  const chip = (l: RoomLine) => {
    const t = totals.get(l.tmplId);
    if (!t) return <span className="text-[11.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap" style={{ border: `1px solid ${HAIR}`, color: '#9CA3AF' }}>{L('Chưa đếm', 'Not counted')}</span>;
    if (t.zero) return <span className="text-[11.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>= 0</span>;
    const w = unitAlert(t.total, l.takenRecent);
    return <span className="text-[11.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap tabular-nums" style={{ backgroundColor: w ? '#FBEAE8' : OKBG, color: w ? LATE : OK }}>{fmtQty(t.total)} {l.uom}</span>;
  };
  const startDraft = (tmplId: number) => { setDup(null); setDraft({ tmplId, txt: '', unit: 0, mode: 'add' }); };

  return (
    <div className="space-y-3">
      <div className="rounded-2xl p-3 space-y-2 text-white" style={{ backgroundColor: NAVY }}>
        <div className="flex items-start justify-between gap-2">
          <div><div className="font-extrabold">{L('Kiểm kê room', 'Room count')} · {s.countDate.split('-').reverse().slice(0, 2).join('/')}</div>
            <div className="text-[11.5px] opacity-80">{L('Chốt lúc', 'Cut-off')} {cut.time} · {L('mở bởi', 'opened by')} {s.openedByName ?? '—'}</div></div>
          <div className="grid grid-cols-2 gap-1 text-[11.5px] font-bold">
            {(['list', 'summary'] as const).map(v => <button key={v} onClick={() => setView(v)} className="rounded-lg px-2 py-1" style={{ backgroundColor: view === v ? '#fff' : 'transparent', color: view === v ? NAVY : '#fff', border: '1px solid rgba(255,255,255,.5)' }}>
              {v === 'list' ? L('Đếm', 'Count') : L('Tổng kết', 'Summary')}</button>)}
          </div>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,.2)' }}><div className="h-full" style={{ width: `${lines.length ? Math.round((nDone + nZero) / lines.length * 100) : 0}%`, backgroundColor: GOLD }} /></div>
        <div className="flex items-center gap-1.5 text-[11.5px] opacity-90"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#7FD49B' }} />
          {recentNames.length ? `${L('Đang đếm', 'Counting')}: ${recentNames.join(', ')}` : L('Cập nhật trực tiếp', 'Live updates')}</div>
      </div>

      {offline && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold flex items-center gap-2" style={{ backgroundColor: '#FFF4CC', color: GOLD_TEXT }}>
        <AlertCircle size={14} /> {L(`Mất kết nối — ${queue.length} lượt đang chờ gửi, đã lưu trên máy.`, `Connection lost — ${queue.length} entries waiting, kept on this phone.`)}</div>}
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold flex items-center gap-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>
        <span className="flex-1">{err}</span><button onClick={() => setErr(null)}><X size={14} /></button></div>}

      {view === 'list' ? <>
        <div className="flex gap-1.5">
          {([['all', L('Tất cả', 'All'), lines.length], ['todo', L('Chưa đếm', 'Not counted'), nTodo], ['done', L('Đã đếm', 'Counted'), nDone + nZero]] as const).map(([k, label, n]) => (
            <button key={k} onClick={() => setFilter(k)} className="flex-1 rounded-xl py-2 text-[12px] font-extrabold"
              style={{ backgroundColor: filter === k ? PALE : '#fff', color: filter === k ? GOLD_TEXT : '#6B7280', border: `1.5px solid ${filter === k ? GOLD : BORDER}` }}>{label} · {n}</button>))}
        </div>
        <label className="flex items-center gap-2 bg-white rounded-xl px-3" style={{ border: `1px solid ${BORDER}` }}>
          <Search size={14} style={{ color: '#9CA3AF' }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nguyên liệu…', 'Search a raw material…')} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
        </label>
        {groups.length === 0 && <div className="bg-white rounded-2xl p-5 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Không có nguyên liệu nào.', 'No raw material here.')}</div>}
        {groups.map(([t, ls]) => (
          <div key={t} className="bg-white rounded-2xl px-3" style={{ border: `1px solid ${BORDER}` }}>
            <div className="text-[10.5px] font-extrabold uppercase tracking-wide pt-2.5 pb-1" style={{ color: '#9CA3AF' }}>{lang === 'vi' ? RAW_TYPES[t].vi : RAW_TYPES[t].en}</div>
            {ls.map(l => { const es = entries.filter(e => e.tmplId === l.tmplId); return (
              <div key={l.tmplId} className="flex items-center gap-2 py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                <ItemPhoto tmplId={l.tmplId} sku={l.sku} size={40} canAdd />
                <button onClick={() => startDraft(l.tmplId)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                <div className="flex-1 min-w-0"><div className="text-[13px] font-bold leading-snug">{lineName(l)}</div>
                  <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{es.length ? `${es.length} ${L('lượt', es.length > 1 ? 'entries' : 'entry')} · ${Array.from(new Set(es.map(e => e.countedByName))).join(', ')}` : l.sku ?? '—'}</div></div>
                {chip(l)}
                </button>
              </div>); })}
          </div>))}
        {!adding ? <button onClick={() => setAdding(true)} className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-bold" style={{ border: `1.5px dashed ${BORDER}`, color: GOLD_TEXT }}>
          <Plus size={15} /> {L('Sản phẩm khác', 'Other product')}</button>
          : <OtherProduct team={team} items={items} listed={new Set(lines.map(l => l.tmplId))} lang={lang} L={L} onClose={() => setAdding(false)}
              onFree={async (f) => { setBusy(true); try { const r = await saveFreeItemAction(team, s.id, f); if (r.error) setErr(r.error); else { if (r.state) setSt(r.state); setAdding(false); ping(); } } catch { setErr(L('Mất kết nối — bấm lưu lại, không bị trùng.', 'Connection lost — tap save again, no duplicate.')); } setBusy(false); }}
              busy={busy}
              onPick={(m) => { setAdding(false); setSt(x => x && !x.lines.some(l => l.tmplId === m.tmplId) ? { ...x, lines: [...x.lines, { tmplId: m.tmplId, sku: m.sku, name: m.name, nameVi: m.nameVi, uom: m.uom, type: m.type, sub: m.sub, source: 'added', takenRecent: null, leftOutReason: null, leftOutNote: null }] } : x); startDraft(m.tmplId); }} />}
        {(st.freeItems ?? []).length > 0 && (
          <div className="bg-white rounded-2xl px-3" style={{ border: `1px solid ${BORDER}` }}>
            <div className="text-[10.5px] font-extrabold uppercase tracking-wide pt-2.5 pb-1" style={{ color: GOLD_TEXT }}>🆕 {L('Sản phẩm chưa có trong danh mục · Axel sẽ liên kết', 'Not in the catalogue yet · Axel will link them')}</div>
            {(st.freeItems ?? []).map(f => (
              <div key={f.id} className="flex items-center gap-2 py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                {f.photoUrl ? <img src={f.photoUrl} alt="" className="w-10 h-10 rounded-lg object-cover flex-none" /> : <div className="w-10 h-10 rounded-lg flex-none flex items-center justify-center" style={{ backgroundColor: PALE }}><Camera size={16} style={{ color: '#C4B98A' }} /></div>}
                <div className="flex-1 min-w-0"><div className="text-[13px] font-bold leading-snug">{f.name}</div>
                  <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{f.countedByName ?? '—'}{f.note ? ` · ${f.note}` : ''}</div></div>
                <span className="text-[11.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap tabular-nums" style={{ backgroundColor: OKBG, color: OK }}>{fmtQty(f.qty)} {f.uom}</span>
                {(f.countedBy === st.meId || st.canConfirm) && <button disabled={busy} onClick={() => act(deleteFreeItemAction(team, s.id, f.id))} className="p-0.5" style={{ color: LATE }} aria-label="delete"><Trash2 size={14} /></button>}
              </div>))}
          </div>)}
        <div className="text-center text-[12px] pb-2" style={{ color: '#9CA3AF' }}>{L('Có thể thoát bất cứ lúc nào — tiến độ đã được lưu.', 'You can leave at any time — progress is saved.')}</div>
      </> : (
        <div className="space-y-3">
          <div className="flex gap-1.5 text-[12px] font-bold flex-wrap">
            <span className="rounded-full px-2.5 py-1" style={{ backgroundColor: OKBG, color: OK }}>{L('Đã đếm', 'Counted')} {nDone}</span>
            <span className="rounded-full px-2.5 py-1" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>= 0 : {nZero}</span>
            <span className="rounded-full px-2.5 py-1" style={{ backgroundColor: nTodo ? '#FBEAE8' : OKBG, color: nTodo ? LATE : OK }}>{L('Chưa đếm', 'Not counted')} {nTodo}</span>
          </div>
          {alerts.length > 0 && <div className="bg-white rounded-2xl p-3 space-y-1.5" style={{ border: `1px solid ${BORDER}` }}>
            <b className="text-[13px]" style={{ color: LATE }}>{L(`Kiểm tra đơn vị · ${alerts.length}`, `Check the unit · ${alerts.length}`)}</b>
            {alerts.map(l => <button key={l.tmplId} onClick={() => startDraft(l.tmplId)} className="w-full flex justify-between text-[12.5px] text-left"><span className="min-w-0 truncate">{lineName(l)}</span>
              <span className="tabular-nums whitespace-nowrap">{fmtQty(totals.get(l.tmplId)!.total)} vs {fmtQty(l.takenRecent ?? 0)} {l.uom}</span></button>)}
          </div>}
          <div className="bg-white rounded-2xl p-3 space-y-1.5" style={{ border: `1px solid ${BORDER}` }}>
            <b className="text-[13px]">{L(`Kiểm tra trùng · ${multi.length} sản phẩm có nhiều lượt`, `Duplicate check · ${multi.length} products with several entries`)}</b>
            {multi.length === 0 && <div className="text-[12px]" style={{ color: '#9CA3AF' }}>{L('Không có.', 'None.')}</div>}
            {multi.map(([l, es]) => (
              <div key={l.tmplId}>
                <button onClick={() => setOpenDup(openDup === l.tmplId ? null : l.tmplId)} className="w-full flex items-center gap-1 text-[12.5px] text-left py-0.5">
                  {openDup === l.tmplId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="flex-1 min-w-0 truncate">{lineName(l)}</span>
                  <span className="tabular-nums whitespace-nowrap">{es.length} {L('lượt', 'entries')} · {fmtQty(totals.get(l.tmplId)!.total)} {l.uom}</span></button>
                {openDup === l.tmplId && <div className="pl-5 space-y-1 pb-1">{es.map(e => (
                  <div key={e.id} className="flex items-center gap-2 text-[12px]"><span className="flex-1 min-w-0 truncate" style={{ color: '#6B7280' }}>{e.countedByName ?? '—'} · {e.createdAt ? vnDayTime(e.createdAt).time : ''}</span>
                    <b className="tabular-nums">{e.isZero ? '= 0' : e.packLabel ? `${fmtQty(e.packCount ?? 0)} × ${e.packLabel}` : `${fmtQty(e.qty)} ${l.uom}`}</b>
                    {e.createdAt && (e.countedBy === st.meId || st.canConfirm) && <button disabled={busy} onClick={() => act(deleteRoomEntryAction(team, s.id, e.id))} style={{ color: LATE }} aria-label="delete"><Trash2 size={13} /></button>}
                  </div>))}</div>}
              </div>))}
          </div>
          <div className="bg-white rounded-2xl p-3 space-y-2.5" style={{ border: `1px solid ${BORDER}` }}>
            <b className="text-[13px]">{L('Chưa đếm → không đưa vào kiểm kê. Lý do?', 'Not counted → left out of the count. Why?')}</b>
            {left.length === 0 && <div className="text-[12px]" style={{ color: OK }}><Check size={13} className="inline" /> {L('Tất cả đã được đếm.', 'Everything is counted.')}</div>}
            {left.map(l => (
              <div key={l.tmplId} className="space-y-1">
                <div className="flex items-center gap-2"><span className="flex-1 min-w-0 text-[12.5px] font-bold truncate">{lineName(l)}</span>
                  <button onClick={() => { setView('list'); startDraft(l.tmplId); }} className="text-[11.5px] font-extrabold" style={{ color: GOLD_TEXT }}>{L('Đếm', 'Count')} ›</button></div>
                <div className="flex gap-1 flex-wrap">{(Object.keys(LEFT_OUT_REASONS) as LeftOutReason[]).map(r => (
                  <button key={r} disabled={busy} onClick={() => act(setLeftOutReasonAction(team, s.id, l.tmplId, l.leftOutReason === r ? null : r, r === 'other' ? notes[l.tmplId] ?? l.leftOutNote : null))}
                    className="text-[11.5px] font-bold rounded-full px-2 py-0.5"
                    style={{ border: `1px solid ${l.leftOutReason === r ? GOLD : HAIR}`, backgroundColor: l.leftOutReason === r ? PALE : '#fff', color: l.leftOutReason === r ? GOLD_TEXT : '#6B7280' }}>
                    {lang === 'vi' ? LEFT_OUT_REASONS[r].vi : LEFT_OUT_REASONS[r].en}</button>))}</div>
                {l.leftOutReason === 'other' && <input value={notes[l.tmplId] ?? l.leftOutNote ?? ''} onChange={e => setNotes(n => ({ ...n, [l.tmplId]: e.target.value }))}
                  onBlur={() => act(setLeftOutReasonAction(team, s.id, l.tmplId, 'other', notes[l.tmplId] ?? ''))}
                  placeholder={L('Ghi chú', 'Note')} className="w-full rounded-lg px-2 py-1.5 text-[12.5px] outline-none" style={{ border: `1px solid ${HAIR}` }} />}
              </div>))}
          </div>
          {st.canConfirm ? (
            <button disabled={busy || queue.length > 0 || left.some(l => !l.leftOutReason)} onClick={() => act(confirmRoomCountAction(team, s.id))}
              className="w-full rounded-xl py-3 font-extrabold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>
              {busy ? <Loader2 size={16} className="inline animate-spin" /> : L('Xác nhận kiểm kê', 'Confirm the count')}</button>
          ) : <div className="text-center text-[12.5px] font-semibold" style={{ color: '#6B7280' }}>{L('Trưởng nhóm sẽ xác nhận kiểm kê.', 'The team lead confirms the count.')}</div>}
          <div className="text-center text-[11.5px]" style={{ color: '#9CA3AF' }}>{L('Chưa gửi Odoo · giai đoạn 1', 'Not sent to Odoo · phase 1')}</div>
        </div>
      )}
      {sheet}
    </div>
  );
}

type FreeInput = { id: string; name: string; qty: number; uom: string; photoUrl: string | null; note: string | null };
// "Sản phẩm khác": search the whole raw catalogue (hidden products included, from the server); not found →
// a new product typed freely with its photo (Axel, 2026-10-30), linked to an Odoo product later.
function OtherProduct({ team, items, listed, lang, L, onPick, onClose, onFree, busy }: { team: string; items: RawMaterial[] | null; listed: Set<number>; lang: 'vi' | 'en'; L: (vi: string, en: string) => string; onPick: (m: RawMaterial) => void; onClose: () => void; onFree: (f: FreeInput) => void; busy: boolean }) {
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<RawMaterial[]>([]);
  const [searching, setSearching] = useState(false);
  const [free, setFree] = useState<FreeInput | null>(null);
  const [qtyTxt, setQtyTxt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [upErr, setUpErr] = useState<string | null>(null);
  const local = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return (items ?? []).filter(m => !listed.has(m.tmplId) && (m.name.toLowerCase().includes(s) || (m.nameVi ?? '').toLowerCase().includes(s) || (m.sku ?? '').toLowerCase().includes(s))).slice(0, 30);
  }, [items, listed, q]);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRemote([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try { const r = await searchCountCatalogAction(team, s); setRemote((r.items ?? []).filter(m => !listed.has(m.tmplId))); } catch { /* local results stay */ }
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [q, team, listed]);
  const res = useMemo(() => { const seen = new Set(local.map(m => m.tmplId)); return [...local, ...remote.filter(m => !seen.has(m.tmplId))].slice(0, 30); }, [local, remote]);
  const upload = async (file: File) => {
    setUploading(true); setUpErr(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await uploadRawPhotoAction(fd);
      if (r.error) setUpErr(r.error); else setFree(f => f && ({ ...f, photoUrl: r.url! }));
    } catch { setUpErr(L('Không tải được ảnh.', 'Could not upload the photo.')); }
    setUploading(false);
  };
  if (free) {
    const n = parseQty(qtyTxt);
    return (
      <div className="bg-white rounded-2xl p-3 space-y-2.5" style={{ border: `1.5px solid ${GOLD}` }}>
        <div className="flex items-center gap-2"><b className="flex-1 text-[13.5px]" style={{ color: NAVY }}>🆕 {L('Sản phẩm mới (chưa có trong danh mục)', 'New product (not in the catalogue)')}</b>
          <button onClick={onClose} style={{ color: '#6B7280' }}><X size={16} /></button></div>
        <input autoFocus value={free.name} onChange={e => setFree({ ...free, name: e.target.value })} placeholder={L('Tên sản phẩm', 'Product name')}
          className="w-full rounded-xl px-3 py-2.5 text-[14px] font-bold outline-none" style={{ border: `1px solid ${BORDER}` }} />
        <div className="flex items-center gap-2">
          <input inputMode="decimal" value={qtyTxt} placeholder="0" onChange={e => setQtyTxt(e.target.value.replace(/[^0-9.,]/g, ''))}
            className="w-28 rounded-xl px-3 py-2 text-[22px] font-extrabold outline-none tabular-nums" style={{ border: `1.5px solid ${GOLD}` }} />
          <div className="flex gap-1 flex-wrap flex-1">{FREE_UNITS.map(u => (
            <button key={u} onClick={() => setFree({ ...free, uom: u })} className="text-[12px] font-bold rounded-lg px-2 py-1"
              style={{ border: `1px solid ${free.uom === u ? GOLD : HAIR}`, backgroundColor: free.uom === u ? PALE : '#fff', color: free.uom === u ? GOLD_TEXT : '#6B7280' }}>{u === 'Unit' ? L('cái', 'pcs') : u}</button>))}</div>
        </div>
        <label className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-bold cursor-pointer" style={{ border: `1.5px dashed ${BORDER}`, color: GOLD_TEXT }}>
          {free.photoUrl ? <img src={free.photoUrl} alt="" className="w-10 h-10 rounded-lg object-cover" /> : <Camera size={18} />}
          {uploading ? <Loader2 size={15} className="animate-spin" /> : free.photoUrl ? L('Đổi ảnh', 'Change photo') : L('Chụp ảnh sản phẩm', 'Take a photo')}
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        </label>
        {upErr && <div className="text-[12px] font-semibold" style={{ color: LATE }}>{upErr}</div>}
        <input value={free.note ?? ''} onChange={e => setFree({ ...free, note: e.target.value })} placeholder={L('Ghi chú (thương hiệu, quy cách…)', 'Note (brand, size…)')}
          className="w-full rounded-xl px-3 py-2 text-[13px] outline-none" style={{ border: `1px solid ${HAIR}` }} />
        <button disabled={busy || uploading || !free.name.trim()} onClick={() => onFree({ ...free, qty: n })}
          className="w-full rounded-xl py-3 font-extrabold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>
          {busy ? <Loader2 size={16} className="inline animate-spin" /> : L('Lưu sản phẩm mới', 'Save the new product')}</button>
      </div>);
  }
  return (
    <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1.5px solid ${GOLD}` }}>
      <div className="flex items-center gap-2"><Search size={14} style={{ color: '#9CA3AF' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm trong danh mục…', 'Search the catalogue…')} className="flex-1 py-1.5 text-[13.5px] outline-none" />
        {searching && <Loader2 size={14} className="animate-spin" style={{ color: '#9CA3AF' }} />}
        <button onClick={onClose} style={{ color: '#6B7280' }}><X size={16} /></button></div>
      {res.map(m => <button key={m.tmplId} onClick={() => onPick(m)} className="w-full text-left py-2 text-[13px] font-bold" style={{ borderTop: `1px solid ${HAIR}` }}>
        {lang === 'vi' && m.nameVi ? m.nameVi : m.name} <span className="text-[10.5px] font-normal" style={{ color: '#9CA3AF' }}>{m.sku ?? ''} · {m.uom}</span></button>)}
      <button onClick={() => { setFree({ id: uuid(), name: q.trim(), qty: 0, uom: 'kg', photoUrl: null, note: null }); setQtyTxt(''); }}
        className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-bold" style={{ border: `1.5px dashed ${BORDER}`, color: GOLD_TEXT, backgroundColor: PALE }}>
        <Plus size={15} /> {L('Không tìm thấy? Thêm sản phẩm mới + ảnh', 'Not found? Add a new product + photo')}</button>
    </div>
  );
}
