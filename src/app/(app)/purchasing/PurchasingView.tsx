'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Truck, RefreshCw, Search, Check, X, ChevronRight, ChevronDown, AlertTriangle, Loader2, Factory, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  RAW_TYPES, subLabel, typeLabel, shortVendor, vnDayTime, daysBetween, fmtQty, TEAM_SHORT,
  type PurchaseLine, type RawMaterial, type Withdrawal, type RawType,
} from '@/lib/raw-materials';
import {
  getPurchasingBoardAction, setVendorAction, markOrderedAction, cancelLinesAction, undoLineStepAction,
  linkNewProductAction, markNewToCreateAction, getWithdrawalsDayAction, correctWithdrawalLineAction, getHistoryAction,
  getCatalogueAction, syncCatalogueAction, updateMaterialAction, checkMaterialsAction, type Board,
} from './actions';
import { Track } from '@/components/raw/PurchaseTrack';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318';
type Tab = 'requests' | 'storage' | 'history' | 'catalogue';

function TeamBadge({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const t = TEAM_SHORT[team];
  return <span className="inline-block text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5" style={{ backgroundColor: t?.bg ?? '#F2F4F7', color: t?.color ?? '#344054' }}>{t ? t[lang] : team}</span>;
}

export default function PurchasingView({ initialTab, userName }: { initialTab: Tab; userName: string }) {
  const { lang } = useI18n();
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: [Tab, string][] = [['requests', L('Yêu cầu mua', 'Requests')], ['storage', L('Kho hôm nay', 'Storage today')], ['history', L('Lịch sử', 'History')], ['catalogue', L('Danh mục', 'Catalogue')]];
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2"><Truck size={24} className="text-gold" /> {L('Mua hàng', 'Purchasing')}</h1>
          <p className="text-ink-light text-sm mt-0.5">{L('Yêu cầu mua và phiếu lấy kho nguyên liệu của các chef. Giai đoạn thử: không ghi gì vào Odoo.', 'Chefs\' raw material purchase requests and storage withdrawals. Test phase: nothing is written to Odoo.')}</p>
        </div>
        <Link href="/oem-orders" className="inline-flex items-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2 bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><Factory size={15} /> {L('Đơn hàng OEM', 'OEM orders')}</Link>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-xl p-1 bg-white" style={{ border: `1px solid ${BORDER}` }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="flex-1 min-w-[110px] rounded-lg py-2 text-[13px] font-extrabold whitespace-nowrap"
            style={{ backgroundColor: tab === k ? NAVY : 'transparent', color: tab === k ? '#fff' : '#6B7280' }}>{label}</button>
        ))}
      </div>
      {tab === 'requests' && <RequestsTab L={L} lang={lang as any} />}
      {tab === 'storage' && <StorageTab L={L} lang={lang as any} />}
      {tab === 'history' && <HistoryTab L={L} lang={lang as any} />}
      {tab === 'catalogue' && <CatalogueTab L={L} lang={lang as any} />}
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

  const pending = board.lines.filter(l => l.status === 'pending' && !(l.isNew && l.newState !== 'linked'));
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={L('Dòng đang chờ', 'Lines waiting')} value={String(pending.length)} sub={L('chưa đặt hàng', 'not ordered yet')} />
        <Kpi label={L('Nhà cung cấp', 'Vendors')} value={String(vendorKeys.filter(k => k !== 'none').length)} sub={L('theo NCC trong Odoo', 'from Odoo vendors')} />
        <Kpi label={L('Chưa có NCC', 'No vendor')} value={String(byVendor.get('none')?.length ?? 0)} sub={L('cần chọn', 'to assign')} warn={(byVendor.get('none')?.length ?? 0) > 0} />
        <Kpi label={L('Sản phẩm mới', 'New products')} value={String(news.length)} sub={L('cần gắn hoặc tạo', 'to link or create')} />
      </div>
      {!pending.length && !news.length && (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Chưa có yêu cầu nào.', 'No request yet.')}</div>
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
                  <th className="text-left px-3 py-2">{L('Nguyên liệu', 'Raw material')}</th><th className="text-right px-3 py-2">{L('Tổng', 'Total')}</th>
                  <th className="text-left px-3 py-2">{L('Từ', 'From')}</th><th className="text-left px-3 py-2">{L('Ghi chú / thương hiệu', 'Note / brand')}</th>
                  <th className="text-left px-3 py-2">{L('Nhà cung cấp', 'Vendor')}</th><th></th></tr></thead>
                <tbody>
                  {merge(ls).map(group => {
                    const f = group[0]; const total = group.reduce((s, l) => s + l.qty, 0);
                    return (
                      <tr key={f.id} style={{ borderTop: `1px solid ${HAIR}` }}>
                        <td className="px-3 py-2"><b>{f.name}</b><div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{f.sku}</div></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap"><b>{fmtQty(total)} {f.uom}</b>{group.length > 1 && <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{group.map(l => fmtQty(l.qty)).join(' + ')}</div>}</td>
                        <td className="px-3 py-2">{group.map(l => <div key={l.id} className="flex items-center gap-1 text-[11px]"><TeamBadge team={l.team} lang={lang} /> <span style={{ color: '#6B7280' }}>{l.requestedBy ?? ''} · {vnDayTime(l.createdAt).day}</span></div>)}</td>
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
                <span className="text-[11.5px] flex-1 min-w-[220px]" style={{ color: '#6B7280' }}>{L('Giai đoạn thử: tạo PO trong Odoo như hiện nay, rồi nhập số PO để chef thấy “Đã đặt”.', 'Test phase: create the PO in Odoo as today, then enter its number so chefs see “Ordered”.')}</span>
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
                <b className="text-[13.5px]">{l.name}</b> · {fmtQty(l.qty)} {l.uom}
                <div className="mt-0.5"><TeamBadge team={l.team} lang={lang} /> <span style={{ color: '#6B7280' }}>{l.requestedBy} · {vnDayTime(l.createdAt).day}</span></div>
                {l.note && <div className="mt-1">{l.note}</div>}
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                {l.newState === 'to_create' && <span className="text-[11px] font-bold rounded-md px-2 py-1" style={{ backgroundColor: '#F2F4F7', color: '#344054' }}>{L('Chờ tạo trong Odoo', 'Waiting for Odoo creation')}</span>}
                <select disabled={busy} defaultValue="" onChange={e => { const id = Number(e.target.value); if (id) run(linkNewProductAction(l.id, id)); }} className="rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]" style={{ border: `1px solid ${BORDER}` }}>
                  <option value="">{L('Gắn với sản phẩm có sẵn…', 'Link to an existing product…')}</option>
                  {board.catalogue.map(c => <option key={c.tmplId} value={c.tmplId}>{c.name}</option>)}
                </select>
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

function Kpi({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-white rounded-xl px-3 py-2.5" style={{ border: `1px solid ${BORDER}` }}>
      <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{label}</div>
      <div className="text-xl font-extrabold tabular-nums" style={{ color: warn ? LATE : NAVY }}>{value}</div>
      {sub && <div className="text-[11px]" style={{ color: '#6B7280' }}>{sub}</div>}
    </div>
  );
}

/* ===================== Storage today ===================== */
function todayVN(): string { return vnDayTime(new Date().toISOString()).ymd; }
function StorageTab({ L, lang }: { L: LFn; lang: 'vi' | 'en' }) {
  const [date, setDate] = useState(todayVN());
  const [items, setItems] = useState<Withdrawal[] | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [val, setVal] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await getWithdrawalsDayAction(date); if (r.error) setErr(r.error); else { setErr(null); setItems(r.items!); } }, [date]);
  useEffect(() => { setItems(null); load(); }, [load]);
  const lines = (items ?? []).reduce((s, w) => s + w.lines.length, 0);
  const corrected = (items ?? []).reduce((s, w) => s + w.lines.filter(l => l.correctedQty != null).length, 0);
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
        {L('Phiếu được ghi ngay khi chef xác nhận. Không cần duyệt. Chỉ sửa nếu số lượng thực tế khác.', 'Slips are recorded when the chef confirms. Nothing to approve. Only correct a quantity if the real one differs.')}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="rounded-lg px-2.5 py-1.5 text-sm bg-white" style={{ border: `1px solid ${BORDER}` }} />
        {date !== todayVN() && <button onClick={() => setDate(todayVN())} className="text-xs font-bold" style={{ color: GOLD_TEXT }}>{L('Hôm nay', 'Today')}</button>}
        <button onClick={load} className="p-1.5 rounded-md" style={{ color: '#6B7280' }}><RefreshCw size={14} /></button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Kpi label={L('Phiếu', 'Slips')} value={String(items?.length ?? 0)} />
        <Kpi label={L('Dòng', 'Lines')} value={String(lines)} />
        <Kpi label={L('Đã sửa', 'Corrected')} value={String(corrected)} />
      </div>
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{err}</div>}
      {!items ? <div className="text-sm text-center py-6" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>
        : !items.length ? <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#9CA3AF' }}>{L('Chưa có phiếu lấy nào trong ngày.', 'No withdrawal that day.')}</div>
        : <div className="bg-white rounded-2xl px-4" style={{ border: `1px solid ${BORDER}` }}>
          {items.map(w => (
            <div key={w.id} className="py-3" style={{ borderTop: `1px solid ${HAIR}` }}>
              <div className="flex items-center gap-2 flex-wrap">
                <b className="text-[13px] tabular-nums">#{w.no}</b>
                <span className="text-xs flex-1" style={{ color: '#6B7280' }}>{vnDayTime(w.createdAt).time} · <TeamBadge team={w.team} lang={lang} /> · {w.takenBy}</span>
                {w.lines.some(l => l.correctedQty != null)
                  ? <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#F2F4F7', color: '#344054' }}>{L('Kho đã sửa', 'Corrected')}</span>
                  : <span className="text-[10.5px] font-extrabold rounded-md px-2 py-0.5" style={{ backgroundColor: '#ECFDF3', color: '#067647' }}>{L('Đã ghi', 'Recorded')}</span>}
              </div>
              {edit === w.id ? (
                <div className="mt-2 space-y-1.5">
                  {w.lines.map(l => (
                    <div key={l.id} className="flex items-center gap-2 text-[12.5px]">
                      <span className="flex-1">{l.name}</span>
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
                  <div className="text-[12px] mt-1 leading-relaxed">
                    {w.lines.map((l, i) => (
                      <span key={l.id}>{i > 0 && ' · '}{l.name} <b>{fmtQty(l.correctedQty ?? l.qty)} {l.uom}</b>
                        {l.correctedQty != null && <span className="line-through ml-1" style={{ color: '#9CA3AF' }}>{fmtQty(l.qty)}</span>}
                        {l.packLabel && l.packCount ? <span style={{ color: '#9CA3AF' }}> ({fmtQty(l.packCount)} × {l.packLabel})</span> : null}</span>
                    ))}
                  </div>
                  <button onClick={() => setEdit(w.id)} className="mt-1 inline-flex items-center gap-1 text-xs font-bold" style={{ color: GOLD_TEXT }}><Pencil size={12} /> {L('Sửa', 'Correct')}</button>
                </>
              )}
            </div>
          ))}
        </div>}
    </div>
  );
}

/* ===================== History ===================== */
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
  const all = items ?? [];
  const teams = Array.from(new Set(all.map(l => l.team)));
  const shown = all.filter(l => (status === 'all' || l.status === status || (status === 'ordered' && l.status === 'received')) && (team === 'all' || l.team === team)
    && (!q.trim() || `${l.name} ${l.poRef ?? ''} ${l.requestedBy ?? ''} ${l.vendorName ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
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
        {[0, 1, 2, 3, 4, 5].map(o => { const k = monthKey(o); const mi = Number(k.slice(5)) - 1; return (
          <button key={k} onClick={() => setMonth(k)} className="rounded-full px-3 py-1.5 text-[12.5px] font-bold" style={{ backgroundColor: month === k ? NAVY : '#fff', color: month === k ? '#fff' : NAVY, border: `1px solid ${month === k ? NAVY : BORDER}` }}>
            {lang === 'vi' ? MONTHS_VI[mi] : MONTHS_EN[mi]}{o >= 3 ? ` ${k.slice(0, 4)}` : ''}</button>); })}
        <div className="flex rounded-lg overflow-hidden ml-auto" style={{ border: `1px solid ${BORDER}` }}>
          {([['lines', L('Theo dòng', 'By line')], ['products', L('Theo sản phẩm', 'By product')]] as const).map(([k, t]) => (
            <button key={k} onClick={() => setView(k)} className="px-3 py-1.5 text-[12.5px] font-extrabold" style={{ backgroundColor: view === k ? NAVY : '#fff', color: view === k ? '#fff' : GOLD_TEXT }}>{t}</button>))}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Kpi label={L('Dòng yêu cầu', 'Requested lines')} value={String(base.length)} />
        <Kpi label={L('Đã đặt', 'Ordered')} value={String(ordered)} sub={base.length ? `${Math.round(ordered / base.length * 100)} % ${L('số dòng', 'of lines')}` : undefined} />
        <Kpi label={L('Yêu cầu → đặt', 'Request → ordered')} value={fmtDays(reqToOrder)} sub={L('trung bình', 'average')} />
        <Kpi label={L('Chờ quá 2 ngày', 'Waiting over 2 days')} value={String(lateLines.length)} sub={lateLines.slice(0, 2).map(l => l.name).join(', ')} warn={lateLines.length > 0} />
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
                    <div className="min-w-0"><b className="block text-[13px] truncate">{l.name}{l.isNew && <span className="ml-1 text-[10px] font-extrabold rounded px-1" style={{ backgroundColor: '#F2F4F7' }}>{L('MỚI', 'NEW')}</span>}</b>
                      <span className="text-[11.5px]" style={{ color: '#6B7280' }}>{fmtQty(l.qty)} {l.uom} · <TeamBadge team={l.team} lang={lang} /> {l.requestedBy}</span></div>
                    <div className="text-[12px] min-w-0">{l.vendorName ? <span className="truncate block">{shortVendor(l.vendorName)}</span> : <span className="font-bold" style={{ color: LATE }}>{L('Chưa có NCC', 'No vendor yet')}</span>}
                      <span className="text-[11px]" style={{ color: '#9CA3AF' }}>{l.poRef ? `PO ${l.poRef}` : l.status === 'pending' && age >= 2 ? <span className="font-extrabold rounded px-1" style={{ backgroundColor: '#FEF3F2', color: LATE }}>{L(`chờ ${age} ngày`, `waiting ${age} days`)}</span> : ''}</span></div>
                    <Track l={l} L={L} />
                    {o ? <ChevronDown size={14} style={{ color: '#9CA3AF' }} /> : <ChevronRight size={14} style={{ color: '#9CA3AF' }} />}
                  </button>
                  {o && (
                    <div className="px-4 pb-3 pt-1 text-[12.5px] grid sm:grid-cols-2 gap-x-6 gap-y-1" style={{ backgroundColor: '#FCFAF3' }}>
                      <div><span style={{ color: '#6B7280' }}>{L('Yêu cầu bởi', 'Requested by')}</span> {l.requestedBy} · {dt.day} {dt.time} · #{l.requestNo}</div>
                      <div><span style={{ color: '#6B7280' }}>{L('Số lượng', 'Quantity')}</span> {fmtQty(l.qty)} {l.uom}</div>
                      {l.brand && <div><span style={{ color: '#6B7280' }}>{L('Thương hiệu', 'Brand')}</span> {l.brand} · {l.brandStrict ? L('bắt buộc', 'required') : L('nếu có', 'if possible')}</div>}
                      {l.note && <div><span style={{ color: '#6B7280' }}>{L('Ghi chú', 'Note')}</span> {l.note}</div>}
                      <div className="sm:col-span-2 mt-1 space-y-0.5">
                        <Ev at={l.createdAt} text={L(`Chef ${l.requestedBy ?? ''} gửi yêu cầu`, `Chef ${l.requestedBy ?? ''} sent the request`)} />
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
      ) : <ByProduct items={base} L={L} month={month} />}
    </div>
  );
}
function Ev({ at, text }: { at: string; text: string }) {
  const d = vnDayTime(at);
  return <div className="flex gap-3 text-[12px]"><b className="w-24 flex-none tabular-nums" style={{ color: '#6B7280' }}>{d.day} {d.time}</b><span>{text}</span></div>;
}
function ByProduct({ items, L, month }: { items: PurchaseLine[]; L: LFn; month: string }) {
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
    return { name: ls[0].name, uom: ls[0].uom, n: ls.length, qty: ls.reduce((s, l) => s + l.qty, 0), usual, lead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null, perWeek };
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
  const all = items ?? [];
  const rows = all.filter(m => (filter === 'all' || (filter === 'todo' ? !m.checked && m.visible : filter === 'ok' ? m.checked && m.visible : !m.visible))
    && (type === 'all' || m.type === type) && (!q.trim() || `${m.name} ${m.sku ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
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
      {!items ? <div className="text-sm text-center py-6" style={{ color: '#6B7280' }}>{L('Đang tải…', 'Loading…')}</div>
        : !all.length ? <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: '#6B7280' }}>{L('Danh mục trống — bấm “Đồng bộ” để lấy nguyên liệu từ Odoo.', 'Empty catalogue — press “Sync” to load the raw materials from Odoo.')}</div>
        : (
        <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: `1px solid ${BORDER}` }}>
          <table className="w-full text-[12.5px]" style={{ minWidth: 860 }}>
            <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: '#9CA3AF' }}>
              <th className="text-left px-3 py-2">{L('Nguyên liệu (tên Odoo)', 'Raw material (Odoo name)')}</th><th className="text-left px-3 py-2">{L('Đơn vị', 'Unit')}</th>
              <th className="text-left px-3 py-2">{L('Loại', 'Type')}</th><th className="text-left px-3 py-2">{L('Nhóm', 'Group')}</th>
              <th className="text-left px-3 py-2">{L('Quy cách', 'Packs')}</th><th className="text-center px-3 py-2">{L('Chef thấy', 'Chefs see')}</th><th></th></tr></thead>
            <tbody>
              {rows.slice(0, 400).map(m => (
                <tr key={m.tmplId} style={{ borderTop: `1px solid ${HAIR}` }}>
                  <td className="px-3 py-2"><b>{m.name}</b><div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{m.sku ?? '—'} · {m.vendorName ? shortVendor(m.vendorName) : L('chưa có NCC', 'no vendor')}{!m.purchased ? ` · ${L('chưa từng mua', 'never bought')}` : ''}</div></td>
                  <td className="px-3 py-2">{m.uom}</td>
                  <td className="px-3 py-2"><select value={m.type} onChange={e => { const t = e.target.value as RawType; patch(m, { type: t, sub: Object.keys(RAW_TYPES[t].subs)[0] }); }} className="rounded-md px-1.5 py-1 text-xs bg-white" style={{ border: `1px solid ${HAIR}` }}>
                    {(Object.keys(RAW_TYPES) as RawType[]).map(t => <option key={t} value={t}>{typeLabel(t, lang)}</option>)}</select></td>
                  <td className="px-3 py-2"><select value={m.sub} onChange={e => patch(m, { sub: e.target.value })} className="rounded-md px-1.5 py-1 text-xs bg-white" style={{ border: `1px solid ${HAIR}` }}>
                    {Object.keys(RAW_TYPES[m.type].subs).map(s => <option key={s} value={s}>{subLabel(m.type, s, lang)}</option>)}</select></td>
                  <td className="px-3 py-2 text-[11.5px]">
                    {m.packs.map((p, i) => <div key={i} className="flex items-center gap-1">{p.label} <span style={{ color: '#9CA3AF' }}>= {fmtQty(p.factor)} {m.uom}</span>
                      <button onClick={() => patch(m, { packs: m.packs.filter((_, j) => j !== i) })} style={{ color: '#9CA3AF' }}><X size={11} /></button></div>)}
                    {packFor === m.tmplId ? (
                      <div className="flex items-center gap-1 mt-1">
                        <input value={packLabel} onChange={e => setPackLabel(e.target.value)} placeholder={L('vd bao 25 kg', 'e.g. bag 25 kg')} className="w-24 rounded px-1.5 py-0.5 text-[11px]" style={{ border: `1px solid ${BORDER}` }} />
                        <span>=</span><input value={packFactor} onChange={e => setPackFactor(e.target.value)} inputMode="decimal" placeholder="25" className="w-12 rounded px-1.5 py-0.5 text-[11px] text-right" style={{ border: `1px solid ${BORDER}` }} />{m.uom}
                        <button onClick={() => { const f = parseFloat(packFactor.replace(',', '.')); if (packLabel.trim() && f > 0) patch(m, { packs: [...m.packs, { label: packLabel.trim(), factor: f }] }); setPackFor(null); setPackLabel(''); setPackFactor(''); }} style={{ color: NAVY }}><Check size={13} /></button>
                      </div>
                    ) : <button onClick={() => { setPackFor(m.tmplId); setPackLabel(''); setPackFactor(''); }} className="text-[11px] font-bold" style={{ color: GOLD_TEXT }}>+ {L('quy cách', 'pack')}</button>}
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
