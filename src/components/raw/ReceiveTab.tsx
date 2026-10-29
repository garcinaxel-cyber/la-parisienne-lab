'use client';
// "Nhận hàng" — receiving purchase orders (Axel, 2026-10-26). Built for operational staff (Hiền, Miss
// Flavor) on a phone: big cards, big steppers, icon reasons, almost no text. Reads Odoo live when the
// screen opens; Validate writes Odoo (receipt, backorder, PO quantity, the PO's single draft bill) —
// see lib/odoo-po-receive.ts.
import ItemPhoto from '@/components/raw/ItemPhoto';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, ChevronLeft, Minus, Plus, Check } from 'lucide-react';
import { fmtQty, vnDayTime, TEAM_SHORT, type RawPack } from '@/lib/raw-materials';
import { getOpenReceiptsAction, getReceiptAction, validateReceiptAction, getPendingHandoversAction, handoverToTeamAction, type OpenReceiptRow, type ReceiptView, type Handover, type PendingHandover } from '@/app/(app)/purchasing/receive-actions';
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

const roomLabel = (team: string, L: (vi: string, en: string) => string) => team === 'kho' ? L('Kho chung', 'Lab storage') : `Room ${TEAM_SHORT[team]?.vi ?? team}`;

// Hand-over to the teams (Axel, 2026-10-29): since the rooms are linked to Odoo, what a team ordered
// reaches its room through a slip. One card per room; "Đã giao cho team" records the team's slip
// (confirmed by storage) — the chef's "Đã nhận" then moves it in Odoo. Quantities can be corrected
// (split, unit differences) before tapping.
function HandoverPanel({ receiptId, poName, initial, L, lang, onChange }: { receiptId: string; poName: string; initial: Handover; L: (vi: string, en: string) => string; lang: 'vi' | 'en'; onChange?: (h: Handover) => void }) {
  const [h, setH] = useState<Handover>(initial);
  const [q, setQ] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const give = async (team: string, keep = false) => {
    setBusy(team); setErr(null);
    const grp = h.teams.find(t => t.team === team)!;
    try {
      // keep: put away in the Lab storage / cold room instead — nothing handed, the team takes it later with a normal slip.
      const r = await handoverToTeamAction(receiptId, team, grp.lines.map(l => ({ tmplId: l.tmplId, qty: keep ? 0 : q[`${team}|${l.tmplId}`] != null ? parseQty(q[`${team}|${l.tmplId}`]) : l.qty })));
      if (r.error) setErr(r.error); else if (r.handover) { setH(r.handover); onChange?.(r.handover); }
    } catch { setErr(L('Mất kết nối — bấm lại, không bị tạo hai phiếu.', 'Connection lost — tap again, no double slip.')); }
    setBusy(null);
  };
  return (
    <div className="space-y-2.5">
      <div className="pt-1 px-1 text-[12px] font-extrabold uppercase tracking-wide" style={{ color: GOLD_TEXT }}>🚚 {L('Giao cho team', 'Hand over to the teams')} · {poName}</div>
      {h.teams.map(t => {
        const c = TEAM_SHORT[t.team];
        return (
          <div key={t.team} className="rounded-2xl p-3 space-y-2 bg-white" style={{ border: `1.5px solid ${t.givenAt ? OK : c?.color ?? HAIR}`, backgroundColor: t.givenAt ? OKBG : '#fff' }}>
            <div className="flex items-center gap-2">
              <span className="rounded-full px-2.5 py-1 text-[12.5px] font-extrabold" style={{ color: c?.color, backgroundColor: c?.bg }}>→ {roomLabel(t.team, L)}</span>
              <span className="text-[12px]" style={{ color: '#6B7280' }}>{t.lines.length} {L('sản phẩm', 'item(s)')}</span>
            </div>
            {t.lines.map(l => {
              const k = `${t.team}|${l.tmplId}`;
              return (
                <div key={k} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 text-[13.5px] font-bold leading-snug">{(lang === 'vi' && l.nameVi) || l.name}
                    {l.recvUom.toLowerCase() !== l.uom.toLowerCase() && !t.givenAt && <div className="text-[11px] font-semibold" style={{ color: WARN }}>{L(`Nhận theo ${l.recvUom} — kiểm tra số ${l.uom}`, `Received in ${l.recvUom} — check the ${l.uom} figure`)}</div>}</div>
                  {t.givenAt
                    ? <span className="font-extrabold text-[14px] tabular-nums">{fmtQty(l.qty)} {l.uom}</span>
                    : <><input inputMode="decimal" value={q[k] ?? String(l.qty)} onChange={e => setQ(s => ({ ...s, [k]: e.target.value.replace(/[^0-9.,]/g, '') }))}
                        className="w-20 h-10 rounded-xl text-center text-[17px] font-extrabold outline-none tabular-nums" style={{ border: `1.5px solid ${BORDER}` }} />
                      <span className="text-[13px] font-bold w-10" style={{ color: '#6B7280' }}>{l.uom}</span></>}
                </div>);
            })}
            {t.givenAt
              ? <div className="text-[12.5px] font-bold" style={{ color: OK }}>✓ {t.slipNo ? L(`Đã giao · phiếu #${t.slipNo} · chờ chef bấm "Đã nhận"`, `Handed over · slip #${t.slipNo} · waiting for the chef's "Đã nhận"`) : L('Cất vào kho — team lấy sau bằng phiếu lấy kho', 'Put away in storage — the team takes it later with a slip')}{t.givenBy ? ` · ${t.givenBy}` : ''}</div>
              : <button disabled={!!busy} onClick={() => give(t.team)} className="w-full rounded-xl py-3 font-extrabold text-white text-[15px] disabled:opacity-50" style={{ backgroundColor: NAVY }}>
                  {busy === t.team ? <Loader2 size={17} className="inline animate-spin" /> : `✓ ${L('Đã giao cho team', 'Handed to the team')}`}</button>}
            {!t.givenAt && <button disabled={!!busy} onClick={() => give(t.team, true)} className="w-full rounded-xl py-2.5 font-bold text-[13.5px] disabled:opacity-50" style={{ border: `1.5px solid ${BORDER}`, color: NAVY, backgroundColor: '#fff' }}>
              ❄️ {L('Cất vào kho / tủ lạnh — team lấy sau', 'Put away in storage / cold room — team takes it later')}</button>}
          </div>);
      })}
      {h.kho.length > 0 && (
        <div className="rounded-2xl p-3 space-y-1.5" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}` }}>
          <span className="rounded-full px-2.5 py-1 text-[12.5px] font-extrabold" style={{ color: TEAM_SHORT.kho.color, backgroundColor: TEAM_SHORT.kho.bg }}>→ {L('Kho chung — cất vào kho', 'Lab storage — put away')}</span>
          <div className="text-[13px] pt-1">{h.kho.map(k => `${(lang === 'vi' && k.nameVi) || k.name} ${fmtQty(k.qty)} ${k.uom}`).join(' · ')}</div>
        </div>)}
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: BADBG, color: BAD }}>{err}</div>}
    </div>);
}

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
  const [handover, setHandover] = useState<Handover | null>(null);
  const [pending, setPending] = useState<PendingHandover[]>([]);
  const [openHand, setOpenHand] = useState<PendingHandover | null>(null);

  const loadList = useCallback(async () => {
    setErr(null);
    const r = await getOpenReceiptsAction();
    if (r.error) setErr(r.error); setList(r.items ?? []);
    const p = await getPendingHandoversAction();
    setPending(p.items ?? []);
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
    // Latest confirmed PO first (Axel, 26/10); same PO: the earlier receipt first.
    const ts = (v: string | null) => (v ? Date.parse(v.replace(' ', 'T') + 'Z') || 0 : 0);
    return (list ?? []).filter(i => !s || (i.vendor ?? '').toLowerCase().includes(s) || i.poName.toLowerCase().includes(s) || [...i.productsVi, ...i.products.map(p => p.name)].some(n => n.toLowerCase().includes(s)))
      .sort((a, b) => ts(b.approvedAt) - ts(a.approvedAt) || b.poId - a.poId || a.pickingId - b.pickingId);
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
        {handover && <HandoverPanel receiptId={clientId} poName={open.poName} initial={handover} L={L} lang={lang} onChange={setHandover} />}
        {handover && handover.teams.some(t => !t.givenAt) && <div className="text-[12px] text-center" style={{ color: '#6B7280' }}>{L('Chưa giao xong? Có thể giao sau — xem mục "Chờ giao cho team".', 'Not handed over yet? You can do it later — see "To hand over".')}</div>}
        <button onClick={() => { setDone(null); setOpen(null); setHandover(null); loadList(); }} className="w-full rounded-2xl py-3.5 font-extrabold text-white text-[16px]" style={{ backgroundColor: NAVY }}>{L('Xong', 'Done')}</button>
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
        else if (r.result) { setDone(r.result); setHandover(r.handover ?? null); }
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
              <div className="flex items-start gap-2.5"><ItemPhoto tmplId={l.tmplId} sku={(l.name.match(/^\[([^\]]*)\]/) ?? [])[1] ?? null} size={44} canAdd /><div className="min-w-0"><div className="font-extrabold text-[15px] leading-snug">{name}</div>
                <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{packs.length ? packs.map(p => `${p.label} = ${fmtQty(p.f)} ${l.uom}`).join(' · ') : l.uom}{l.receivedBefore > 0 ? ` · ${L('đã nhận', 'received')} ${fmtQty(l.receivedBefore)}` : ''}</div>
                <DestChips dest={open.dest[l.productId] ?? []} expected={l.expected} uom={l.uom} L={L} /></div></div>
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

  // ---------- Hand-over left for later ----------
  if (openHand) {
    return (
      <div className="space-y-3 pb-24">
        <div className="flex items-center gap-2">
          <button onClick={() => { setOpenHand(null); loadList(); }} className="w-10 h-10 rounded-xl flex items-center justify-center bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><ChevronLeft size={20} /></button>
          <div className="min-w-0 flex-1"><div className="font-extrabold text-[16px] truncate">{openHand.vendor}</div><div className="text-[12px]" style={{ color: '#6B7280' }}>{openHand.poName}</div></div>
        </div>
        <HandoverPanel receiptId={openHand.receiptId} poName={openHand.poName} initial={openHand.handover} L={L} lang={lang} />
        <button onClick={() => { setOpenHand(null); loadList(); }} className="w-full rounded-2xl py-3.5 font-extrabold text-white text-[16px]" style={{ backgroundColor: NAVY }}>{L('Xong', 'Done')}</button>
      </div>);
  }

  // ---------- 1. List ----------
  const ymd = todayYmd();
  return (
    <div className="space-y-3 pb-24">
      <div className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm sản phẩm, nhà cung cấp, PO…', 'Search product, supplier, PO…')}
          className="flex-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none bg-white" style={{ border: `1px solid ${BORDER}` }} />
        <button onClick={() => { setList(null); loadList(); }} className="w-11 rounded-xl flex items-center justify-center bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><RefreshCw size={17} /></button>
      </div>
      {err && <div className="rounded-xl px-3 py-2 text-[12.5px] font-semibold" style={{ backgroundColor: BADBG, color: BAD }}>{err}</div>}
      {pending.length > 0 && <div className="space-y-2">
        <div className="pt-1 px-1 text-[12px] font-extrabold uppercase tracking-wide" style={{ color: WARN }}>🚚 {L('Chờ giao cho team', 'To hand over')}</div>
        {pending.map(p => {
          const left = p.handover.teams.filter(t => !t.givenAt);
          return (
            <button key={p.receiptId} onClick={() => setOpenHand(p)} className="w-full flex items-center gap-3 rounded-2xl p-3 text-left" style={{ border: `1.5px solid ${WARN}`, backgroundColor: WARNBG }}>
              <div className="flex-1 min-w-0"><div className="font-extrabold text-[14.5px]">{p.poName} · {p.vendor}</div>
                <div className="flex flex-wrap gap-1 pt-1">{left.map(t => <span key={t.team} className="rounded-full px-2 py-0.5 text-[11.5px] font-extrabold" style={{ color: TEAM_SHORT[t.team]?.color, backgroundColor: TEAM_SHORT[t.team]?.bg }}>→ {roomLabel(t.team, L)}</span>)}</div></div>
              <span className="text-[20px]">›</span>
            </button>);
        })}
      </div>}
      {loading && <div className="text-center py-3"><Loader2 size={20} className="inline animate-spin" style={{ color: NAVY }} /></div>}
      {!list ? <div className="text-center py-8"><Loader2 size={22} className="inline animate-spin" style={{ color: NAVY }} /></div>
        : rows.length === 0 ? <div className="bg-white rounded-2xl p-8 text-center text-[14px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>📭 {L('Không có hàng chờ nhận', 'Nothing to receive')}</div>
        : rows.map((i, idx) => {
          const conf = i.approvedAt ? vnDayTime(i.approvedAt.replace(' ', 'T') + 'Z') : null;
          const prevConf = idx > 0 && rows[idx - 1].approvedAt ? vnDayTime(rows[idx - 1].approvedAt!.replace(' ', 'T') + 'Z').ymd : null;
          const yest = new Date(Date.parse(ymd + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
          const head = conf && conf.ymd !== prevConf
            ? (conf.ymd === ymd ? L('Xác nhận hôm nay', 'Confirmed today') : conf.ymd === yest ? L('Xác nhận hôm qua', 'Confirmed yesterday') : `${L('Xác nhận', 'Confirmed')} ${conf.day}`)
            : null;
          const d = i.scheduled ? vnDayTime(i.scheduled.replace(' ', 'T') + 'Z') : null;
          const late = d && d.ymd < ymd;
          const today = d && d.ymd === ymd;
          const pill = i.isBackorder ? { t: '½', c: WARN, bg: WARNBG } : late ? { t: L('Trễ', 'Late'), c: BAD, bg: BADBG } : today ? { t: L('Hôm nay', 'Today'), c: GOLD_TEXT, bg: PALE } : { t: d?.day ?? '', c: GOLD_TEXT, bg: PALE };
          return (
            <div key={i.pickingId}>
            {head && <div className="pt-2 pb-1.5 px-1 text-[12px] font-extrabold uppercase tracking-wide" style={{ color: GOLD_TEXT }}>{head}</div>}
            <button onClick={() => openReceipt(i.pickingId)} className="w-full flex items-center gap-3 rounded-2xl p-3 text-left bg-white" style={{ border: `1.5px solid ${HAIR}` }}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center text-[22px] flex-none" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}` }}>📦</div>
              <div className="flex-1 min-w-0">
                {/* Products first (team feedback 26/10): what arrives matters more than who sells it. */}
                <div className="font-extrabold text-[14.5px] leading-snug line-clamp-2">{(lang === 'vi' ? i.productsVi : i.products.map(p => p.name)).slice(0, 3).join(' · ') || i.vendor}{i.products.length > 3 ? ` +${i.products.length - 3}` : ''}</div>
                <div className="text-[12px] truncate" style={{ color: '#6B7280' }}>{i.vendor} · {i.poName}{i.teams.length ? ` · ${i.teams.map(t => TEAM_SHORT[t]?.[lang] ?? t).join(', ')}` : ''}</div></div>
              <span className="rounded-full px-2.5 py-1 text-[12px] font-extrabold whitespace-nowrap" style={{ color: pill.c, backgroundColor: pill.bg }}>{pill.t}</span>
            </button>
            </div>);
        })}
    </div>
  );
}

// Where a product goes once received (open request lines on this PO): team rooms first, the rest to the Kho.
function DestChips({ dest, expected, uom, L }: { dest: { team: string; qty: number; uom: string }[]; expected: number; uom: string; L: (vi: string, en: string) => string }) {
  const teams = dest.filter(d => d.team !== 'kho');
  if (!teams.length) return <div className="pt-1"><span className="rounded-full px-2 py-0.5 text-[11.5px] font-extrabold" style={{ color: TEAM_SHORT.kho.color, backgroundColor: TEAM_SHORT.kho.bg }}>→ {L('Kho chung', 'Lab storage')}</span></div>;
  const sameUnit = teams.every(d => d.uom.toLowerCase() === uom.toLowerCase());
  const forTeams = teams.reduce((s, d) => s + d.qty, 0);
  const rest = sameUnit ? Math.round((expected - forTeams) * 1000) / 1000 : 0;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {teams.map(d => <span key={d.team + d.uom} className="rounded-full px-2 py-0.5 text-[11.5px] font-extrabold" style={{ color: TEAM_SHORT[d.team]?.color, backgroundColor: TEAM_SHORT[d.team]?.bg }}>→ Room {TEAM_SHORT[d.team]?.vi ?? d.team} {fmtQty(d.qty)} {d.uom}</span>)}
      {rest > 1e-9 && <span className="rounded-full px-2 py-0.5 text-[11.5px] font-extrabold" style={{ color: TEAM_SHORT.kho.color, backgroundColor: TEAM_SHORT.kho.bg }}>→ {L('Kho', 'Storage')} {fmtQty(rest)} {uom}</span>}
    </div>);
}
