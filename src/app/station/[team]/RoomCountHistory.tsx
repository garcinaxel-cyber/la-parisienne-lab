'use client';
// "Lịch sử kiểm kê" (Axel, 2026-10-31): the team's past room counts — when, who, what was counted.
// Quantities only: no Odoo theoretical and no gap on the chef side.
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react';
import { fmtQty, vnDayTime, RAW_TYPES, type RawType } from '@/lib/raw-materials';
import { getRoomCountHistoryAction, getRoomCountHistoryDetailAction, type RoomCountHistoryItem, type RoomCountHistoryLine } from './room-count-actions';
import type { RoomFreeItem } from '@/lib/room-count';

const NAVY = '#1A4731', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF';

export default function RoomCountHistory({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [items, setItems] = useState<RoomCountHistoryItem[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, { lines: RoomCountHistoryLine[]; free: RoomFreeItem[] }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => { (async () => { try { const r = await getRoomCountHistoryAction(team); setItems(r.items ?? []); } catch { setItems([]); } })(); }, [team]);

  async function toggle(id: string) {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setQ('');
    if (detail[id]) return;
    setBusy(id);
    try { const r = await getRoomCountHistoryDetailAction(team, id); if (r.lines) setDetail(d => ({ ...d, [id]: { lines: r.lines!, free: r.free ?? [] } })); } catch { /* retry on next tap */ }
    setBusy(null);
  }

  if (!items || !items.length) return null;
  const name = (l: RoomCountHistoryLine) => (lang === 'vi' && l.nameVi ? l.nameVi : l.name);

  return (
    <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-2 font-extrabold text-[14px]" style={{ color: NAVY }}><History size={16} /> {L('Lịch sử kiểm kê', 'Count history')}</div>
      {items.map(s => {
        const t = vnDayTime(s.cutoffAt);
        const d = detail[s.id];
        const shown = d ? d.lines.filter(l => !q.trim() || name(l).toLowerCase().includes(q.trim().toLowerCase()))
          .sort((a, b) => name(a).localeCompare(name(b), lang === 'vi' ? 'vi' : 'en')) : [];
        const groups = (['dry', 'fresh', 'frozen'] as RawType[]).map(ty => [ty, shown.filter(l => (l.type ?? 'dry') === ty)] as const).filter(([, ls]) => ls.length);
        return (
          <div key={s.id} style={{ borderTop: `1px solid ${HAIR}` }}>
            <button onClick={() => toggle(s.id)} className="w-full flex items-center gap-2 py-2.5 text-left">
              {open === s.id ? <ChevronDown size={15} style={{ color: NAVY }} /> : <ChevronRight size={15} style={{ color: NAVY }} />}
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-bold">{s.countDate.split('-').reverse().join('/')} · {L('chốt', 'cut-off')} {t.time}</div>
                <div className="text-[11px]" style={{ color: '#6B7280' }}>{s.products} {L('sản phẩm', 'products')}{s.freeItems ? ` · ${s.freeItems} ${L('sản phẩm mới', 'new products')}` : ''} · {L('xác nhận', 'confirmed by')} {s.confirmedByName ?? '—'}</div>
              </div>
              {busy === s.id && <Loader2 size={14} className="animate-spin" style={{ color: NAVY }} />}
            </button>
            {open === s.id && d && (
              <div className="pb-2 space-y-2">
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm nguyên liệu…', 'Search…')}
                  className="w-full rounded-lg px-3 py-2 text-[13px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                {groups.map(([ty, ls]) => (
                  <div key={ty}>
                    <div className="text-[10.5px] font-extrabold uppercase tracking-wide pt-1 pb-0.5" style={{ color: '#9CA3AF' }}>{lang === 'vi' ? RAW_TYPES[ty].vi : RAW_TYPES[ty].en}</div>
                    {ls.map(l => (
                      <div key={l.tmplId} className="flex items-center gap-2 py-1.5 text-[12.5px]" style={{ borderTop: `1px solid ${HAIR}` }}>
                        <span className="flex-1 min-w-0 truncate">{name(l)}</span>
                        <b className="tabular-nums whitespace-nowrap">{l.zero ? '= 0' : `${fmtQty(l.total)} ${l.uom}`}</b>
                      </div>))}
                  </div>))}
                {d.free.length > 0 && (
                  <div className="rounded-lg p-2" style={{ backgroundColor: PALE }}>
                    <div className="text-[10.5px] font-extrabold uppercase tracking-wide pb-0.5" style={{ color: GOLD_TEXT }}>🆕 {L('Sản phẩm mới', 'New products')}</div>
                    {d.free.map(f => <div key={f.id} className="flex justify-between text-[12.5px] py-0.5"><span className="truncate">{f.name}</span><b className="tabular-nums">{fmtQty(f.qty)} {f.uom}</b></div>)}
                  </div>)}
              </div>)}
          </div>);
      })}
    </div>
  );
}
