'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Truck, RefreshCw, Search, Check, X, ChevronRight, ChevronDown, AlertTriangle, Loader2, Factory, Pencil, Plus, RotateCcw, Bell, Clock, ListFilter, ArrowUpDown } from 'lucide-react';
import PushBell from '@/components/PushBell';
import { useI18n } from '@/lib/i18n';
import {
  RAW_TYPES, subLabel, typeLabel, shortVendor, rawName, vnDayTime, daysBetween, fmtQty, TEAM_SHORT,
  type PurchaseLine, type RawMaterial, type Withdrawal, type RawType,
  packHint,
} from '@/lib/raw-materials';
import {
  getPurchasingBoardAction, setVendorAction, markOrderedAction, cancelLinesAction, undoLineStepAction,
  linkNewProductAction, markNewToCreateAction, getWithdrawalsDayAction, correctWithdrawalLineAction, getHistoryAction,
  getCatalogueAction, syncCatalogueAction, updateMaterialAction, checkMaterialsAction, createDraftPoAction, type Board,
  getPendingWithdrawalsAction, confirmWithdrawalAction, refuseTransferAction, addStorageRequestAction,
} from './actions';
import { Track } from '@/components/raw/PurchaseTrack';
import ItemPhoto from '@/components/raw/ItemPhoto';
import ReceiveTab from '@/components/raw/ReceiveTab';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318';
type Tab = 'requests' | 'storage' | 'history' | 'catalogue' | 'receive';

// Who a slip concerns: the team for a storage withdrawal, "from → to" for a transfer (2026-10-16).
function SlipWho({ w, lang }: { w: Withdrawal; lang: 'vi' | 'en' }) {
  if (w.kind !== 'transfer' || !w.fromTeam || !w.toTeam) return <TeamBadge team={w.team} lang={lang} />;
  return <><span className="inline-block text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5 mr-1" style={{ backgroundColor: '#8A6D14', color: '#fff' }}>⇄ {lang === 'vi' ? 'Chuyển' : 'Transfer'}</span><TeamBadge team={w.fromTeam} lang={lang} /> → <TeamBadge team={w.toTeam} lang={lang} /></>;
}

function TeamBadge({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const t = TEAM_SHORT[team];
  return <span className="inline-block text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: t?.bg ?? '#F2F4F7', color: t?.color ?? '#344054' }}>{t ? t[lang] : team}</span>;
}

export default function PurchasingView({ initialTab, userName, canReceive }: { initialTab: Tab; userName: string; canReceive: boolean }) {
  const { lang } = useI18n();
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [tab, setTab] = useState<Tab>(initialTab);
  // Axel, 2026-10-09: "le stock picking et purchase est un peu trop mélangé" — three clearly separate
  // spaces: Purchasing (requests + purchase history), Stock picking (the chefs' storage slips, any
  // day), Catalogue. Same tab ids as before, so ?tab= links keep working.
  // Axel, 2026-10-12: Catalogue moved inside Purchasing (3rd sub-tab next to Requests / history).
  // Receiving purchase orders (Axel, 2026-10-26): its own section, shown when enabled (admin-only until PO_RECEIVING_OPEN=1).
  type Section = 'purchase' | 'picking' | 'receive';
  const section: Section = tab === 'storage' ? 'picking' : tab === 'receive' ? 'receive' : 'purchase';
  const sections: [Section, string, Tab][] = [
    ['purchase', L('Mua hàng', 'Purchasing'), 'requests'],
    ['picking', L('Lấy kho', 'Stock picking'), 'storage'],
    ...(canReceive ? [['receive', L('Nhận hàng', 'Receiving'), 'receive'] as [Section, string, Tab]] : []),
  ];
  const purchaseTabs: [Tab, string][] = [['requests', L('Yêu cầu mua', 'Requests')], ['history', L('Lịch sử mua', 'Purchase history')], ['catalogue', L('Danh mục', 'Catalogue')]];
  // Slips waiting for storage's confirmation (Axel, 2026-10-09), shown as a badge on Stock picking.
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => getPendingWithdrawalsAction().then(r => { if (alive && r.items) setPendingCount(r.items.length); });
    tick();
    const t = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [tab]);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2"><Truck size={24} className="text-gold" /> {L('Mua hàng', 'Purchasing')}</h1>
          <p className="text-ink-light text-sm mt-0.5">{L('Mua hàng: yêu cầu mua của các chef. Lấy kho: phiếu lấy nguyên liệu từ kho. Giai đoạn thử: không ghi gì vào Odoo.', 'Purchasing: the chefs\' purchase requests. Stock picking: what they take from storage. Test phase: nothing is written to Odoo.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <PushBell L={L} />
          <Link href="/oem-orders" className="inline-flex items-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2 bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><Factory size={15} /> {L('Đơn hàng OEM', 'OEM orders')}</Link>
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-xl p-1 bg-white" style={{ border: `1px solid ${BORDER}` }}>
        {sections.map(([k, label, first]) => (
          <button key={k} onClick={() => setTab(section === k ? tab : first)} className="flex-1 min-w-[110px] rounded-lg py-2 text-[13px] font-extrabold whitespace-nowrap"
            style={{ backgroundColor: section === k ? NAVY : 'transparent', color: section === k ? '#fff' : '#6B7280' }}>{label}
            {k === 'picking' && pendingCount > 0 && <span className="ml-1.5 inline-flex items-center justify-center rounded-full text-[11px] font-extrabold px-1.5 min-w-[20px]" style={{ backgroundColor: LATE, color: '#fff' }}>{pendingCount}</span>}</button>
        ))}
      </div>
      {section === 'purchase' && (
        <div className="flex gap-1.5">
          {purchaseTabs.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className="rounded-full px-3.5 py-1.5 text-[12.5px] font-extrabold"
              style={tab === k ? { backgroundColor: PALE, border: `1.5px solid ${GOLD}`, color: GOLD_TEXT } : { backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: '#6B7280' }}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'requests' && <RequestsTab L={L} lang={lang as any} />}
      {tab === 'storage' && <StorageTab L={L} lang={lang as any} onPending={setPendingCount} />}
      {tab === 'history' && <HistoryTab L={L} lang={lang as any} />}
      {tab === 'catalogue' && <CatalogueTab L={L} lang={lang as any} />}
      {tab === 'receive' && canReceive && <ReceiveTab L={L} lang={lang as any} />}
    </div>
  );
}

type LFn = (vi: string, en: string) => string;

/* ===================== Requests ===================== */
function RequestsTab({ L, lang }: { L: LFn; lang: 'vi' | 'en' }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [po, setPo] = useState<Record<string, string>>({});
  // Phase 2 (Axel, 2026-10-09): tick any lines, whatever vendor, -> one draft PO in Odoo.
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [poOpen, setPoOpen] = useState(false);
  const [poVendor, setPoVendor] = useState<string>('');
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const load = useCallback(async () => {
    const r = await getPurchasingBoardAction();
    if (r.error) setErr(r.error); else { setErr(null); setBoard(r.data!); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function run(p: Promise<{ error?: string } | { ok: boolean }>) {
    setBusy(true); const r: any = await p; setBusy(false);
    if (r?.error) setErr(r.error); else await load();
  }
  if (!board) return <div className="text-sm text-center py-10" style={{ color: '#6B7280' }}>{err ?? L('Đang tải…', 'Loading…')}</div>;

  // Names in the screen's language (Axel, 2026-10-13: the purchase recap still showed the Odoo
  // English name in VI) — same catalogue name_vi as the Catalogue tab and the chefs' screens.
  const viById = new Map(board.catalogue.filter(c => c.nameVi).map(c => [c.tmplId, c.nameVi as string]));
  const nm = (l: { tmplId: number | null; name: string }) => (lang === 'vi' && l.tmplId != null && viById.get(l.tmplId)) || l.name;
  const inPo = board.lines.filter(l => l.status === 'pending' && l.poOdooId);
  const pending = board.lines.filter(l => l.status === 'pending' && !l.poOdooId && !(l.isNew && l.newState !== 'linked'));
  const toggle = (idsArr: string[], on: boolean) => setSel(prev => { const n = new Set(prev); idsArr.forEach(i => on ? n.add(i) : n.delete(i)); return n; });
  const selLines = pending.filter(l => sel.has(l.id));
  const suggested = (() => {
    const m = new Map<number, string>();
    const vname = (id: number) => board.vendors.find(v => v.id === id)?.name ?? String(id);
    for (const l of selLines) {
      if (l.vendorId) m.set(l.vendorId, l.vendorName ?? vname(l.vendorId));
      for (const id of board.catalogue.find(c => c.tmplId === l.tmplId)?.vendorIds ?? []) if (!m.has(id)) m.set(id, vname(id));
    }
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  })();
  async function createPo() {
    setBusy(true); setErr(null);
    const r = await createDraftPoAction(selLines.map(l => l.id), Number(poVendor) || null);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setPoOpen(false); setSel(new Set()); setPoVendor('');
    setOkMsg(L(`✓ Đã tạo PO nháp ${r.poName} trên Odoo — kiểm tra giá rồi xác nhận trên Odoo.`, `✓ Draft PO ${r.poName} created in Odoo — check prices, then confirm it in Odoo.`));
    await load();
  }
  const news = board.lines.filter(l => l.status === 'pending' && l.isNew && l.newState !== 'linked');
  // Pending lines by vendor, then merged by product.
  const byVendor = new Map<string, PurchaseLine[]>();
  for (const l of pending) { const k = l.vendorId ? String(l.vendorId) : 'none'; const a = byVendor.get(k) ?? []; a.push(l); byVendor.set(k, a); }
  const vendorKeys = Array.from(byVendor.keys()).sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : byVendor.get(b)!.length - byVendor.get(a)!.length));
  const merge = (ls: PurchaseLine[]) => {
    const m = new Map<string, PurchaseLine[]>();
    for (const l of ls) { const k = String(l.tmplId ?? l.id); const a = m.get(k) ?? []; a.push(l); m.set(k, a); }
    return Array.from(m.values());
  };
  const vendorOptions = board.vendors;

  return (
    <div className="space-y-3">
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{err}</div>}
      <div className="flex justify-end">
        <button onClick={() => setAddOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13px] font-extrabold bg-white" style={{ border: `1px solid ${NAVY}`, color: NAVY }}>
          <Plus size={15} /> {L('Thêm nhu cầu của kho', 'Add a storage need')}</button>
      </div>
      {addOpen && <AddNeedDialog L={L} lang={lang} catalogue={board.catalogue} onClose={() => setAddOpen(false)}
        onDone={no => { setAddOpen(false); setOkMsg(L(`✓ Đã thêm yêu cầu #${no} (Kho) vào danh sách chờ.`, `✓ Request #${no} (Storage) added to the queue.`)); load(); }} />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={L('Dòng đang chờ', 'Lines waiting')} value={String(pending.length)} sub={L('chưa đặt hàng', 'not ordered yet')} />
        <Kpi label={L('Nhà cung cấp', 'Vendors')} value={String(vendorKeys.filter(k => k !== 'none').length)} sub={L('theo NCC trong Odoo', 'from Odoo vendors')} />
        <Kpi label={L('Chưa có NCC', 'No vendor')} value={String(byVendor.get('none')?.length ?? 0)} sub={L('cần chọn', 'to assign')} warn={(byVendor.get('none')?.length ?? 0) > 0} />
        <Kpi label={L('Sản phẩm mới', 'New products')} value={String(news.length)} sub={L('cần gắn hoặc tạo', 'to link or create')} />
      </div>
      {okMsg && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#ECFDF3', color: '#067647' }}>{okMsg}</div>}
      {!pending.length && !news.length && !inPo.length && (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Chưa có yêu cầu nào.', 'No request yet.')}</div>
      )}
      {board.drafts.length > 0 && (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          <div className="px-4 py-2.5 text-sm font-bold" style={{ borderBottom: `1px solid ${HAIR}` }}>{L('PO nháp trên Odoo — chờ xác nhận', 'Draft POs in Odoo — waiting for confirmation')} · {board.drafts.length}</div>
          {board.drafts.map(d => { const dl = inPo.filter(l => l.poOdooId === d.id); return (
            <div key={d.id} className="px-4 py-2.5" style={{ borderTop: `1px solid ${HAIR}` }}>
              <div className="flex items-center gap-2 flex-wrap">
                <b className="text-[13px]">{d.name}</b>
                {d.vendorId ? <span className="text-xs" style={{ color: '#344054' }}>{shortVendor(d.vendorName)}</span>
                  : <span className="text-[11px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#FBEAE8', color: LATE }}>⚠ {L('Chưa có NCC — chưa được xác nhận', 'No vendor — do not confirm yet')}</span>}
                <span className="ml-auto text-xs tabular-nums" style={{ color: '#6B7280' }}>{d.amountTotal ? `${Math.round(d.amountTotal).toLocaleString('vi-VN')} ₫` : L('chưa có giá', 'no price yet')}</span>
              </div>
              <div className="text-[11.5px] mt-1" style={{ color: '#6B7280' }}>{dl.map(l => `${nm(l)} ${fmtQty(l.qty)} ${l.uom}${packHint(l) ? ` (${packHint(l)})` : ''}`).join(' · ')}</div>
            </div>); })}
          <div className="px-4 py-2 text-[11px]" style={{ backgroundColor: PALE, color: '#6B7280' }}>{L('Xác nhận PO trên Odoo. App tự cập nhật “Đã đặt” khi PO được xác nhận, hoặc trả dòng về hàng chờ nếu PO bị huỷ.', 'Confirm the PO in Odoo. The app switches to “Ordered” once confirmed, or puts the lines back in the queue if the PO is cancelled.')}</div>
        </div>
      )}
      {sel.size > 0 && (
        <div className="sticky top-2 z-20 flex items-center gap-2 rounded-xl px-3 py-2.5 flex-wrap shadow-md" style={{ backgroundColor: NAVY, color: '#fff' }}>
          <b className="text-[13px] flex-1">{L(`Đã chọn ${selLines.length} dòng`, `${selLines.length} lines selected`)}</b>
          <button onClick={() => setSel(new Set())} className="text-xs font-bold px-2" style={{ color: '#F0D98A' }}>{L('Bỏ chọn', 'Clear')}</button>
          <a href={`/purchase-print?lines=${selLines.map(l => l.id).join(',')}`} target="_blank" rel="noopener"
            className="rounded-lg px-3 py-1.5 text-xs font-extrabold" style={{ border: '1px solid #F0D98A', color: '#F0D98A' }}>
            🖨 {L('In phiếu đề xuất', 'Print purchase request')}</a>
          <button disabled={busy || !selLines.length} onClick={() => { setPoVendor(suggested.length === 1 ? String(suggested[0].id) : ''); setPoOpen(true); }} className="rounded-lg px-3 py-1.5 text-xs font-extrabold" style={{ backgroundColor: '#F0D98A', color: NAVY }}>{L('Tạo PO nháp trên Odoo', 'Create draft PO in Odoo')} ›</button>
        </div>
      )}
      {poOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.35)' }} onClick={() => !busy && setPoOpen(false)}>
          <div className="bg-white rounded-2xl p-4 w-full max-w-md space-y-3" onClick={e => e.stopPropagation()}>
            <div className="text-[15px] font-extrabold">{L('Tạo PO nháp trên Odoo', 'Create a draft PO in Odoo')}</div>
            <div className="text-[12px] rounded-lg p-2 max-h-40 overflow-y-auto" style={{ backgroundColor: PALE }}>{selLines.map(l => <div key={l.id}>{nm(l)} · <b>{fmtQty(l.qty)} {l.uom}</b>{packHint(l) && <span style={{ color: GOLD_TEXT }}> ({packHint(l)})</span>} <span style={{ color: '#9CA3AF' }}>#{l.requestNo}</span></div>)}</div>
            <div><span className="block text-[11px] font-extrabold uppercase tracking-wide mb-1" style={{ color: '#9CA3AF' }}>{L('Nhà cung cấp của PO', 'Vendor for this PO')}</span>
              <VendorPicker L={L} value={poVendor} onChange={setPoVendor} suggested={suggested} vendors={board.vendors} /></div>
            {!poVendor && <div className="text-[11.5px] rounded-lg px-2.5 py-2" style={{ backgroundColor: '#FFF6E0', color: '#8A5A00' }}>{L('PO được lưu không có NCC. Chọn NCC trên Odoo trước khi xác nhận.', 'The PO is saved without a vendor. Set the vendor in Odoo before confirming.')}</div>}
            <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{L('Giá lấy theo bảng giá NCC trên Odoo. App không xác nhận PO — bạn xác nhận trên Odoo.', 'Prices come from the vendor price list in Odoo. The app never confirms the PO — you confirm it in Odoo.')}</div>
            <div className="flex gap-2 justify-end">
              <button disabled={busy} onClick={() => setPoOpen(false)} className="rounded-lg px-3 py-2 text-sm font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L('Huỷ', 'Cancel')}</button>
              <button disabled={busy} onClick={createPo} className="rounded-lg px-4 py-2 text-sm font-extrabold text-white" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={14} className="animate-spin inline" /> : L('Tạo PO nháp', 'Create draft PO')}</button>
            </div>
          </div>
        </div>
      )}
      {vendorKeys.map(k => {
        const ls = byVendor.get(k)!; const none = k === 'none';
        return (
          <div key={k} className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap" style={{ borderBottom: `1px solid ${HAIR}`, backgroundColor: none ? '#FFF8EC' : '#fff' }}>
              <b className="text-sm flex-1 min-w-[200px]">{none ? <span className="inline-flex items-center gap-1.5" style={{ color: LATE }}><AlertTriangle size={14} /> {L('Chưa có nhà cung cấp', 'No vendor yet')}</span> : shortVendor(ls[0].vendorName)}</b>
              <span className="text-xs" style={{ color: '#6B7280' }}>{ls.length} {L('dòng', 'lines')}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" style={{ minWidth: 720 }}>
                <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: '#9CA3AF' }}>
                  <th className="w-8 px-2 py-2"></th><th className="text-left px-3 py-2">{L('Nguyên liệu', 'Raw material')}</th><th className="text-right px-3 py-2">{L('Tổng', 'Total')}</th>
                  <th className="text-left px-3 py-2">{L('Từ', 'From')}</th><th className="text-left px-3 py-2">{L('Ghi chú / thương hiệu', 'Note / brand')}</th>
                  <th className="text-left px-3 py-2">{L('Nhà cung cấp', 'Vendor')}</th><th></th></tr></thead>
                <tbody>
                  {merge(ls).map(group => {
                    const f = group[0]; const total = group.reduce((s, l) => s + l.qty, 0);
                    return (
                      <tr key={f.id} style={{ borderTop: `1px solid ${HAIR}`, backgroundColor: group.every(l => sel.has(l.id)) ? '#FFFBEF' : undefined }}>
                        <td className="px-2 py-2 text-center">{f.tmplId != null && <input type="checkbox" className="w-4 h-4 accent-[#1A4731]" checked={group.every(l => sel.has(l.id))} onChange={e => toggle(group.map(l => l.id), e.target.checked)} aria-label="select" />}</td>
                        <td className="px-3 py-2"><div className="flex items-center gap-2.5"><ItemPhoto tmplId={f.tmplId} sku={f.sku} size={40} canAdd /><div className="min-w-0"><b>{nm(f)}</b><div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{f.sku}{lang === 'vi' && nm(f) !== f.name ? ` · ${f.name}` : ''}</div></div></div></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap"><b>{fmtQty(total)} {f.uom}</b>{group.length > 1 && <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{group.map(l => fmtQty(l.qty)).join(' + ')}</div>}{group.some(l => packHint(l)) && <div className="text-[10.5px] font-semibold" style={{ color: GOLD_TEXT }}>{group.map(l => packHint(l) ?? `${fmtQty(l.qty)} ${l.uom}`).join(' + ')}</div>}</td>
                        <td className="px-3 py-2">{group.map(l => <div key={l.id} className="flex items-center gap-1 text-[11px]"><TeamBadge team={l.team} lang={lang} /> <span style={{ color: '#6B7280' }}>{l.requestedBy ?? ''} · {vnDayTime(l.createdAt).day}{l.approvedBy ? ` · ✓ ${l.approvedBy}` : ''}</span></div>)}</td>
                        <td className="px-3 py-2 text-[11.5px]">{group.map(l => (l.brand || l.note) ? <div key={l.id}>{l.brand && <span><b>{l.brand}</b> <span style={{ color: '#9CA3AF' }}>{l.brandStrict ? L('bắt buộc', 'required') : L('nếu có', 'if possible')}</span></span>}{l.brand && l.note ? ' · ' : ''}{l.note}</div> : null)}{!group.some(l => l.brand || l.note) && <span style={{ color: '#D0D5DD' }}>—</span>}</td>
                        <td className="px-3 py-2">
                          <select disabled={busy} value={f.vendorId ?? ''} onChange={e => { const id = Number(e.target.value) || null; run(setVendorAction(group.map(l => l.id), id, vendorOptions.find(v => v.id === id)?.name ?? null)); }}
                            className="rounded-lg px-2 py-1.5 text-xs bg-white max-w-[200px]" style={{ border: `1px solid ${HAIR}` }}>
                            <option value="">{L('— chọn —', '— choose —')}</option>
                            {vendorOptions.map(v => <option key={v.id} value={v.id}>{shortVendor(v.name)}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-2 text-right"><button disabled={busy} onClick={() => { if (confirm(L('Huỷ yêu cầu này?', 'Cancel this request?'))) run(cancelLinesAction(group.map(l => l.id))); }} title={L('Huỷ', 'Cancel')} className="p-1.5 rounded-md" style={{ color: '#9CA3AF' }}><X size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!none && (
              <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap" style={{ backgroundColor: PALE }}>
                <span className="text-[11.5px] flex-1 min-w-[220px]" style={{ color: '#6B7280' }}>{L('Hoặc PO đã tạo tay trong Odoo: nhập số PO để chef thấy “Đã đặt”.', 'Or a PO made by hand in Odoo: enter its number so chefs see “Ordered”.')}</span>
                <input value={po[k] ?? ''} onChange={e => setPo(p => ({ ...p, [k]: e.target.value }))} placeholder={L('Số PO, vd P00412', 'PO no., e.g. P00412')}
                  className="rounded-lg px-2.5 py-1.5 text-xs bg-white w-36" style={{ border: `1px solid ${BORDER}` }} />
                <button disabled={busy} onClick={() => run(markOrderedAction(ls.map(l => l.id), po[k] ?? ''))} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-extrabold text-white" style={{ backgroundColor: NAVY }}>
                  <Check size={13} /> {L('Đánh dấu đã đặt', 'Mark as ordered')}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {news.length > 0 && (
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          <div className="px-4 py-2.5 text-sm font-bold" style={{ borderBottom: `1px solid ${HAIR}` }}><Plus size={14} className="inline -mt-0.5" /> {L('Sản phẩm mới do chef đề xuất', 'New products suggested by chefs')}</div>
          {news.map(l => (
            <div key={l.id} className="flex gap-3 px-4 py-3 flex-wrap items-start" style={{ borderTop: `1px solid ${HAIR}` }}>
              {l.photoUrl ? <a href={l.photoUrl} target="_blank" rel="noreferrer"><img src={l.photoUrl} alt="" className="w-16 h-16 rounded-lg object-cover" /></a> : <div className="w-16 h-16 rounded-lg" style={{ backgroundColor: PALE }} />}
              <div className="flex-1 min-w-[200px] text-[12.5px]">
                <b className="text-[13.5px]">{nm(l)}</b> · {fmtQty(l.qty)} {l.uom}{packHint(l) && <span style={{ color: GOLD_TEXT }}> ({packHint(l)})</span>}
                <div className="mt-0.5"><TeamBadge team={l.team} lang={lang} /> <span style={{ color: '#6B7280' }}>{l.requestedBy} · {vnDayTime(l.createdAt).day}{l.approvedBy ? ` · ✓ ${l.approvedBy}` : ''}</span></div>
                {l.note && <div className="mt-1">{l.note}</div>}
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                {l.newState === 'to_create' && <span className="text-[11px] font-bold rounded-md px-2 py-1" style={{ backgroundColor: '#F2F4F7', color: '#344054' }}>{L('Chờ tạo trong Odoo', 'Waiting for Odoo creation')}</span>}
                <LinkProductPicker L={L} lang={lang as any} busy={busy} catalogue={board.catalogue}
                  onPick={(tmplId) => run(linkNewProductAction(l.id, tmplId))} />
                {l.newState !== 'to_create' && <button disabled={busy} onClick={() => run(markNewToCreateAction(l.id))} className="rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white" style={{ border: `1px solid ${BORDER}` }}>{L('Cần tạo trong Odoo', 'Needs creating in Odoo')}</button>}
                <button disabled={busy} onClick={() => { if (confirm(L('Huỷ yêu cầu này?', 'Cancel this request?'))) run(cancelLinesAction([l.id])); }} className="p-1.5" style={{ color: '#9CA3AF' }}><X size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}

// Axel, 2026-10-17: link a chef's new product by SKU or name — the app catalogue first (instant), then
// a live Odoo search (finds a product created minutes ago, any category); imported on link.
function LinkProductPicker({ L, lang, busy, catalogue, onPick }: {
  L: LFn; lang: 'vi' | 'en'; busy: boolean; catalogue: Board['catalogue']; onPick: (tmplId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [odoo, setOdoo] = useState<import('./actions').OdooProductHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const nq = normVendor(q.trim());
  const local = !nq ? [] : catalogue.filter(c => nq.split(/\s+/).every(w => normVendor(`${c.name} ${c.nameVi ?? ''} ${c.sku ?? ''}`).includes(w))).slice(0, 8);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setOdoo(null); return; }
    setLoading(true);
    const h = setTimeout(async () => {
      const { searchOdooProductsAction } = await import('./actions');
      const r = await searchOdooProductsAction(t);
      setOdoo(r.items ?? []); setLoading(false);
    }, 350);
    return () => clearTimeout(h);
  }, [q]);
  const localIds = new Set(local.map(c => c.tmplId));
  const extra = (odoo ?? []).filter(o => !localIds.has(o.tmplId));
  if (!open) return (
    <button disabled={busy} onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold bg-white" style={{ border: `1px solid ${BORDER}` }}>
      <Search size={13} /> {L('Gắn với sản phẩm Odoo…', 'Link to an Odoo product…')}
    </button>
  );
  const row = (key: number, name: string, sku: string | null, sub: string, badge: string | null) => (
    <button key={key} disabled={busy} onClick={() => { onPick(key); setOpen(false); setQ(''); }}
      className="w-full text-left px-2.5 py-1.5 hover:bg-[#FFFAEE] flex items-center gap-2" style={{ borderTop: `1px solid ${HAIR}` }}>
      {sku && <span className="font-mono text-[11px] font-bold shrink-0" style={{ color: NAVY }}>{sku}</span>}
      <span className="text-xs flex-1 min-w-0 truncate">{name}</span>
      {sub && <span className="text-[10.5px] shrink-0" style={{ color: '#9CA3AF' }}>{sub}</span>}
      {badge && <span className="text-[10px] font-bold rounded px-1.5 py-0.5 shrink-0" style={{ backgroundColor: '#EEF2FF', color: '#3730A3' }}>{badge}</span>}
    </button>
  );
  return (
    <div className="w-[340px] max-w-full rounded-lg bg-white" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <Search size={13} style={{ color: '#9CA3AF' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('SKU hoặc tên, vd VTTH1051', 'SKU or name, e.g. VTTH1051')}
          className="flex-1 text-xs outline-none bg-transparent" />
        {loading && <Loader2 size={13} className="animate-spin" style={{ color: '#9CA3AF' }} />}
        <button onClick={() => { setOpen(false); setQ(''); }} aria-label={L('Đóng', 'Close')} style={{ color: '#9CA3AF' }}><X size={13} /></button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {local.map(c => row(c.tmplId, (lang === 'vi' && c.nameVi) || c.name, c.sku, c.uom, null))}
        {extra.map(o => row(o.tmplId, o.name, o.sku, o.uom, o.inApp ? null : L('Odoo · mới', 'Odoo · new')))}
        {q.trim().length >= 2 && !loading && !local.length && !extra.length && (
          <div className="px-2.5 py-2 text-[11.5px]" style={{ borderTop: `1px solid ${HAIR}`, color: '#9CA3AF' }}>{L('Không tìm thấy trên Odoo (sản phẩm phải bật "Có thể mua")', 'Not found in Odoo (the product must be "Can be purchased")')}</div>
        )}
      </div>
    </div>
  );
}

// Axel, 2026-10-09: quick search in the vendor list (accent-insensitive, "dai tan" finds ĐẠI TÂN VIỆT).
function normVendor(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}
function VendorPicker({ L, value, onChange, suggested, vendors }: {
  L: LFn; value: string; onChange: (v: string) => void;
  suggested: { id: number; name: string }[]; vendors: { id: number; name: string }[];
}) {
  const [q, setQ] = useState('');
  const nq = normVendor(q.trim());
  const match = (n: string) => !nq || nq.split(/\s+/).every(w => normVendor(n).includes(w));
  const sug = suggested.filter(v => match(v.name));
  const rest = vendors.filter(v => !suggested.some(x => x.id === v.id) && match(v.name));
  const current = value ? (vendors.find(v => String(v.id) === value) ?? suggested.find(v => String(v.id) === value)) : null;
  const row = (id: string, label: string) => {
    const on = value === id;
    return (
      <button key={id || 'none'} type="button" onClick={() => onChange(id)}
        className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-md"
        style={{ backgroundColor: on ? '#EAF3EE' : undefined, color: on ? NAVY : '#1F2937', fontWeight: on ? 800 : 500 }}>
        <span className="w-3.5 shrink-0">{on && <Check size={13} />}</span><span className="truncate">{label}</span>
      </button>
    );
  };
  const head = (t: string) => <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{t}</div>;
  return (
    <div className="rounded-lg" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-2 px-2.5 py-2" style={{ borderBottom: `1px solid ${HAIR}` }}>
        <Search size={14} style={{ color: '#9CA3AF' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nhà cung cấp…', 'Search vendors…')}
          className="flex-1 text-[13px] outline-none bg-transparent" />
        {q && <button type="button" onClick={() => setQ('')} aria-label="clear"><X size={14} style={{ color: '#9CA3AF' }} /></button>}
      </div>
      <div className="text-[12px] px-2.5 py-1.5" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>
        {L('Đã chọn: ', 'Selected: ')}<b>{current ? shortVendor(current.name) : L('Chưa chọn NCC', 'No vendor yet')}</b>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {!nq && row('', L('Chưa chọn NCC (chọn sau trên Odoo)', 'No vendor yet (choose later in Odoo)'))}
        {sug.length > 0 && <>{head(L('Gợi ý cho các sản phẩm này', 'Suggested for these items'))}{sug.map(v => row(String(v.id), shortVendor(v.name)))}</>}
        {rest.length > 0 && <>{head(L('Tất cả nhà cung cấp', 'All vendors'))}{rest.map(v => row(String(v.id), shortVendor(v.name)))}</>}
        {nq && !sug.length && !rest.length && <div className="px-2.5 py-3 text-[12.5px] text-center" style={{ color: '#6B7280' }}>{L('Không tìm thấy nhà cung cấp', 'No vendor found')}</div>}
      </div>
    </div>
  );
}

// Storage's own needs (Axel, 2026-10-09: Hien adds requests from this screen). Team 'kho', no approval.
function AddNeedDialog({ L, lang, catalogue, onClose, onDone }: {
  L: LFn; lang: 'vi' | 'en'; catalogue: Board['catalogue']; onClose: () => void; onDone: (no: number) => void;
}) {
  const [q, setQ] = useState('');
  // u (Axel, 2026-10-21): unit the quantity is typed in — -1 = Odoo unit, else an index in the product's packs.
  const [picks, setPicks] = useState<{ tmplId: number; qty: string; note: string; u: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Axel, 2026-10-19: Hiền could not add "Đế bánh vuông 9*9cm" (VTTH1025, "vật tư tiêu hao") — the
  // app catalogue only holds raw materials. Odoo is now searched live too; a product picked from
  // Odoo is imported into the app catalogue when the request is saved.
  const [odooHits, setOdooHits] = useState<{ tmplId: number; name: string; nameVi: string | null; sku: string | null; uom: string; visible: boolean; vendorIds: number[]; odoo: true }[]>([]);
  const [odooBusy, setOdooBusy] = useState(false);
  const [extra, setExtra] = useState<Map<number, Board['catalogue'][number]>>(new Map());
  const label = (c: Board['catalogue'][number]) => (lang === 'vi' && c.nameVi) || c.name;
  const byId = useMemo(() => { const m = new Map(catalogue.map(c => [c.tmplId, c])); extra.forEach((v, k) => m.set(k, v)); return m; }, [catalogue, extra]);
  const nq = normVendor(q.trim());
  const results = !nq ? [] : catalogue.filter(c => c.visible && !picks.some(p => p.tmplId === c.tmplId)
    && nq.split(/\s+/).every(w => normVendor(`${c.name} ${c.nameVi ?? ''} ${c.sku ?? ''}`).includes(w))).slice(0, 30);
  const odooOnly = odooHits.filter(h => !results.some(r => r.tmplId === h.tmplId) && !picks.some(p => p.tmplId === h.tmplId));
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setOdooHits([]); return; }
    let live = true;
    setOdooBusy(true);
    const h = setTimeout(async () => {
      const { searchOdooProductsAction } = await import('./actions');
      const r = await searchOdooProductsAction(t);
      if (!live) return;
      setOdooBusy(false);
      setOdooHits((r.items ?? []).map(i => ({ tmplId: i.tmplId, name: i.name, nameVi: null, sku: i.sku, uom: /^unit|^unité|^quả|^cái/i.test(i.uom) ? 'Unit' : i.uom, visible: true, vendorIds: [], odoo: true as const })));
    }, 350);
    return () => { live = false; clearTimeout(h); };
  }, [q]);
  const valid = picks.filter(p => parseFloat(p.qty.replace(',', '.')) > 0);
  async function submit() {
    setBusy(true); setErr(null);
    const r = await addStorageRequestAction(valid.map(p => { const pk = p.u >= 0 ? byId.get(p.tmplId)?.packs?.[p.u] : undefined; const n = parseFloat(p.qty.replace(',', '.'));
      return { tmplId: p.tmplId, qty: Math.round(n * (pk ? pk.factor : 1) * 1000) / 1000, note: p.note, packLabel: pk?.label ?? null }; }));
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    onDone(r.no!);
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.35)' }} onClick={() => !busy && onClose()}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-lg space-y-3 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="text-[15px] font-extrabold">{L('Thêm nhu cầu của kho', 'Add a storage need')}</div>
        <div className="rounded-lg" style={{ border: `1px solid ${BORDER}` }}>
          <div className="flex items-center gap-2 px-2.5 py-2">
            <Search size={14} style={{ color: '#9CA3AF' }} />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm theo tên hoặc mã SKU…', 'Search by name or SKU…')} className="flex-1 text-[13px] outline-none bg-transparent" />
            {q && <button type="button" onClick={() => setQ('')} aria-label="clear"><X size={14} style={{ color: '#9CA3AF' }} /></button>}
          </div>
          {nq && <div className="max-h-48 overflow-y-auto p-1" style={{ borderTop: `1px solid ${HAIR}` }}>
            {results.map(c => (
              <button key={c.tmplId} type="button" onClick={() => { setPicks(p => [...p, { tmplId: c.tmplId, qty: '', note: '', u: c.packs?.length ? 0 : -1 }]); setQ(''); }}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-md hover:bg-[#FFFAEE]">
                <Plus size={13} style={{ color: NAVY }} /><span className="flex-1 truncate">{label(c)}</span><span className="text-[11px]" style={{ color: '#9CA3AF' }}>{c.uom}</span>
              </button>
            ))}
            {odooOnly.map(c => (
              <button key={`o${c.tmplId}`} type="button" onClick={() => { setExtra(m => new Map(m).set(c.tmplId, c)); setPicks(p => [...p, { tmplId: c.tmplId, qty: '', note: '', u: -1 }]); setQ(''); }}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-md hover:bg-[#FFFAEE]">
                <Plus size={13} style={{ color: NAVY }} /><span className="flex-1 truncate">{c.sku ? `[${c.sku}] ` : ''}{c.name}</span>
                <span className="text-[10px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: '#EEF2FF', color: NAVY }}>Odoo</span>
                <span className="text-[11px]" style={{ color: '#9CA3AF' }}>{c.uom}</span>
              </button>
            ))}
            {odooBusy && !odooOnly.length && <div className="px-2.5 py-1.5 text-[11.5px]" style={{ color: '#9CA3AF' }}><Loader2 size={11} className="animate-spin inline" /> {L('Đang tìm trên Odoo…', 'Searching Odoo…')}</div>}
            {!results.length && !odooOnly.length && !odooBusy && <div className="px-2.5 py-3 text-[12.5px] text-center" style={{ color: '#6B7280' }}>{L('Không tìm thấy (cả trên Odoo)', 'Nothing found (Odoo included)')}</div>}
          </div>}
        </div>
        {picks.length > 0 && <div className="rounded-lg" style={{ border: `1px solid ${BORDER}` }}>
          {picks.map((p, i) => { const c = byId.get(p.tmplId); return (
            <div key={p.tmplId} className="px-3 py-2 space-y-1.5" style={{ borderTop: i ? `1px solid ${HAIR}` : 'none' }}>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-[13px] font-bold leading-snug">{c ? label(c) : p.tmplId}</span>
                <input inputMode="decimal" value={p.qty} placeholder="0" onChange={e => setPicks(ps => ps.map(x => x.tmplId === p.tmplId ? { ...x, qty: e.target.value } : x))}
                  className="w-20 rounded-md px-2 py-1 text-right text-[14px] font-extrabold" style={{ border: `1px solid ${GOLD}` }} />
                <span className="text-xs font-bold max-w-[90px] truncate" style={{ color: '#6B7280' }}>{p.u >= 0 && c?.packs?.[p.u] ? c.packs[p.u].label : c?.uom}</span>
                <button type="button" onClick={() => setPicks(ps => ps.filter(x => x.tmplId !== p.tmplId))} aria-label="remove"><X size={15} style={{ color: '#9CA3AF' }} /></button>
              </div>
              {!!c?.packs?.length && (() => { const pk = p.u >= 0 ? c.packs[p.u] : null; const n = parseFloat(p.qty.replace(',', '.')); return (
                <div className="flex items-center gap-1 flex-wrap">
                  {[-1, ...c.packs.map((_, k) => k)].map(k => (
                    <button key={k} type="button" onClick={() => setPicks(ps => ps.map(x => x.tmplId === p.tmplId ? { ...x, u: k } : x))}
                      className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5"
                      style={{ border: `1px solid ${p.u === k ? GOLD : HAIR}`, backgroundColor: p.u === k ? PALE : '#fff', color: p.u === k ? GOLD_TEXT : '#6B7280' }}>{k < 0 ? c.uom : c.packs![k].label}</button>))}
                  {pk && n > 0 && <span className="ml-auto text-[11px] font-semibold" style={{ color: GOLD_TEXT }}>= {fmtQty(n * pk.factor)} {c.uom}</span>}
                </div>); })()}
              <input value={p.note} onChange={e => setPicks(ps => ps.map(x => x.tmplId === p.tmplId ? { ...x, note: e.target.value } : x))}
                placeholder={L('Ghi chú / thương hiệu (tuỳ chọn)', 'Note / brand (optional)')} className="w-full rounded-md px-2 py-1 text-[12.5px]" style={{ border: `1px solid ${HAIR}` }} />
            </div>
          ); })}
        </div>}
        {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{err}</div>}
        <div className="flex gap-2 justify-end">
          <button disabled={busy} onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{L('Huỷ', 'Cancel')}</button>
          <button disabled={busy || !valid.length} onClick={submit} className="rounded-lg px-4 py-2 text-sm font-extrabold text-white" style={{ backgroundColor: valid.length ? NAVY : '#9CA3AF' }}>
            {busy ? <Loader2 size={14} className="animate-spin inline" /> : L(`Thêm ${valid.length || ''} dòng`, `Add ${valid.length || ''} line${valid.length > 1 ? 's' : ''}`)}</button>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-white rounded-xl px-3 py-2.5" style={{ border: `1px solid ${BORDER}` }}>
      <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{label}</div>
      <div className="text-xl font-extrabold tabular-nums" style={{ color: warn ? LATE : NAVY }}>{value}</div>
      {sub && <div className="text-[11px]" style={{ color: '#6B7280' }}>{sub}</div>}
    </div>
  );
}

/* ===================== Stock picking ===================== */
function todayVN(): string { return vnDayTime(new Date().toISOString()).ymd; }
function StorageTab({ L, lang, onPending }: { L: LFn; lang: 'vi' | 'en'; onPending?: (n: number) => void }) {
  // Slips waiting for storage (Axel, 2026-10-09: "hien confirm d'abord"), any day, oldest first.
  const [pending, setPending] = useState<Withdrawal[] | null>(null);
  const [pv, setPv] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const loadPending = useCallback(async () => {
    const r = await getPendingWithdrawalsAction();
    if (r.items) { setPending(r.items); onPending?.(r.items.length); }
  }, [onPending]);
  useEffect(() => {
    loadPending();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadPending(); }, 20000);
    return () => clearInterval(t);
  }, [loadPending]);
  const [date, setDate] = useState(todayVN());
  const [items, setItems] = useState<Withdrawal[] | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [val, setVal] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [byItem, setByItem] = useState(false);
  // Names in the screen's language (slips keep the Odoo name of the day): same catalogue as the chefs.
  const [viName, setViName] = useState<Map<number, string>>(new Map());
  useEffect(() => { getCatalogueAction().then(r => setViName(new Map((r.items ?? []).filter(m => m.nameVi).map(m => [m.tmplId, m.nameVi as string])))); }, []);
  // + the brand the chef picked, for products with several brands (2026-10-19).
  const nm = (l: { tmplId: number | null; name: string; brand?: string | null }) => ((lang === 'vi' && l.tmplId != null && viName.get(l.tmplId)) || l.name) + (l.brand ? ` · ${l.brand}` : '');
  const load = useCallback(async () => { const r = await getWithdrawalsDayAction(date); if (r.error) setErr(r.error); else { setErr(null); setItems(r.items!); } }, [date]);
  useEffect(() => { setItems(null); load(); }, [load]);
  const lines = (items ?? []).reduce((s, w) => s + w.lines.length, 0);
  const corrected = (items ?? []).reduce((s, w) => s + w.lines.filter(l => l.correctedQty != null).length, 0);
  async function confirmSlip(w: Withdrawal) {
    setConfirming(w.id); setErr(null);
    const qtys = w.lines.map(l => {
      const raw = pv[l.id];
      const v = raw == null || raw.trim() === '' ? null : parseFloat(raw.replace(',', '.'));
      return { lineId: l.id, qty: v == null || isNaN(v) ? null : v };
    });
    const r = await confirmWithdrawalAction(w.id, qtys);
    setConfirming(null);
    if (r.error) setErr(r.error);
    setPv(prev => { const n = { ...prev }; w.lines.forEach(l => delete n[l.id]); return n; });
    loadPending(); load();
  }
  async function refuseSlip(w: Withdrawal) {
    setConfirming(w.id); setErr(null);
    const r = await refuseTransferAction(w.id);
    setConfirming(null);
    if (r.error) setErr(r.error);
    loadPending(); load();
  }
  async function save(w: Withdrawal) {
    for (const l of w.lines) {
      const raw = val[l.id]; if (raw == null) continue;
      const v = parseFloat(raw.replace(',', '.'));
      if (isNaN(v)) continue;
      const r = await correctWithdrawalLineAction(l.id, Math.abs(v - l.qty) < 1e-9 ? null : v);
      if (r.error) { setErr(r.error); return; }
    }
    setEdit(null); setVal({}); load();
  }
  return (
    <div className="space-y-3">
      <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>
        {L('Chef gửi phiếu, kho xác nhận trước khi chef lấy hàng. Sửa số lượng nếu thực tế khác (0 = không đưa).', 'The chef sends a slip; storage confirms it before the chef takes the goods. Change a quantity if the real one differs (0 = not given).')}
      </div>
      {pending && pending.length > 0 && (
        <div className="rounded-2xl overflow-hidden bg-white" style={{ border: `1.5px solid ${LATE}` }}>
          <div className="px-4 py-2.5 flex items-center gap-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>
            <Clock size={15} /><b className="text-sm flex-1">{L(`Chờ xác nhận · ${pending.length} phiếu`, `To confirm · ${pending.length} slip${pending.length > 1 ? 's' : ''}`)}</b>
          </div>
          {pending.map(w => {
            const mins = Math.max(0, Math.round((Date.now() - new Date(w.createdAt).getTime()) / 60000));
            const late = mins >= 10;
            return (
              <div key={w.id} className="px-4 py-3" style={{ borderTop: `1px solid ${HAIR}` }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <b className="text-[14px] tabular-nums">#{w.no}</b>
                  <span className="text-xs flex-1" style={{ color: '#6B7280' }}>{vnDayTime(w.createdAt).time} · <SlipWho w={w} lang={lang} /> · {w.takenBy}</span>
                  <span className="text-[11px] font-extrabold rounded-md px-2 py-0.5" style={late ? { backgroundColor: LATE, color: '#fff' } : { backgroundColor: '#FFF6E0', color: '#8A5A00' }}>
                    {L(`chờ ${mins} phút`, `waiting ${mins} min`)}</span>
                </div>
                {w.note && <div className="text-[12px] mt-1" style={{ color: '#6B7280' }}>“{w.note}”</div>}
                <div className="mt-1.5">
                  {w.lines.map(l => (
                    <div key={l.id} className="flex items-center gap-3 py-1.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                      <ItemPhoto tmplId={l.tmplId} sku={l.sku} size={36} canAdd />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-bold leading-snug">{nm(l)}</div>
                        {l.packLabel && l.packCount ? <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{fmtQty(l.packCount)} × {l.packLabel}</div> : null}
                        {l.offRecipe && <div className="text-[11px] font-bold" style={{ color: '#8A5A00' }}>⚠ {L('Ngoài công thức', 'Off recipe')}{l.usedFor ? ` · ${L('cho', 'for')}: ${l.usedFor}` : ''}</div>}
                      </div>
                      <input inputMode="decimal" value={pv[l.id] ?? fmtQty(l.qty)} onChange={e => setPv(v => ({ ...v, [l.id]: e.target.value }))}
                        className="w-20 rounded-md px-2 py-1.5 text-right text-[14px] font-extrabold tabular-nums" style={{ border: `1px solid ${pv[l.id] != null && pv[l.id] !== fmtQty(l.qty) ? LATE : GOLD}` }} />
                      <span className="w-7 text-xs font-bold" style={{ color: '#6B7280' }}>{l.uom}</span>{packHint(l) && <span className="text-[11px] font-semibold whitespace-nowrap" style={{ color: GOLD_TEXT }}>{packHint(l)}</span>}
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  {w.kind === 'transfer' && <button disabled={confirming === w.id} onClick={() => refuseSlip(w)} className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-bold bg-white" style={{ border: `1px solid ${BORDER}`, color: LATE }}>
                    <X size={14} /> {L('Từ chối', 'Refuse')}</button>}
                  <button disabled={confirming === w.id} onClick={() => confirmSlip(w)} className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-extrabold text-white" style={{ backgroundColor: NAVY }}>
                    {confirming === w.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />} {L('Xác nhận', 'Confirm')}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {([[todayVN(), L('Hôm nay', 'Today')], [addDays(todayVN(), -1), L('Hôm qua', 'Yesterday')]] as const).map(([d, lab]) => (
          <button key={d} onClick={() => setDate(d)} className="rounded-full px-3 py-1.5 text-[12.5px] font-extrabold"
            style={date === d ? { backgroundColor: NAVY, color: '#fff' } : { backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: '#6B7280' }}>{lab}</button>
        ))}
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="rounded-lg px-2.5 py-1.5 text-sm bg-white" style={{ border: `1px solid ${BORDER}` }} />
        <button onClick={load} className="p-1.5 rounded-md" style={{ color: '#6B7280' }}><RefreshCw size={14} /></button>
        {!!items?.length && <button onClick={() => setByItem(v => !v)} className="ml-auto text-[12px] font-extrabold rounded-lg px-2.5 py-1.5"
          style={byItem ? { backgroundColor: NAVY, color: '#fff' } : { border: `1px solid ${BORDER}`, color: GOLD_TEXT, backgroundColor: '#fff' }}>{L('Tổng theo nguyên liệu', 'Total per ingredient')}</button>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Kpi label={L('Phiếu', 'Slips')} value={String(items?.length ?? 0)} />
        <Kpi label={L('Dòng', 'Lines')} value={String(lines)} />
        <Kpi label={L('Đã sửa', 'Corrected')} value={String(corrected)} />
      </div>
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{err}</div>}
      {!items ? <div className="text-sm text-center py-6" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>
        : !items.length ? <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Chưa có phiếu lấy nào trong ngày.', 'No withdrawal that day.')}</div>
        : byItem ? (() => {
          const t = new Map<string, { name: string; uom: string; qty: number; teams: Set<string> }>();
          // Net storage outflow: withdrawals minus confirmed returns to storage (2026-10-17). A transfer
          // between two teams never touches storage.
          for (const w of items) {
            const back = w.kind === 'transfer' && w.toTeam === 'kho';
            if (w.kind === 'transfer' && (!back || w.status !== 'confirmed' || w.refused)) continue;
            for (const l of w.lines) {
              const k = `${l.tmplId ?? l.name}|${l.brand ?? ''}|${l.uom}`;
              const e = t.get(k) ?? { name: nm(l), uom: l.uom, qty: 0, teams: new Set<string>() };
              e.qty += (back ? -1 : 1) * (l.correctedQty ?? l.qty); e.teams.add(back ? (w.fromTeam ?? w.team) : w.team); t.set(k, e);
            }
          }
          const rows = Array.from(t.values()).sort((a, b) => a.name.localeCompare(b.name, lang === 'vi' ? 'vi' : 'en'));
          return (
            <div className="bg-white rounded-2xl px-4" style={{ border: `1px solid ${BORDER}` }}>
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-3 py-2.5" style={{ borderTop: i ? `1px solid ${HAIR}` : 'none' }}>
                  <span className="flex-1 text-[13.5px] font-bold">{r.name}</span>
                  <span className="flex gap-1">{Array.from(r.teams).map(tm => <TeamBadge key={tm} team={tm} lang={lang} />)}</span>
                  <span className="text-[15px] font-extrabold tabular-nums whitespace-nowrap">{fmtQty(r.qty)} <span className="text-[12px] font-bold" style={{ color: '#6B7280' }}>{r.uom}</span></span>
                </div>
              ))}
            </div>
          );
        })()
        : <div className="bg-white rounded-2xl px-4" style={{ border: `1px solid ${BORDER}` }}>
          {items.map(w => (
            <div key={w.id} className="py-3" style={{ borderTop: `1px solid ${HAIR}` }}>
              <div className="flex items-center gap-2 flex-wrap">
                <b className="text-[13px] tabular-nums">#{w.no}</b>
                <span className="text-xs flex-1" style={{ color: '#6B7280' }}>{vnDayTime(w.createdAt).time} · <SlipWho w={w} lang={lang} /> · {w.takenBy}</span>
                {w.refused
                  ? <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{L('Đã từ chối', 'Refused')}{w.refusedBy ? ` · ${w.refusedBy}` : ''}</span>
                  : w.status === 'to_confirm'
                  ? <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#FFF6E0', color: '#8A5A00' }}>⏳ {L('Chờ xác nhận', 'To confirm')}</span>
                  : w.lines.some(l => l.correctedQty != null)
                  ? <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#F2F4F7', color: '#344054' }}>{L('Kho đã sửa', 'Corrected')}{w.confirmedBy ? ` · ${w.confirmedBy}` : ''}</span>
                  : <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#ECFDF3', color: '#067647' }}>{L('Đã xác nhận', 'Confirmed')}{w.confirmedBy ? ` · ${w.confirmedBy}` : ''}</span>}
              </div>
              {edit === w.id ? (
                <div className="mt-2 space-y-1.5">
                  {w.lines.map(l => (
                    <div key={l.id} className="flex items-center gap-2 text-[12.5px]">
                      <span className="flex-1">{nm(l)}</span>
                      <input inputMode="decimal" defaultValue={fmtQty(l.correctedQty ?? l.qty)} onChange={e => setVal(v => ({ ...v, [l.id]: e.target.value }))}
                        className="w-20 rounded-md px-2 py-1 text-right font-bold" style={{ border: `1px solid ${GOLD}` }} />
                      <span className="w-6 text-xs" style={{ color: '#6B7280' }}>{l.uom}</span>
                    </div>
                  ))}
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => { setEdit(null); setVal({}); }} className="text-xs font-bold px-2" style={{ color: '#9CA3AF' }}>{L('Huỷ', 'Cancel')}</button>
                    <button onClick={() => save(w)} className="text-xs font-extrabold rounded-lg px-3 py-1.5 text-white" style={{ backgroundColor: NAVY }}>{L('Lưu', 'Save')}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-1.5">
                    {w.lines.map(l => (
                      <div key={l.id} className="flex items-center gap-3 py-1.5" style={{ borderTop: `1px solid ${HAIR}` }}>
                        <ItemPhoto tmplId={l.tmplId} sku={l.sku} size={36} canAdd />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-bold leading-snug">{nm(l)}</div>
                          {l.packLabel && l.packCount ? <div className="text-[11px]" style={{ color: '#9CA3AF' }}>{fmtQty(l.packCount)} × {l.packLabel}</div> : null}
                          {l.offRecipe && <div className="text-[11px] font-bold" style={{ color: '#8A5A00' }}>⚠ {L('Ngoài công thức', 'Off recipe')}{l.usedFor ? ` · ${L('cho', 'for')}: ${l.usedFor}` : ''}</div>}
                        </div>
                        <div className="text-right whitespace-nowrap">
                          <span className="text-[14px] font-extrabold tabular-nums">{fmtQty(l.correctedQty ?? l.qty)}</span> <span className="text-[12px] font-bold" style={{ color: '#6B7280' }}>{l.uom}</span>
                          {l.correctedQty != null && <div className="text-[11px] line-through tabular-nums" style={{ color: '#9CA3AF' }}>{fmtQty(l.qty)} {l.uom}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {w.status !== 'to_confirm' && !w.refused && <button onClick={() => setEdit(w.id)} className="mt-1 inline-flex items-center gap-1 text-xs font-bold" style={{ color: GOLD_TEXT }}><Pencil size={12} /> {L('Sửa', 'Correct')}</button>}
                </>
              )}
            </div>
          ))}
        </div>}
    </div>
  );
}

/* ===================== History ===================== */
// The feature started in October 2026 (Axel, 2026-10-08: "ça sert à rien de mettre les mois précédents"):
// no month chip before it. Older months appear on their own as time goes by (6 chips at most).
const HISTORY_START = '2026-10';
function monthKey(offset: number): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const MONTHS_VI = ['Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6', 'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function weekStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}
const ddmm = (ymd: string) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function HistoryTab({ L, lang }: { L: LFn; lang: 'vi' | 'en' }) {
  const [month, setMonth] = useState(monthKey(0));
  const [items, setItems] = useState<PurchaseLine[] | null>(null);
  const [view, setView] = useState<'lines' | 'products'>('lines');
  const [status, setStatus] = useState<'all' | PurchaseLine['status']>('all');
  const [team, setTeam] = useState<string>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setItems(null); getHistoryAction(month).then(r => { if (r.error) setErr(r.error); else { setErr(null); setItems(r.items!); } }); }, [month]);
  // Names in the screen's language (Axel, 2026-10-13) — same catalogue name_vi as the other tabs.
  const [viName, setViName] = useState<Map<number, string>>(new Map());
  useEffect(() => { getCatalogueAction().then(r => setViName(new Map((r.items ?? []).filter(m => m.nameVi).map(m => [m.tmplId, m.nameVi as string])))); }, []);
  const nm = (l: { tmplId: number | null; name: string }) => (lang === 'vi' && l.tmplId != null && viName.get(l.tmplId)) || l.name;
  const all = items ?? [];
  const teams = Array.from(new Set(all.map(l => l.team)));
  const shown = all.filter(l => (status === 'all' || l.status === status || (status === 'ordered' && l.status === 'received')) && (team === 'all' || l.team === team)
    && (!q.trim() || `${l.name} ${nm(l)} ${l.poRef ?? ''} ${l.requestedBy ?? ''} ${l.vendorName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const base = all.filter(l => team === 'all' || l.team === team);
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const reqToOrder = avg(base.map(l => daysBetween(l.createdAt, l.orderedAt)));
  const lateLines = base.filter(l => l.status === 'pending' && Date.now() - new Date(l.createdAt).getTime() >= 2 * 86400000);
  const ordered = base.filter(l => l.status === 'ordered' || l.status === 'received').length;
  const fmtDays = (v: number | null) => (v == null ? '—' : `${v.toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: 1 })} ${L('ngày', 'days')}`);
  const counts = (s: string) => base.filter(l => s === 'all' || l.status === s || (s === 'ordered' && l.status === 'received')).length;

  // By week (Monday), newest first.
  const weeks = new Map<string, PurchaseLine[]>();
  for (const l of shown) { const k = weekStart(vnDayTime(l.createdAt).ymd); const a = weeks.get(k) ?? []; a.push(l); weeks.set(k, a); }
  const weekKeys = Array.from(weeks.keys()).sort().reverse();
  const thisWeek = weekStart(todayVN());

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        {[0, 1, 2, 3, 4, 5].map(o => monthKey(o)).filter(k => k >= HISTORY_START).map(k => { const mi = Number(k.slice(5)) - 1; return (
          <button key={k} onClick={() => setMonth(k)} className="rounded-full px-3 py-1.5 text-[12.5px] font-bold" style={{ backgroundColor: month === k ? NAVY : '#fff', color: month === k ? '#fff' : NAVY, border: `1px solid ${month === k ? NAVY : BORDER}` }}>
            {lang === 'vi' ? MONTHS_VI[mi] : MONTHS_EN[mi]}{k.slice(0, 4) !== monthKey(0).slice(0, 4) ? ` ${k.slice(0, 4)}` : ''}</button>); })}
        <div className="flex rounded-lg overflow-hidden ml-auto" style={{ border: `1px solid ${BORDER}` }}>
          {([['lines', L('Theo dòng', 'By line')], ['products', L('Theo sản phẩm', 'By product')]] as const).map(([k, t]) => (
            <button key={k} onClick={() => setView(k)} className="px-3 py-1.5 text-[12.5px] font-extrabold" style={{ backgroundColor: view === k ? NAVY : '#fff', color: view === k ? '#fff' : GOLD_TEXT }}>{t}</button>))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={L('Dòng yêu cầu', 'Requested lines')} value={String(base.length)} />
        <Kpi label={L('Đã đặt', 'Ordered')} value={String(ordered)} sub={base.length ? `${Math.round(ordered / base.length * 100)} % ${L('số dòng', 'of lines')}` : undefined} />
        <Kpi label={L('Yêu cầu → đặt', 'Request → ordered')} value={fmtDays(reqToOrder)} sub={L('trung bình', 'average')} />
        <Kpi label={L('Chờ quá 2 ngày', 'Waiting over 2 days')} value={String(lateLines.length)} sub={lateLines.slice(0, 2).map(l => nm(l)).join(', ')} warn={lateLines.length > 0} />
      </div>
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{err}</div>}
      {!items ? <div className="text-sm text-center py-6" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div> : view === 'lines' ? (
        <>
          <div className="flex gap-1.5 flex-wrap items-center">
            {([['all', L('Tất cả', 'All')], ['pending', L('Chờ xử lý', 'Pending')], ['ordered', L('Đã đặt', 'Ordered')], ['cancelled', L('Đã huỷ', 'Cancelled')]] as const).map(([k, t]) => (
              <button key={k} onClick={() => setStatus(k as any)} className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: status === k ? PALE : '#fff', color: status === k ? GOLD_TEXT : '#344054', border: `1px solid ${status === k ? GOLD : BORDER}` }}>
                {t} <span className="font-semibold opacity-70">{counts(k)}</span></button>))}
            {teams.length > 1 && <>
              <span className="w-px h-5 mx-1" style={{ backgroundColor: BORDER }} />
              {['all', ...teams].map(t => <button key={t} onClick={() => setTeam(t)} className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: team === t ? PALE : '#fff', color: team === t ? GOLD_TEXT : '#344054', border: `1px solid ${team === t ? GOLD : BORDER}` }}>{t === 'all' ? L('Tất cả team', 'All teams') : (TEAM_SHORT[t]?.[lang] ?? t)}</button>)}
            </>}
            <label className="flex items-center gap-1.5 rounded-lg px-2.5 bg-white ml-auto" style={{ border: `1px solid ${BORDER}`, minWidth: 220 }}>
              <Search size={13} style={{ color: '#9CA3AF' }} />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nguyên liệu, PO, người yêu cầu…', 'Search raw material, PO, requester…')} className="flex-1 py-1.5 text-[12.5px] outline-none bg-transparent" />
            </label>
          </div>
          {!weekKeys.length && <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Không có dòng nào.', 'No line.')}</div>}
          {weekKeys.map(wk => { const ls = weeks.get(wk)!; return (
            <div key={wk} className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              <div className="flex justify-between items-baseline px-4 py-2.5" style={{ backgroundColor: PALE, borderBottom: `1px solid ${HAIR}` }}>
                <b className="text-[13px]" style={{ color: NAVY }}>{wk === thisWeek ? L('Tuần này', 'This week') : wk === addDays(thisWeek, -7) ? L('Tuần trước', 'Last week') : L('Tuần', 'Week')} · {ddmm(wk)} – {ddmm(addDays(wk, 6))}</b>
                <span className="text-[11.5px]" style={{ color: '#6B7280' }}>{ls.length} {L('dòng', 'lines')} · {ls.filter(l => l.status === 'ordered' || l.status === 'received').length} {L('đã đặt', 'ordered')}</span>
              </div>
              {ls.map(l => { const o = open[l.id]; const dt = vnDayTime(l.createdAt); const age = Math.floor((Date.now() - new Date(l.createdAt).getTime()) / 86400000); return (
                <div key={l.id} style={{ borderTop: `1px solid ${HAIR}` }}>
                  <button onClick={() => setOpen(s => ({ ...s, [l.id]: !s[l.id] }))} className="w-full text-left grid gap-3 items-center px-4 py-2.5 hover:bg-[#FFFDF6]" style={{ gridTemplateColumns: 'minmax(56px,70px) minmax(160px,1.4fr) minmax(120px,1fr) minmax(160px,200px) 18px' }}>
                    <div><b className="block text-[12.5px] tabular-nums">{dt.day}</b><span className="text-[11px]" style={{ color: '#9CA3AF' }}>{dt.time}</span></div>
                    <div className="min-w-0 flex items-center gap-2"><ItemPhoto tmplId={l.tmplId} sku={l.sku} size={36} canAdd /><div className="min-w-0"><b className="block text-[13px] truncate">{nm(l)}{l.isNew && <span className="ml-1 text-[10px] font-extrabold rounded px-1" style={{ backgroundColor: '#F2F4F7' }}>{L('MỚI', 'NEW')}</span>}</b>
                      <span className="text-[11.5px]" style={{ color: '#6B7280' }}>{fmtQty(l.qty)} {l.uom}{packHint(l) && <span style={{ color: GOLD_TEXT }}> ({packHint(l)})</span>} · <TeamBadge team={l.team} lang={lang} /> {l.requestedBy}</span></div></div>
                    <div className="text-[12px] min-w-0">{l.vendorName ? <span className="truncate block">{shortVendor(l.vendorName)}</span> : <span className="font-bold" style={{ color: LATE }}>{L('Chưa có NCC', 'No vendor yet')}</span>}
                      <span className="text-[11px]" style={{ color: '#9CA3AF' }}>{l.poRef ? `PO ${l.poRef}` : l.status === 'pending' && age >= 2 ? <span className="font-extrabold rounded px-1" style={{ backgroundColor: '#FEF3F2', color: LATE }}>{L(`chờ ${age} ngày`, `waiting ${age} days`)}</span> : ''}</span></div>
                    <Track l={l} L={L} />
                    {o ? <ChevronDown size={14} style={{ color: '#9CA3AF' }} /> : <ChevronRight size={14} style={{ color: '#9CA3AF' }} />}
                  </button>
                  {o && (
                    <div className="px-4 pb-3 pt-1 text-[12.5px] grid sm:grid-cols-2 gap-x-6 gap-y-1" style={{ backgroundColor: '#FCFAF3' }}>
                      <div><span style={{ color: '#6B7280' }}>{L('Yêu cầu bởi', 'Requested by')}</span> {l.requestedBy} · {dt.day} {dt.time} · #{l.requestNo}</div>
                      <div><span style={{ color: '#6B7280' }}>{L('Số lượng', 'Quantity')}</span> {fmtQty(l.qty)} {l.uom}{packHint(l) && <span style={{ color: GOLD_TEXT }}> ({packHint(l)})</span>}</div>
                      {l.brand && <div><span style={{ color: '#6B7280' }}>{L('Thương hiệu', 'Brand')}</span> {l.brand} · {l.brandStrict ? L('bắt buộc', 'required') : L('nếu có', 'if possible')}</div>}
                      {l.note && <div><span style={{ color: '#6B7280' }}>{L('Ghi chú', 'Note')}</span> {l.note}</div>}
                      <div className="sm:col-span-2 mt-1 space-y-0.5">
                        <Ev at={l.createdAt} text={L(`Chef ${l.requestedBy ?? ''} gửi yêu cầu`, `Chef ${l.requestedBy ?? ''} sent the request`)} />
                        {l.approvedAt && <Ev at={l.approvedAt} text={`${l.approvedBy ?? ''} ${L('duyệt', 'approved')}${l.requestedQty != null ? ` · ${L('SL sửa', 'qty changed')} ${fmtQty(l.requestedQty)} → ${fmtQty(l.qty)} ${l.uom}` : ''}`} />}
                        {l.orderedAt && <Ev at={l.orderedAt} text={`${l.orderedBy ?? ''} ${L('đặt hàng', 'ordered')}${l.poRef ? ` · PO ${l.poRef}` : ''}${l.vendorName ? ` · ${shortVendor(l.vendorName)}` : ''}`} />}
                        {l.cancelledAt && <Ev at={l.cancelledAt} text={L('Đã huỷ', 'Cancelled')} />}
                      </div>
                      {(l.status === 'ordered' || l.status === 'cancelled') && (
                        <div className="sm:col-span-2"><button onClick={async () => { const r = await undoLineStepAction(l.id); if (r.error) setErr(r.error); else { const h = await getHistoryAction(month); if (h.items) setItems(h.items); } }}
                          className="inline-flex items-center gap-1 text-[11.5px] font-bold mt-1" style={{ color: GOLD_TEXT }}><RotateCcw size={12} /> {L('Hoàn tác (trả về “chờ xử lý”)', 'Undo (back to “pending”)')}</button></div>
                      )}
                    </div>
                  )}
                </div>); })}
            </div>); })}
        </>
      ) : <ByProduct items={base} L={L} month={month} nm={nm} />}
    </div>
  );
}
function Ev({ at, text }: { at: string; text: string }) {
  const d = vnDayTime(at);
  return <div className="flex gap-3 text-[12px]"><b className="w-24 flex-none tabular-nums" style={{ color: '#6B7280' }}>{d.day} {d.time}</b><span>{text}</span></div>;
}
function ByProduct({ items, L, month, nm }: { items: PurchaseLine[]; L: LFn; month: string; nm: (l: { tmplId: number | null; name: string }) => string }) {
  const live = items.filter(l => l.status !== 'cancelled');
  const by = new Map<string, PurchaseLine[]>();
  for (const l of live) { const k = String(l.tmplId ?? l.name); const a = by.get(k) ?? []; a.push(l); by.set(k, a); }
  const first = weekStart(`${month}-01`);
  const weeks = [0, 1, 2, 3, 4].map(i => addDays(first, i * 7)).filter(w => w.slice(0, 7) <= month);
  const rows = Array.from(by.values()).map(ls => {
    const vendCount = new Map<string, number>(); ls.forEach(l => { if (l.vendorName) vendCount.set(l.vendorName, (vendCount.get(l.vendorName) ?? 0) + 1); });
    const usual = Array.from(vendCount.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const leads = ls.map(l => daysBetween(l.createdAt, l.orderedAt)).filter((x): x is number => x != null);
    const perWeek = weeks.map(w => ls.filter(l => weekStart(vnDayTime(l.createdAt).ymd) === w).reduce((s, l) => s + l.qty, 0));
    return { name: nm(ls[0]), uom: ls[0].uom, n: ls.length, qty: ls.reduce((s, l) => s + l.qty, 0), usual, lead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null, perWeek };
  }).sort((a, b) => b.n - a.n || b.qty - a.qty);
  if (!rows.length) return <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Không có dòng nào.', 'No line.')}</div>;
  return (
    <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: `1px solid ${BORDER}` }}>
      <table className="w-full text-[12.5px]" style={{ minWidth: 640 }}>
        <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: '#9CA3AF' }}>
          <th className="text-left px-3 py-2">{L('Nguyên liệu', 'Raw material')}</th><th className="text-right px-3 py-2">{L('Số lần yêu cầu', 'Requests')}</th>
          <th className="text-right px-3 py-2">{L('Tổng SL trong tháng', 'Total qty (month)')}</th><th className="text-left px-3 py-2">{L('Theo tuần', 'By week')}</th>
          <th className="text-left px-3 py-2">{L('NCC thường dùng', 'Usual vendor')}</th><th className="text-right px-3 py-2">{L('Yêu cầu → đặt TB', 'Avg request → ordered')}</th></tr></thead>
        <tbody>
          {rows.map(r => { const mx = Math.max(...r.perWeek, 1); return (
            <tr key={r.name} style={{ borderTop: `1px solid ${HAIR}` }}>
              <td className="px-3 py-2"><b>{r.name}</b></td><td className="px-3 py-2 text-right tabular-nums">{r.n}</td>
              <td className="px-3 py-2 text-right tabular-nums"><b>{fmtQty(r.qty)} {r.uom}</b></td>
              <td className="px-3 py-2"><div className="flex gap-0.5 items-end h-6">{r.perWeek.map((v, i) => <i key={i} title={`${fmtQty(v)} ${r.uom}`} className="block w-2.5 rounded-t-sm" style={{ height: v ? Math.max(4, v / mx * 24) : 2, backgroundColor: v ? NAVY : HAIR }} />)}</div></td>
              <td className="px-3 py-2">{r.usual ? shortVendor(r.usual) : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.lead == null ? '—' : `${r.lead.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} ${L('ngày', 'days')}`}</td>
            </tr>); })}
        </tbody>
      </table>
    </div>
  );
}

/* ===================== Catalogue ===================== */
function CatalogueTab({ L, lang }: { L: LFn; lang: 'vi' | 'en' }) {
  const [items, setItems] = useState<RawMaterial[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<'todo' | 'ok' | 'hidden' | 'all'>('todo');
  const [type, setType] = useState<'all' | RawType>('all');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [packFor, setPackFor] = useState<number | null>(null);
  const [packLabel, setPackLabel] = useState(''); const [packFactor, setPackFactor] = useState('');
  const [brandFor, setBrandFor] = useState<number | null>(null); const [brandText, setBrandText] = useState('');
  const [cf, setCf] = useState<Partial<Record<ColKey, Set<string>>>>({});
  const [sort, setSort] = useState<{ key: 'name' | 'bom'; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [openCol, setOpenCol] = useState<{ k: ColKey; rect: { left: number; bottom: number }; sorts?: ColSortOpt[] } | null>(null);
  const load = useCallback(async () => { const r = await getCatalogueAction(); if (r.error) setMsg(r.error); else { setItems(r.items!); setSyncedAt(r.syncedAt ?? null); } }, []);
  useEffect(() => { load(); }, [load]);
  async function sync() {
    setSyncing(true); setMsg(null);
    const r = await syncCatalogueAction();
    setSyncing(false);
    setMsg(r.error ? r.error : L(`Đã đồng bộ: ${r.added} mới, ${r.updated} cập nhật, ${r.removed} ngừng dùng.`, `Synced: ${r.added} new, ${r.updated} updated, ${r.removed} no longer active.`));
    load();
  }
  async function patch(m: RawMaterial, p: Parameters<typeof updateMaterialAction>[1]) {
    setItems(xs => xs ? xs.map(x => x.tmplId === m.tmplId ? { ...x, ...(p as any) } : x) : xs);
    const r = await updateMaterialAction(m.tmplId, p);
    if (r.error) { setMsg(r.error); load(); }
  }
  async function savePack(m: RawMaterial) {
    const f = parseFloat(packFactor.replace(',', '.'));
    if (!packLabel.trim() || !(f > 0)) return;
    await patch(m, { packs: [...m.packs, { label: packLabel.trim(), factor: f }] });
    setMsg(L(`Đã lưu: 1 ${packLabel.trim()} = ${fmtQty(f)} ${m.uom} (${rawName(m, lang)})`, `Saved: 1 ${packLabel.trim()} = ${fmtQty(f)} ${m.uom} (${rawName(m, lang)})`));
    setPackFor(null); setPackLabel(''); setPackFactor('');
  }
  async function saveBrand(m: RawMaterial) {
    if (!brandText.trim()) return;
    await patch(m, { brands: [...(m.brands ?? []), brandText.trim()] });
    setBrandFor(null); setBrandText('');
  }
  const all = items ?? [];
  // Names in the screen's language (Axel, 2026-10-12): Vietnamese name when the app is in VI, Odoo name
  // kept underneath; the search matches both names and the SKU, accents ignored.
  const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const nq = fold(q.trim());
  const base = all.filter(m => (filter === 'all' || (filter === 'todo' ? !m.checked && m.visible : filter === 'ok' ? m.checked && m.visible : !m.visible))
    && (type === 'all' || m.type === type) && (!nq || nq.split(/\s+/).every(w => fold(`${m.name} ${m.nameVi ?? ''} ${m.sku ?? ''}`).includes(w))));
  // Excel-like column filters (Axel, 2026-10-12): each header opens a checklist of its values with
  // counts; filters combine with each other and with the chips above. Sort on name / recipes.
  const colVal = (m: RawMaterial, k: ColKey): string => {
    switch (k) {
      case 'vendor': return m.vendorName ?? '__none';
      case 'uom': return m.uom || '—';
      case 'type': return m.type;
      case 'group': return `${m.type}|${m.sub}`;
      case 'packs': return m.packs.length ? 'yes' : 'no';
      case 'recipes': return m.bomCount != null && m.bomCount > 0 ? 'has' : m.noRecipeNeeded ? 'nr' : m.bomCount === 0 ? 'none' : 'unk';
      case 'visible': return m.visible ? 'on' : 'off';
      case 'status': return m.checked ? 'checked' : 'todo';
    }
  };
  const colLabel = (k: ColKey, v: string): string => {
    switch (k) {
      case 'vendor': return v === '__none' ? L('Chưa có NCC', 'No vendor') : shortVendor(v);
      case 'type': return typeLabel(v as RawType, lang);
      case 'group': { const [t, sb] = v.split('|'); return `${subLabel(t as RawType, sb, lang)} · ${typeLabel(t as RawType, lang)}`; }
      case 'packs': return v === 'yes' ? L('Có quy cách', 'Has packs') : L('Chưa có quy cách', 'No pack');
      case 'recipes': return v === 'has' ? L('Có công thức', 'Used in recipes') : v === 'nr' ? L('Không cần công thức', 'No recipe needed') : v === 'none' ? L('⚠ Chưa có', '⚠ None') : L('Chưa rõ', 'Unknown');
      case 'visible': return v === 'on' ? L('Chef thấy', 'Shown to chefs') : L('Ẩn', 'Hidden');
      case 'status': return v === 'checked' ? L('Đã duyệt', 'Checked') : L('Gợi ý', 'Suggested');
      default: return v;
    }
  };
  const FIXED_ORDER: Partial<Record<ColKey, string[]>> = { recipes: ['has', 'none', 'nr', 'unk'], packs: ['yes', 'no'], visible: ['on', 'off'], status: ['todo', 'checked'], type: Object.keys(RAW_TYPES) };
  const passCols = (m: RawMaterial, except: ColKey | null) =>
    (Object.keys(cf) as ColKey[]).every(k => k === except || !cf[k] || cf[k]!.has(colVal(m, k)));
  const optionsFor = (k: ColKey) => {
    const cnt = new Map<string, number>();
    for (const m of base) if (passCols(m, k)) { const v = colVal(m, k); cnt.set(v, (cnt.get(v) ?? 0) + 1); }
    for (const v of Array.from(cf[k] ?? [])) if (!cnt.has(v)) cnt.set(v, 0);
    const opts = Array.from(cnt.entries()).map(([key, count]) => ({ key, label: colLabel(k, key), count }));
    const fo = FIXED_ORDER[k];
    return fo ? opts.sort((a, b) => fo.indexOf(a.key) - fo.indexOf(b.key)) : opts.sort((a, b) => a.label.localeCompare(b.label, lang === 'vi' ? 'vi' : 'en'));
  };
  const coll = lang === 'vi' ? 'vi' : 'en';
  const rows = base.filter(m => passCols(m, null)).sort((a, b) => sort.key === 'bom'
    ? sort.dir * ((a.bomCount ?? -1) - (b.bomCount ?? -1)) || rawName(a, lang).localeCompare(rawName(b, lang), coll)
    : sort.dir * rawName(a, lang).localeCompare(rawName(b, lang), coll));
  const activeCols = (Object.keys(cf) as ColKey[]).filter(k => cf[k]);
  const colTitle: Record<ColKey, string> = { vendor: L('Nhà cung cấp', 'Vendor'), uom: L('Đơn vị', 'Unit'), type: L('Loại', 'Type'), group: L('Nhóm', 'Group'), packs: L('Quy cách', 'Packs'), recipes: L('Công thức', 'Recipes'), visible: L('Chef thấy', 'Chefs see'), status: L('Trạng thái', 'Status') };
  const Th = ({ k, label, align = 'left', sorts }: { k: ColKey; label: string; align?: 'left' | 'center' | 'right'; sorts?: ColSortOpt[] }) => {
    const on = !!cf[k] || (!!sorts && sorts.some(o => o.key === sort.key && (o.key !== 'name' || sort.dir !== 1)));
    return (
      <th className={`px-3 py-2 whitespace-nowrap text-${align}`}>
        <button onMouseDown={e => e.stopPropagation()} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setOpenCol(openCol?.k === k ? null : { k, rect: { left: r.left, bottom: r.bottom }, sorts }); }}
          className="inline-flex items-center gap-1 uppercase tracking-wide font-bold rounded px-1 -mx-1 py-0.5 hover:bg-[#FFFAEE]" style={{ color: on ? GOLD_TEXT : '#9CA3AF' }}>
          {label}<ListFilter size={12} strokeWidth={on ? 2.6 : 2} style={{ color: on ? GOLD : '#C0C4CC' }} />
        </button>
      </th>
    );
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={L('Nguyên liệu Odoo', 'Odoo raw materials')} value={String(all.length)} sub={L('không gồm bao bì', 'packaging excluded')} />
        <Kpi label={L('Chef thấy', 'Shown to chefs')} value={String(all.filter(m => m.visible).length)} />
        <Kpi label={L('Chờ duyệt', 'To check')} value={String(all.filter(m => m.visible && !m.checked).length)} warn={all.some(m => m.visible && !m.checked)} />
        <div className="bg-white rounded-xl px-3 py-2.5 flex flex-col justify-between" style={{ border: `1px solid ${BORDER}` }}>
          <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{L('Đồng bộ Odoo', 'Odoo sync')}</div>
          <div className="text-[11px]" style={{ color: '#6B7280' }}>{syncedAt ? `${vnDayTime(syncedAt).day} ${vnDayTime(syncedAt).time}` : L('chưa bao giờ', 'never')}</div>
          <button onClick={sync} disabled={syncing} className="mt-1 inline-flex items-center justify-center gap-1 rounded-lg py-1.5 text-xs font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: NAVY }}>
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {L('Đồng bộ', 'Sync')}</button>
        </div>
      </div>
      {msg && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: PALE, color: GOLD_TEXT, border: `1px solid ${BORDER}` }}>{msg}</div>}
      <div className="flex gap-1.5 flex-wrap items-center">
        {([['todo', L('Chờ duyệt', 'To check')], ['ok', L('Đã duyệt', 'Checked')], ['hidden', L('Đã ẩn', 'Hidden')], ['all', L('Tất cả', 'All')]] as const).map(([k, t]) => (
          <button key={k} onClick={() => setFilter(k)} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ backgroundColor: filter === k ? NAVY : '#fff', color: filter === k ? '#fff' : NAVY, border: `1px solid ${filter === k ? NAVY : BORDER}` }}>{t}</button>))}
        <span className="w-px h-5 mx-1" style={{ backgroundColor: BORDER }} />
        {(['all', 'dry', 'fresh', 'frozen'] as const).map(t => (
          <button key={t} onClick={() => setType(t)} className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: type === t ? PALE : '#fff', color: type === t ? GOLD_TEXT : '#344054', border: `1px solid ${type === t ? GOLD : BORDER}` }}>{t === 'all' ? L('Mọi loại', 'All types') : typeLabel(t, lang)}</button>))}
        <label className="flex items-center gap-1.5 rounded-lg px-2.5 bg-white" style={{ border: `1px solid ${BORDER}`, minWidth: 200 }}>
          <Search size={13} style={{ color: '#9CA3AF' }} /><input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm…', 'Search…')} className="flex-1 py-1.5 text-[12.5px] outline-none bg-transparent" />
        </label>
        {filter === 'todo' && rows.length > 0 && (
          <button onClick={async () => { const idsToCheck = rows.map(r => r.tmplId); setItems(xs => xs ? xs.map(x => idsToCheck.includes(x.tmplId) ? { ...x, checked: true } : x) : xs); const r = await checkMaterialsAction(idsToCheck); if (r.error) { setMsg(r.error); load(); } }}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-extrabold" style={{ border: `1px solid ${NAVY}`, color: NAVY, backgroundColor: '#fff' }}><Check size={13} /> {L(`Duyệt ${rows.length} dòng đang hiện`, `Accept the ${rows.length} shown`)}</button>
        )}
      </div>
      {(activeCols.length > 0 || sort.key !== 'name' || sort.dir !== 1) && (
        <div className="flex items-center gap-1.5 flex-wrap text-xs">
          <span className="font-bold" style={{ color: '#6B7280' }}>{L('Lọc theo cột:', 'Column filters:')}</span>
          {activeCols.map(k => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1.5 py-1 font-bold" style={{ backgroundColor: PALE, border: `1px solid ${GOLD}`, color: GOLD_TEXT }}>
              {colTitle[k]} ({cf[k]!.size})
              <button onClick={() => setCf(c => { const n = { ...c }; delete n[k]; return n; })} aria-label="clear"><X size={12} /></button>
            </span>))}
          {(sort.key !== 'name' || sort.dir !== 1) && <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-bold" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: NAVY }}><ArrowUpDown size={11} /> {sort.key === 'bom' ? L('Công thức', 'Recipes') : L('Tên Z → A', 'Name Z → A')}</span>}
          <button onClick={() => { setCf({}); setSort({ key: 'name', dir: 1 }); }} className="font-extrabold underline ml-1" style={{ color: NAVY }}>{L('Bỏ tất cả', 'Clear all')}</button>
          <span style={{ color: '#9CA3AF' }}>· {rows.length} {L('dòng', 'rows')}</span>
        </div>
      )}
      {openCol && (
        <ColFilterPop L={L} rect={openCol.rect} title={colTitle[openCol.k]} options={optionsFor(openCol.k)} selected={cf[openCol.k]}
          onChange={sel => setCf(c => { const n = { ...c }; if (sel) n[openCol.k] = sel; else delete n[openCol.k]; return n; })}
          sorts={openCol.sorts} sort={sort} onSort={(key, dir) => setSort({ key, dir })} onClose={() => setOpenCol(null)} />
      )}
      {!items ? <div className="text-sm text-center py-6" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>
        : !all.length ? <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#6B7280' }}>{L('Danh mục trống — bấm “Đồng bộ” để lấy nguyên liệu từ Odoo.', 'Empty catalogue — press “Sync” to load the raw materials from Odoo.')}</div>
        : (
        <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: `1px solid ${BORDER}` }}>
          <table className="w-full text-[12.5px]" style={{ minWidth: 860 }}>
            <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: '#9CA3AF' }}>
              <Th k="vendor" label={L('Nguyên liệu', 'Raw material (Odoo name)')} sorts={[{ key: 'name', dir: 1, label: L('Tên A → Z', 'Name A → Z') }, { key: 'name', dir: -1, label: L('Tên Z → A', 'Name Z → A') }]} />
              <Th k="uom" label={L('Đơn vị', 'Unit')} /><Th k="type" label={L('Loại', 'Type')} /><Th k="group" label={L('Nhóm', 'Group')} />
              <Th k="packs" label={L('Quy cách', 'Packs')} />
              <Th k="recipes" label={L('Công thức', 'Recipes')} align="center" sorts={[{ key: 'bom', dir: -1, label: L('Nhiều công thức nhất', 'Most recipes first') }, { key: 'bom', dir: 1, label: L('Ít công thức nhất', 'Fewest recipes first') }]} />
              <Th k="visible" label={L('Chef thấy', 'Chefs see')} align="center" /><Th k="status" label={L('Trạng thái', 'Status')} align="right" /></tr></thead>
            <tbody>
              {rows.slice(0, 400).map(m => (
                <tr key={m.tmplId} style={{ borderTop: `1px solid ${HAIR}` }}>
                  <td className="px-3 py-2"><div className="flex items-center gap-2.5"><ItemPhoto tmplId={m.tmplId} sku={m.sku} size={40} canAdd /><div className="min-w-0"><b>{rawName(m, lang)}</b>{lang === 'vi' && m.nameVi && m.nameVi !== m.name && <div className="text-[11px]" style={{ color: '#6B7280' }}>{m.name}</div>}<div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{m.sku ?? '—'} · {m.vendorName ? shortVendor(m.vendorName) : L('chưa có NCC', 'no vendor')}{!m.purchased ? ` · ${L('chưa từng mua', 'never bought')}` : ''}</div></div></div></td>
                  <td className="px-3 py-2">{m.uom}</td>
                  <td className="px-3 py-2"><select value={m.type} onChange={e => { const t = e.target.value as RawType; patch(m, { type: t, sub: Object.keys(RAW_TYPES[t].subs)[0] }); }} className="rounded-md px-1.5 py-1 text-xs bg-white" style={{ border: `1px solid ${HAIR}` }}>
                    {(Object.keys(RAW_TYPES) as RawType[]).map(t => <option key={t} value={t}>{typeLabel(t, lang)}</option>)}</select></td>
                  <td className="px-3 py-2"><select value={m.sub} onChange={e => patch(m, { sub: e.target.value })} className="rounded-md px-1.5 py-1 text-xs bg-white" style={{ border: `1px solid ${HAIR}` }}>
                    {Object.keys(RAW_TYPES[m.type].subs).map(s => <option key={s} value={s}>{subLabel(m.type, s, lang)}</option>)}</select></td>
                  <td className="px-3 py-2 text-[11.5px]">
                    {/* Packs the chefs can order / take in (Axel, 2026-10-21) — "1 túi = 0,02 kg"; Odoo's own unit never changes. */}
                    {m.packs.map((p, i) => <div key={i} className="flex items-center gap-1 whitespace-nowrap">1 <b>{p.label}</b> <span style={{ color: '#6B7280' }}>= {fmtQty(p.factor)} {m.uom}</span>
                      <button onClick={() => patch(m, { packs: m.packs.filter((_, j) => j !== i) })} style={{ color: '#9CA3AF' }}><X size={11} /></button></div>)}
                    {packFor === m.tmplId ? (
                      <div className="flex items-center gap-1 mt-1">
                        <span>1</span><input autoFocus value={packLabel} onChange={e => setPackLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') savePack(m); if (e.key === 'Escape') setPackFor(null); }} placeholder={L('vd túi, hộp 2 kg', 'e.g. bag, box 2 kg')} className="w-24 rounded px-1.5 py-0.5 text-[11px]" style={{ border: `1px solid ${BORDER}` }} />
                        <span>=</span><input value={packFactor} onChange={e => setPackFactor(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') savePack(m); if (e.key === 'Escape') setPackFor(null); }} inputMode="decimal" placeholder="0,5" className="w-14 rounded px-1.5 py-0.5 text-[11px] text-right" style={{ border: `1px solid ${BORDER}` }} />{m.uom}
                        {/* Explicit Save button (Axel, 2026-10-23): the small ✓ was not seen as "save" and packs were lost. */}
                        <button onClick={() => savePack(m)} disabled={!packLabel.trim() || !(parseFloat(packFactor.replace(',', '.')) > 0)}
                          className="rounded-md px-2 py-0.5 text-[11px] font-bold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>{L('Lưu', 'Save')}</button>
                        <button onClick={() => setPackFor(null)} aria-label={L('Huỷ', 'Cancel')} style={{ color: '#9CA3AF' }}><X size={12} /></button>
                      </div>
                    ) : <button onClick={() => { setPackFor(m.tmplId); setPackLabel(''); setPackFactor(''); }} className="text-[11px] font-bold rounded-md px-1.5 py-0.5 mt-0.5" style={{ color: GOLD_TEXT, border: `1px dashed ${GOLD}` }}>+ {L('quy cách / đơn vị', 'pack / unit')}</button>}
                    {/* Brands (2026-10-19): the chef picks one on the storage slip; Odoo keeps one product. */}
                    {(m.brands ?? []).length > 0 && <div className="flex flex-wrap gap-1 mt-1">{m.brands.map(b => (
                      <span key={b} className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-bold" style={{ backgroundColor: PALE, color: GOLD_TEXT }}>{b}
                        <button onClick={() => patch(m, { brands: m.brands.filter(x => x !== b) })} aria-label={L('Xoá', 'Remove')} style={{ color: '#9CA3AF' }}><X size={10} /></button></span>))}</div>}
                    {brandFor === m.tmplId ? (
                      <div className="flex items-center gap-1 mt-1">
                        <input autoFocus value={brandText} onChange={e => setBrandText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveBrand(m); if (e.key === 'Escape') setBrandFor(null); }} placeholder={L('vd Paysan Breton', 'e.g. Paysan Breton')} className="w-28 rounded px-1.5 py-0.5 text-[11px]" style={{ border: `1px solid ${BORDER}` }} />
                        <button onClick={() => saveBrand(m)} disabled={!brandText.trim()} className="rounded-md px-2 py-0.5 text-[11px] font-bold text-white disabled:opacity-40" style={{ backgroundColor: NAVY }}>{L('Lưu', 'Save')}</button>
                        <button onClick={() => setBrandFor(null)} aria-label={L('Huỷ', 'Cancel')} style={{ color: '#9CA3AF' }}><X size={12} /></button>
                      </div>
                    ) : <button onClick={() => { setBrandFor(m.tmplId); setBrandText(''); }} className="block text-[11px] font-bold mt-0.5" style={{ color: GOLD_TEXT }}>+ {L('thương hiệu', 'brand')}</button>}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    {/* Off-recipe alert at the station (Axel, 2026-10-09): number of Odoo recipes using it, and
                        "no recipe needed" for ice, spray… so the chefs are never asked about them. */}
                    {m.bomCount != null && m.bomCount > 0
                      ? <span className="text-[11px] font-bold" style={{ color: '#067647' }}>{m.bomCount}</span>
                      : <button onClick={() => patch(m, { noRecipeNeeded: !m.noRecipeNeeded })} className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5"
                          style={m.noRecipeNeeded ? { backgroundColor: '#F2F4F7', color: '#344054' } : { backgroundColor: '#FFF6E0', color: '#8A5A00' }}>
                          {m.noRecipeNeeded ? L('Không cần công thức', 'No recipe needed') : m.bomCount === 0 ? L('⚠ Chưa có', '⚠ None') : '—'}</button>}
                  </td>
                  <td className="px-3 py-2 text-center"><button onClick={() => patch(m, { visible: !m.visible })} aria-label="visible" className="inline-block w-9 h-5 rounded-full relative align-middle" style={{ backgroundColor: m.visible ? NAVY : '#D0D5DD' }}>
                    <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: m.visible ? 18 : 2 }} /></button></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{m.checked
                    ? <span className="text-[10px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: '#ECFDF3', color: '#067647' }}>{L('Đã duyệt', 'Checked')}</span>
                    : <button onClick={() => patch(m, { checked: true })} className="text-[11px] font-extrabold rounded-md px-2 py-1" style={{ backgroundColor: '#FFF6E0', color: '#8A5A00' }}>{L('Gợi ý · Duyệt', 'Suggested · Accept')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 400 && <div className="text-xs text-center py-2" style={{ color: '#6B7280' }}>{L(`Hiện 400 / ${rows.length} — dùng tìm kiếm`, `Showing 400 of ${rows.length} — use the search`)}</div>}
        </div>
      )}
    </div>
  );
}

/* ===================== Excel-like column filter ===================== */
type ColKey = 'vendor' | 'uom' | 'type' | 'group' | 'packs' | 'recipes' | 'visible' | 'status';
type ColSortOpt = { key: 'name' | 'bom'; dir: 1 | -1; label: string };

function ColFilterPop({ L, rect, title, options, selected, onChange, sorts, sort, onSort, onClose }: {
  L: LFn; rect: { left: number; bottom: number }; title: string;
  options: { key: string; label: string; count: number }[];
  selected: Set<string> | undefined; onChange: (sel: Set<string> | undefined) => void;
  sorts?: ColSortOpt[]; sort: { key: 'name' | 'bom'; dir: 1 | -1 }; onSort: (key: 'name' | 'bom', dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const scroll = (e: Event) => { if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return; onClose(); };
    // deferred so the click that opened it does not close it
    const t = setTimeout(() => { document.addEventListener('mousedown', down); document.addEventListener('keydown', key); window.addEventListener('scroll', scroll, true); window.addEventListener('resize', onClose); }, 0);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const nq = fold(q.trim());
  const shown = nq ? options.filter(o => fold(o.label).includes(nq)) : options;
  const allKeys = options.map(o => o.key);
  const isOn = (k: string) => !selected || selected.has(k);
  const normalize = (set: Set<string>) => (allKeys.every(k => set.has(k)) ? undefined : set);
  const toggle = (k: string) => { const n = new Set(selected ?? allKeys); if (n.has(k)) n.delete(k); else n.add(k); onChange(normalize(n)); };
  const allShownOn = shown.length > 0 && shown.every(o => isOn(o.key));
  const toggleAll = () => { const n = new Set(selected ?? allKeys); for (const o of shown) { if (allShownOn) n.delete(o.key); else n.add(o.key); } onChange(normalize(n)); };
  const only = (k: string) => onChange(normalize(new Set([k])));
  const W = 290;
  const left = typeof window !== 'undefined' ? Math.max(8, Math.min(rect.left, window.innerWidth - W - 8)) : rect.left;
  const maxH = typeof window !== 'undefined' ? Math.max(220, window.innerHeight - rect.bottom - 16) : 400;
  return (
    <div ref={ref} className="fixed z-50 bg-white rounded-xl shadow-xl flex flex-col text-[12.5px] normal-case tracking-normal"
      style={{ top: rect.bottom + 4, left, width: W, maxHeight: Math.min(maxH, 460), border: `1px solid ${BORDER}` }}>
      <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{title}</div>
      {sorts && sorts.length > 0 && (
        <div className="px-1.5 pb-1.5" style={{ borderBottom: `1px solid ${HAIR}` }}>
          {sorts.map(o => { const act = sort.key === o.key && sort.dir === o.dir; return (
            <button key={`${o.key}${o.dir}`} onClick={() => onSort(o.key, o.dir)} className="w-full flex items-center gap-2 rounded-md px-1.5 py-1 text-left font-bold hover:bg-[#FFFAEE]"
              style={{ color: act ? GOLD_TEXT : NAVY }}><ArrowUpDown size={12} />{o.label}{act && <Check size={12} className="ml-auto" />}</button>); })}
        </div>
      )}
      <div className="px-2.5 pt-2">
        <label className="flex items-center gap-1.5 rounded-lg px-2" style={{ border: `1px solid ${BORDER}` }}>
          <Search size={12} style={{ color: '#9CA3AF' }} />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm…', 'Search…')} className="flex-1 py-1.5 text-[12.5px] outline-none bg-transparent" />
        </label>
      </div>
      <div className="px-1.5 pt-1.5">
        <label className="flex items-center gap-2 rounded-md px-1.5 py-1 cursor-pointer font-extrabold hover:bg-[#FFFAEE]" style={{ color: NAVY }}>
          <input type="checkbox" checked={allShownOn} onChange={toggleAll} style={{ accentColor: NAVY }} />
          {nq ? L('Chọn tất cả kết quả', 'Select all results') : L('Chọn tất cả', 'Select all')}
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-1.5 pb-1.5" style={{ minHeight: 60 }}>
        {shown.length === 0 && <div className="px-1.5 py-2 text-xs" style={{ color: '#9CA3AF' }}>{L('Không có giá trị', 'No values')}</div>}
        {shown.map(o => (
          <div key={o.key} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[#FFFAEE]">
            <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
              <input type="checkbox" checked={isOn(o.key)} onChange={() => toggle(o.key)} style={{ accentColor: NAVY }} />
              <span className="truncate" style={{ color: o.count ? '#1F2937' : '#9CA3AF' }}>{o.label}</span>
            </label>
            <button onClick={() => only(o.key)} className="hidden group-hover:inline text-[10.5px] font-extrabold" style={{ color: GOLD_TEXT }}>{L('chỉ', 'only')}</button>
            <span className="text-[11px] tabular-nums" style={{ color: '#9CA3AF' }}>{o.count}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between px-3 py-2" style={{ borderTop: `1px solid ${HAIR}` }}>
        <button onClick={() => onChange(undefined)} disabled={!selected} className="text-xs font-extrabold disabled:opacity-40" style={{ color: NAVY }}>{L('Bỏ lọc cột này', 'Clear this filter')}</button>
        <button onClick={onClose} className="text-xs font-extrabold rounded-lg px-3 py-1.5 text-white" style={{ backgroundColor: NAVY }}>OK</button>
      </div>
    </div>
  );
}
