'use client';
// "Nhận hàng" — receiving purchase orders (Axel, 2026-10-26). Built for operational staff (Hiền, Miss
// Flavor) on a phone: big cards, big steppers, icon reasons, almost no text. Reads Odoo live when the
// screen opens; Validate writes Odoo (receipt, backorder, PO quantity, the PO's single draft bill) —
// see lib/odoo-po-receive.ts.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, ChevronLeft, Minus, Plus, Check } from 'lucide-react';
import { fmtQty, vnDayTime, TEAM_SHORT, type RawPack } from '@/lib/raw-materials';
import { getOpenReceiptsAction, getReceiptAction, validateReceiptAction, type OpenReceiptRow, type ReceiptView } from '@/app/(app)/purchasing/receive-actions';
import type { ShortReason, ValidateResult } from '@/lib/odoo-po-receive';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF';
const OK = '#1F7A45', OKBG = '#E6F4EA', WARN = '#B45309', WARNBG = '#FFF1DC', BAD = '#B42318', BADBG = '#FDECEA';
const REASONS: [ShortReason, string, string, string][] = [
  ['later', '🚚', 'Phần còn lại giao sau', 'The rest comes later'],
  ['supplier_error', '❌', 'Nhà cung cấp giao sai / thiếu', 'Supplier mistake'],
  ['no_more', '🚫', 'Nhà cung cấp hết hàng', 'Supplier has no more'],
  ['wrong_product', '🔄', 'Giao nhầm sản phẩm', 'Wrong product delivered'],
];
const uuid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto) ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const parseQty = (t: string) => { const v = parseFloat(t.replace(/\s+/g, '').replace(',', '.')); return isNaN(v) ? 0 : Math.max(0, v); };
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

export default function ReceiveTab({ L, lang }: { L: (vi: string, en: string) => string; lang: 'vi' | 'en' }) {
  const [list, setList] = useState<OpenReceiptRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<ReceiptView | null>(null);
  const [loading, setLoading] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<Record<number, ShortReason | null>>({});
  const [note, setNote] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ValidateResult | null>(null);
  const [clientId, setClientId] = useState(uuid());
  const [q, setQ] = useState('');

  const loadList = useCallback(async () => {
    setErr(null);
    const r = await getOpenReceiptsAction();
    if (r.error) setErr(r.error); setList(r.items ?? []);
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  async function openReceipt(pickingId: number) {
    setLoading(true); setErr(null); setDone(null);
    const r = await getReceiptAction(pickingId);
    setLoading(false);
    if (r.error || !r.data) { setErr(r.error ?? 'Error'); return; }
    setOpen(r.data); setQty({}); setReason({}); setNote({}); setClientId(uuid());
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (list ?? []).filter(i => !s || (i.vendor ?? '').toLowerCase().includes(s) || i.poName.toLowerCase().includes(s));
  }, [list, q]);

  // ---------- 3. Done ----------
  if (done && open) {
    const inStock = done.received.filter(r => r.received > 0);
    const still = done.received.filter(r => r.received < r.expected && r.reason && r.reason !== 'no_more');
    const billTxt = done.bill.action === 'created' ? L('Đã tạo hoá đơn nháp', 'Draft bill created')
      : done.bill.action === 'aligned' ? L('Đã cập nhật hoá đơn nháp', 'Draft bill updated')
      : done.bill.action === 'posted_untouched' ? L('Hoá đơn đã ghi sổ — không sửa', 'Bill already posted — untouched') : L('Không có hoá đơn', 'No bill');
    const Res = ({ e, t, s, bg }: { e: string; t: string; s?: string; bg: string }) => (
      <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5" style={{ backgroundColor: bg }}><span className="text-[22px]">{e}</span>
        <div className="min-w-0"><div className="font-extrabold text-[14.5px]">{t}</div>{s && <div className="text-[12px]" style={{ color: '#6B7280' }}>{s}</div>}</div></div>);
    return (
      <div className="space-y-3">
        <div className="flex flex-col items-center gap-1 py-3">
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-[40px] font-extrabold" style={{ backgroundColor: OKBG, color: OK }}>{done.alreadyDone ? '!' : '✓'}</div>
          <div className="font-extrabold text-[17px]">{done.alreadyDone ? L('Đã nhận trước đó', 'Already received') : L('Đã nhận hàng', 'Received')}</div>
          <div className="text-[12px]" style={{ color: '#6B7280' }}>{open.vendor} · {open.poName}</div>
        </div>
        {inStock.length > 0 && <Res e="📦" bg={OKBG} t={L('Đã nhập kho', 'In stock')} s={inStock.map(r => `${r.name.replace(/^\[[^\]]*\]\s*/, '')} ${fmtQty(r.received)} ${r.uom}`).join(' · ')} />}
        {still.length > 0 && <Res e="🚚" bg={WARNBG} t={L('Còn chờ giao', 'Still expected')} s={still.map(r => `${r.name.replace(/^\[[^\]]*\]\s*/, '')} ${fmtQty(r.expected - r.received)} ${r.uom}`).join(' · ')} />}
        {done.lowered.length > 0 && <Res e="🚫" bg={PALE} t={L('Đã giảm số lượng đặt', 'Order reduced')} s={done.lowered.map(l => `${l.name.replace(/^\[[^\]]*\]\s*/, '')} ${fmtQty(l.from)} → ${fmtQty(l.to)}`).join(' · ')} />}
        {!done.alreadyDone && <Res e="🧾" bg={PALE} t={billTxt} s={done.bill.gaps?.join(' · ')} />}
        <button onClick={() => { setDone(null); setOpen(null); loadList(); }} className="w-full rounded-2xl py-3.5 font-extrabold text-white text-[16px]" style={{ backgroundColor: NAVY }}>{L('Xong', 'Done')}</button>
      </div>
    );
  }

  // ---------- 2. Count ----------
  if (open) {
    const vals = open.lines.map(l => ({ l, n: qty[l.moveId] != null ? parseQty(qty[l.moveId]) : 0, typed: qty[l.moveId] != null }));
    const missingReason = vals.some(v => v.typed && v.n < v.l.expected - 1e-9 && !reason[v.l.moveId]) || vals.some(v => !v.typed);
    const allTyped = vals.every(v => v.typed);
    const validate = async () => {
      if (!open) return;
      setBusy(true); setErr(null);
      try {
        const r = await validateReceiptAction(clientId, open.pickingId, vals.map(v => ({ moveId: v.l.moveId, qty: v.n, reason: v.n < v.l.expected - 1e-9 ? reason[v.l.moveId] ?? null : null, note: note[v.l.moveId] ?? null })));
        if (r.error) setErr(r.error);
        else if (r.result && !r.result.ok) setErr(r.result.error ?? 'Error');
        else if (r.result) setDone(r.result);
      } catch { setErr(L('Mất kết nối — bấm lại, không bị nhận hai lần.', 'Connection lost — tap again, it will not be received twice.')); }
      setBusy(false);
    };
    const unitsFor = (pid: number, uom: string): { label: string; f: number }[] => [{ label: uom, f: 1 }, ...((open.packs[pid] ?? []) as RawPack[]).map(p => ({ label: p.label, f: p.factor }))];
    return (
      <div className="space-y-3 pb-24">
        <div className="flex items-center gap-2">
          <button onClick={() => setOpen(null)} className="w-10 h-10 rounded-xl flex items-center justify-center bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><ChevronLeft size={20} /></button>
          <div className="min-w-0 flex-1"><div className="font-extrabold text-[16px] truncate">{open.vendor}</div><div className="text-[12px]" style={{ color: '#6B7280' }}>{open.poName} · {open.pickingName}</div></div>
        </div>
        <button onClick={() => setQty(Object.fromEntries(open.lines.map(l => [l.moveId, String(l.expected)])))}
          className="w-full rounded-2xl py-3.5 font-extrabold text-[15px]" style={{ backgroundColor: OKBG, color: OK, border: `1.5px dashed ${OK}` }}>✓ {L('Đã nhận đủ', 'All arrived')}</button>
        {open.lines.map(l => {
          const n = qty[l.moveId] != null ? parseQty(qty[l.moveId]) : null;
          const full = n != null && n >= l.expected - 1e-9;
          const short = n != null && !full;
          const packs = unitsFor(l.productId, l.uom).slice(1);
          const name = (lang === 'vi' && open.nameVi[l.productId]) || l.name.replace(/^\[[^\]]*\]\s*/, '');
          const set = (v: number) => setQty(s => ({ ...s, [l.moveId]: String(Math.max(0, Math.round(v * 1000) / 1000)) }));
          return (
            <div key={l.moveId} className="rounded-2xl p-3 space-y-2.5 bg-white" style={{ border: `1.5px solid ${full ? OK : short ? WARN : HAIR}`, backgroundColor: full ? OKBG : '#fff' }}>
              <div><div className="font-extrabold text-[15px] leading-snug">{name}</div>
                <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{packs.length ? packs.map(p => `${p.label} = ${fmtQty(p.f)} ${l.uom}`).join(' · ') : l.uom}{l.receivedBefore > 0 ? ` · ${L('đã nhận', 'received')} ${fmtQty(l.receivedBefore)}` : ''}</div></div>
              <div className="flex items-center gap-2">
                <button onClick={() => set((n ?? l.expected) - 1)} className="w-11 h-11 rounded-xl flex items-center justify-center bg-white" style={{ border: `1.5px solid ${BORDER}`, color: NAVY }}><Minus size={18} /></button>
                <input inputMode="decimal" value={qty[l.moveId] ?? ''} placeholder="—" onChange={e => setQty(s => ({ ...s, [l.moveId]: e.target.value.replace(/[^0-9.,]/g, '') }))}
                  className="w-20 h-11 text-center text-[24px] font-extrabold outline-none tabular-nums bg-transparent" />
                <button onClick={() => set((n ?? 0) + 1)} className="w-11 h-11 rounded-xl flex items-center justify-center bg-white" style={{ border: `1.5px solid ${BORDER}`, color: NAVY }}><Plus size={18} /></button>
                <span className="font-bold text-[15px]" style={{ color: '#6B7280' }}>/ {fmtQty(l.expected)} {l.uom}</span>
                {full && <span className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-white" style={{ backgroundColor: OK }}><Check size={20} /></span>}
              </div>
              {short && <>
                <div className="font-extrabold text-[13px]" style={{ color: WARN }}>{L(`Thiếu ${fmtQty(l.expected - (n ?? 0))} ${l.uom} — lý do?`, `${fmtQty(l.expected - (n ?? 0))} ${l.uom} missing — why?`)}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {REASONS.map(([k, e, vi, en]) => (
                    <button key={k} onClick={() => setReason(s => ({ ...s, [l.moveId]: k }))} className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12.5px] font-bold leading-tight"
                      style={{ border: `1.5px solid ${reason[l.moveId] === k ? WARN : HAIR}`, backgroundColor: reason[l.moveId] === k ? WARNBG : '#fff', color: reason[l.moveId] === k ? WARN : '#1F2421' }}>
                      <span className="text-[20px] flex-none">{e}</span>{lang === 'vi' ? vi : en}</button>))}
                </div>
                {(reason[l.moveId] === 'wrong_product' || reason[l.moveId] === 'supplier_error') &&
                  <input value={note[l.moveId] ?? ''} onChange={e => setNote(s => ({ ...s, [l.moveId]: e.target.value }))} placeholder={L('Ghi chú (giao gì?)', 'Note (what came?)')}
                    className="w-full rounded-xl px-3 py-2 text-[13px] outline-none" style={{ border: `1px solid ${HAIR}` }} />}
              </>}
            </div>);
        })}
        {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: BADBG, color: BAD }}>{err}</div>}
        <button disabled={busy || !allTyped || missingReason} onClick={validate}
          className="w-full rounded-2xl py-4 font-extrabold text-white text-[16px] disabled:opacity-40" style={{ backgroundColor: NAVY }}>
          {busy ? <><Loader2 size={18} className="inline animate-spin" /> {L('Đang ghi Odoo…', 'Writing to Odoo…')}</> : L('Xác nhận nhận hàng', 'Validate')}</button>
      </div>
    );
  }

  // ---------- 1. List ----------
  const ymd = todayYmd();
  return (
    <div className="space-y-3 pb-24">
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nhà cung cấp hoặc PO…', 'Search supplier or PO…')}
          className="flex-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none bg-white" style={{ border: `1px solid ${BORDER}` }} />
        <button onClick={() => { setList(null); loadList(); }} className="w-11 rounded-xl flex items-center justify-center bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><RefreshCw size={17} /></button>
      </div>
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: BADBG, color: BAD }}>{err}</div>}
      {loading && <div className="text-center py-3"><Loader2 size={20} className="inline animate-spin" style={{ color: NAVY }} /></div>}
      {!list ? <div className="text-center py-8"><Loader2 size={22} className="inline animate-spin" style={{ color: NAVY }} /></div>
        : rows.length === 0 ? <div className="bg-white rounded-2xl p-8 text-center text-[14px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>📭 {L('Không có hàng chờ nhận', 'Nothing to receive')}</div>
        : rows.map(i => {
          const d = i.scheduled ? vnDayTime(i.scheduled.replace(' ', 'T') + 'Z') : null;
          const late = d && d.ymd < ymd;
          const today = d && d.ymd === ymd;
          const pill = i.isBackorder ? { t: '½', c: WARN, bg: WARNBG } : late ? { t: L('Trễ', 'Late'), c: BAD, bg: BADBG } : today ? { t: L('Hôm nay', 'Today'), c: GOLD_TEXT, bg: PALE } : { t: d?.day ?? '', c: GOLD_TEXT, bg: PALE };
          return (
            <button key={i.pickingId} onClick={() => openReceipt(i.pickingId)} className="w-full flex items-center gap-3 rounded-2xl p-3 text-left bg-white" style={{ border: `1.5px solid ${HAIR}` }}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-[22px] flex-none" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}` }}>📦</div>
              <div className="flex-1 min-w-0"><div className="font-extrabold text-[14.5px] truncate">{i.vendor}</div>
                <div className="text-[12px] truncate" style={{ color: '#6B7280' }}>{i.poName} · {i.lines} {L('món', 'items')}{i.teams.length ? ` · ${i.teams.map(t => TEAM_SHORT[t]?.[lang] ?? t).join(', ')}` : ''}</div></div>
              <span className="rounded-full px-2.5 py-1 text-[12px] font-extrabold whitespace-nowrap" style={{ color: pill.c, backgroundColor: pill.bg }}>{pill.t}</span>
            </button>);
        })}
    </div>
  );
}
