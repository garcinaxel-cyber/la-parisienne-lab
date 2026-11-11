'use client';
import { useEffect, useMemo, useState } from 'react';
import type { TeamMonthAnalytics, MonthRow } from './month-analytics-types';

// Station Analytics › "This month" (Axel, 2026-11-11). Produced (sent to stock) vs sent by the
// Lab, by category, expandable to products. Current month compared with the same days of the
// previous month; the previous month is viewable in full. Data: getTeamMonthAnalyticsAction
// (pre-summed table, no Odoo call).

const GOLD = '#C9A84C', GREEN = '#2D6A4F', DARK = '#1A4731', AMBER = '#B45309', MUTED = '#6B6455';
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_VI = MONTHS_EN.map((_, i) => `Tháng ${i + 1}`);

const fmt = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
const kg = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('en-US')} kg`;
function pct(cur: number, prev: number): { text: string; up: boolean } | null {
  if (!prev) return cur ? { text: 'new', up: true } : null;
  const p = Math.round(((cur - prev) / prev) * 100);
  return { text: `${p > 0 ? '▲' : p < 0 ? '▼' : '='} ${Math.abs(p)} %`, up: p >= 0 };
}
const barW = (v: number, max: number) => `${max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0}%`;

type Item = { name: string; made: number; sent: number; same: number; sizes: string[] };
type Cat = { name: string; made: number; sent: number; same: number; sameSent: number; items: Item[] };

export default function MonthAnalytics({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const [data, setData] = useState<TeamMonthAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<'cur' | 'prev'>('cur');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [oemOpen, setOemOpen] = useState(false);
  const vi = lang === 'vi';

  useEffect(() => {
    let alive = true;
    (async () => {
      const { getTeamMonthAnalyticsAction } = await import('./actions');
      const res = await getTeamMonthAnalyticsAction(team);
      if (!alive) return;
      if (res.data) setData(res.data); else setError(res.error ?? 'Error');
    })();
    return () => { alive = false; };
  }, [team]);

  const isCur = month === 'cur';
  const cats = useMemo<Cat[]>(() => {
    if (!data) return [];
    const by: Record<string, Cat> = {};
    for (const r of data.rows as MonthRow[]) {
      const made = isCur ? r.made : r.prevMade, sent = isCur ? r.sent : r.prevSent;
      const same = isCur ? r.sameMade : 0, sameSent = isCur ? r.sameSent : 0;
      if (!made && !sent && !same) continue;
      const c = (by[r.cat] ??= { name: r.cat, made: 0, sent: 0, same: 0, sameSent: 0, items: [] });
      c.made += made; c.sent += sent; c.same += same; c.sameSent += sameSent;
      let it = c.items.find(i => i.name === r.name);
      if (!it) { it = { name: r.name, made: 0, sent: 0, same: 0, sizes: [] }; c.items.push(it); }
      it.made += made; it.sent += sent; it.same += same;
      if (r.size && (made || sent)) it.sizes.push(`${r.size} ×${made || sent}`);
    }
    const list = Object.values(by).filter(c => c.made || c.sent);
    list.forEach(c => c.items = c.items.filter(i => i.made || i.sent).sort((a, b) => b.made - a.made || b.sent - a.sent));
    return list.sort((a, b) => b.made - a.made || b.sent - a.sent);
  }, [data, isCur]);

  if (error) return <div className="rounded-2xl bg-white p-6 text-center text-sm" style={{ border: '1px solid #E0D49A', color: MUTED }}>{error}</div>;
  if (!data) return <div className="rounded-2xl bg-white p-6 animate-pulse" style={{ border: '1px solid #E0D49A', height: 180 }} />;

  const curIdx = Number(data.curMonth.slice(5, 7)) - 1, prevIdx = Number(data.prevMonth.slice(5, 7)) - 1;
  const names = vi ? MONTHS_VI : MONTHS_EN;
  const totMade = cats.reduce((s, c) => s + c.made, 0), totSent = cats.reduce((s, c) => s + c.sent, 0);
  const totSame = cats.reduce((s, c) => s + c.same, 0), totSameSent = cats.reduce((s, c) => s + c.sameSent, 0);
  const heroMax = Math.max(totMade, totSent, 1);
  const maxCat = Math.max(1, ...cats.map(c => Math.max(c.made, c.sent)));
  const dMade = isCur ? pct(totMade, totSame) : null, dSent = isCur ? pct(totSent, totSameSent) : null;
  const prevDay = Number(data.prevSameTo.slice(8, 10));

  const oemList = (data.oem ?? []).map(o => ({ ...o, v: isCur ? o.kg : o.prevKg })).filter(o => o.v > 0).sort((a, b) => b.v - a.v);
  const oemTot = oemList.reduce((s, o) => s + o.v, 0), oemSame = (data.oem ?? []).reduce((s, o) => s + o.sameKg, 0);
  const oemMax = Math.max(1, ...oemList.map(o => o.v));
  const dOem = isCur ? pct(oemTot, oemSame) : null;

  const pill = (on: boolean) => ({
    background: on ? GOLD : '#FFFFFF', color: on ? '#FFFFFF' : '#92600A', border: `1px solid ${on ? GOLD : '#E0D49A'}`,
  });
  const darkBadge = (up: boolean) => ({ background: up ? 'rgba(74,222,128,0.18)' : 'rgba(252,165,165,0.18)', color: up ? '#A7F3C5' : '#FECACA' });
  const lightBadge = (up: boolean) => ({ background: up ? '#EAF5EE' : '#FEF3C7', color: up ? GREEN : AMBER });

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <button onClick={() => setMonth('prev')} className="flex-1 py-1.5 rounded-full text-xs font-extrabold" style={pill(!isCur)}>{names[prevIdx]}</button>
        <button onClick={() => setMonth('cur')} className="flex-1 py-1.5 rounded-full text-xs font-extrabold" style={pill(isCur)}>{names[curIdx]}</button>
      </div>

      <div className="rounded-[20px] p-4 text-white" style={{ background: 'linear-gradient(135deg, #1A4731 0%, #24573E 100%)', boxShadow: '0 6px 18px rgba(26,71,49,0.22)' }}>
        <div className="flex items-center justify-between">
          <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 20 }}>{names[isCur ? curIdx : prevIdx]}</span>
          <span className="inline-flex items-center gap-1.5 text-[10.5px] font-bold rounded-full px-2.5 py-0.5" style={{ background: 'rgba(255,255,255,0.1)', color: isCur ? '#A7E3BF' : 'rgba(255,255,255,0.7)' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: isCur ? '#4ADE80' : 'rgba(255,255,255,0.5)' }} />
            {isCur ? (vi ? 'Trực tiếp' : 'Live') : (vi ? 'Đã đóng' : 'Closed')}
          </span>
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>
          {isCur ? `1 – ${data.day}/${data.curMonth.slice(5, 7)} · ${vi ? 'từ đầu tháng' : 'month to date'}` : (vi ? 'Cả tháng' : 'Full month')}
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3.5">
          <div>
            <div className="text-[10px] font-extrabold tracking-wider" style={{ color: GOLD }}>{vi ? 'ĐÃ SẢN XUẤT' : 'PRODUCED'}</div>
            <div className="text-[30px] font-black leading-tight">{fmt(totMade)}</div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.6)' }}>{vi ? 'cái nhập kho' : 'pcs sent to stock'}</div>
            {dMade && <div className="inline-block mt-1.5 text-[11px] font-extrabold rounded-full px-2 py-0.5" style={darkBadge(dMade.up)}>{dMade.text}</div>}
          </div>
          <div>
            <div className="text-[10px] font-extrabold tracking-wider" style={{ color: '#A7E3BF' }}>{vi ? 'LAB ĐÃ GIAO' : 'SENT BY LAB'}</div>
            <div className="text-[30px] font-black leading-tight">{fmt(totSent)}</div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.6)' }}>{vi ? 'cái đã giao' : 'pcs delivered'}</div>
            {dSent && <div className="inline-block mt-1.5 text-[11px] font-extrabold rounded-full px-2 py-0.5" style={darkBadge(dSent.up)}>{dSent.text}</div>}
          </div>
        </div>
        <div className="mt-3 h-2 rounded relative overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}><div className="absolute inset-y-0 left-0 rounded" style={{ background: GOLD, width: barW(totMade, heroMax) }} /></div>
        <div className="mt-1 h-2 rounded relative overflow-hidden" style={{ background: 'rgba(255,255,255,0.12)' }}><div className="absolute inset-y-0 left-0 rounded" style={{ background: '#4ADE80', width: barW(totSent, heroMax) }} /></div>
        {isCur && <div className="mt-2.5 text-[10.5px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
          {vi ? `▲▼ so với cùng kỳ tháng trước (1 – ${prevDay}/${data.prevMonth.slice(5, 7)})` : `▲▼ compared with the same days of ${names[prevIdx]} (1 – ${prevDay})`}
        </div>}
      </div>

      <div className="flex justify-between items-center px-0.5">
        <span className="text-[11px] font-extrabold tracking-wide" style={{ color: '#92600A' }}>{vi ? 'THEO DANH MỤC' : 'BY CATEGORY'}</span>
        <span className="flex gap-2.5 text-[10.5px]" style={{ color: MUTED }}>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: GOLD }} />{vi ? 'Sản xuất' : 'Produced'}</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm" style={{ background: GREEN }} />{vi ? 'Đã giao' : 'Sent'}</span>
        </span>
      </div>

      {cats.length === 0 && <div className="rounded-2xl bg-white p-6 text-center text-sm" style={{ border: '1px solid #E0D49A', color: MUTED }}>{vi ? 'Chưa có dữ liệu' : 'No data yet'}</div>}

      {cats.map(c => {
        const isOpen = !!open[c.name];
        const d = isCur ? pct(c.made, c.same) : null;
        const maxI = Math.max(1, ...c.items.map(i => Math.max(i.made, i.sent)));
        return (
          <div key={c.name} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
            <button onClick={() => setOpen(o => ({ ...o, [c.name]: !isOpen }))} className="w-full text-left px-3.5 py-3 flex flex-col gap-2">
              <span className="flex items-center gap-2 w-full">
                <span className="flex-1 text-sm font-extrabold" style={{ color: DARK }}>{c.name}</span>
                {d && <span className="text-[10.5px] font-extrabold rounded-full px-1.5 py-0.5 whitespace-nowrap" style={lightBadge(d.up)}>{d.text}</span>}
                <span className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{c.items.length}</span>
                <span className="text-lg font-bold inline-block transition-transform" style={{ color: GOLD, transform: `rotate(${isOpen ? 90 : 0}deg)` }}>›</span>
              </span>
              <span className="grid items-center gap-2 w-full" style={{ gridTemplateColumns: '1fr 52px' }}>
                <span className="h-[7px] rounded overflow-hidden" style={{ background: '#F5EFC8' }}><span className="block h-full rounded" style={{ background: GOLD, width: barW(c.made, maxCat) }} /></span>
                <span className="text-[13px] font-extrabold text-right" style={{ color: '#92600A' }}>{fmt(c.made)}</span>
                <span className="h-[7px] rounded overflow-hidden" style={{ background: '#EAF5EE' }}><span className="block h-full rounded" style={{ background: GREEN, width: barW(c.sent, maxCat) }} /></span>
                <span className="text-[13px] font-extrabold text-right" style={{ color: GREEN }}>{fmt(c.sent)}</span>
              </span>
            </button>
            {isOpen && (
              <div className="border-t" style={{ borderColor: '#F5EFC8', background: '#FFFCF3' }}>
                <div className="grid gap-1.5 px-3.5 py-1.5 text-[9.5px] font-extrabold tracking-wide" style={{ gridTemplateColumns: isCur ? '1fr 44px 44px 44px' : '1fr 48px 48px', color: '#9CA3AF' }}>
                  <span>{vi ? 'SẢN PHẨM' : 'PRODUCT'}</span><span className="text-right">{vi ? 'SX' : 'MADE'}</span><span className="text-right">{vi ? 'GIAO' : 'SENT'}</span>
                  {isCur && <span className="text-right">{`1–${prevDay}/${data.prevMonth.slice(5, 7)}`}</span>}
                </div>
                {c.items.map(i => {
                  const gap = Math.abs(i.sent - i.made) >= Math.max(5, i.made * 0.2);
                  return (
                    <div key={i.name} className="grid gap-1.5 px-3.5 py-1.5 border-t items-center" style={{ gridTemplateColumns: isCur ? '1fr 44px 44px 44px' : '1fr 48px 48px', borderColor: '#F5EFC8' }}>
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-[12.5px] font-semibold leading-tight" style={{ color: '#1A2C24' }}>{i.name}</span>
                        {i.sizes.length > 0 && <span className="text-[10.5px]" style={{ color: MUTED }}>{i.sizes.join(' · ')}</span>}
                        <span className="h-1 rounded overflow-hidden" style={{ background: '#F5EFC8' }}><span className="block h-full rounded" style={{ background: GOLD, width: i.made ? barW(i.made, maxI) : '0%' }} /></span>
                      </span>
                      <span className="text-[12.5px] font-extrabold text-right" style={{ color: i.made ? '#92600A' : '#D1C9A8' }}>{i.made ? fmt(i.made) : '–'}</span>
                      <span className="text-[12.5px] font-extrabold text-right" style={{ color: gap ? AMBER : GREEN }}>{fmt(i.sent)}</span>
                      {isCur && <span className="text-[11.5px] font-semibold text-right" style={{ color: i.made < i.same ? AMBER : '#9CA3AF' }}>{i.same ? fmt(i.same) : '–'}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {data.oem && oemList.length > 0 && (
        <div className="space-y-2">
          <div className="flex justify-between items-center px-0.5 pt-1.5">
            <span className="text-[11px] font-extrabold tracking-wide" style={{ color: '#92600A' }}>OEM · KG</span>
            <span className="text-[10.5px]" style={{ color: MUTED }}>{vi ? 'Từ lệnh SX Odoo, cập nhật mỗi đêm' : 'From Odoo MOs, synced nightly'}</span>
          </div>
          <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1.5px dashed ${GOLD}` }}>
            <button onClick={() => setOemOpen(v => !v)} className="w-full text-left px-3.5 py-3 flex items-center gap-2" style={{ background: '#FFFBEB' }}>
              <span className="flex-1 flex flex-col">
                <span className="text-sm font-extrabold" style={{ color: DARK }}>{vi ? 'Đơn OEM' : 'OEM orders'}</span>
                <span className="text-[10.5px]" style={{ color: MUTED }}>{vi ? 'Hạt điều, bánh quy, lưỡi mèo cho đối tác' : 'Cashews, cookies, cat tongues for partners'}</span>
              </span>
              {dOem && <span className="text-[10.5px] font-extrabold rounded-full px-1.5 py-0.5 whitespace-nowrap" style={lightBadge(dOem.up)}>{dOem.text}</span>}
              <span className="text-base font-black" style={{ color: '#92600A' }}>{kg(oemTot)}</span>
              <span className="text-lg font-bold inline-block" style={{ color: GOLD, transform: `rotate(${oemOpen ? 90 : 0}deg)` }}>›</span>
            </button>
            {oemOpen && oemList.map(o => (
              <div key={o.name} className="grid gap-1.5 px-3.5 py-1.5 border-t items-center" style={{ gridTemplateColumns: '1fr 64px 56px', borderColor: '#F5EFC8' }}>
                <span className="flex flex-col gap-0.5">
                  <span className="text-[12.5px] font-semibold" style={{ color: '#1A2C24' }}>{o.name}</span>
                  <span className="h-1 rounded overflow-hidden" style={{ background: '#F5EFC8' }}><span className="block h-full rounded" style={{ background: GOLD, width: barW(o.v, oemMax) }} /></span>
                </span>
                <span className="text-[12.5px] font-extrabold text-right" style={{ color: '#92600A' }}>{kg(o.v)}</span>
                <span className="text-[11px] text-right" style={{ color: '#9CA3AF' }}>{isCur ? (o.sameKg ? `${Math.round(o.sameKg)}` : '–') : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[11px] leading-relaxed px-0.5" style={{ color: MUTED }}>
        {vi
          ? <><b style={{ color: DARK }}>Sản xuất</b> = số lượng đã nhập kho (= lệnh sản xuất Odoo). <b style={{ color: DARK }}>Đã giao</b> = số lượng đã kiểm khi giao hàng. Hai số khác nhau khi giao từ hàng tồn kho hoặc để lại trong kho.</>
          : <><b style={{ color: DARK }}>Produced</b> = quantities sent to stock (= Odoo manufacturing orders). <b style={{ color: DARK }}>Sent</b> = quantities checked at delivery. They differ when products are delivered from stock or kept in stock for later.</>}
      </div>
    </div>
  );
}
