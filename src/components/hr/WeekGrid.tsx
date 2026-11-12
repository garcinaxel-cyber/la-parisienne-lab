'use client';
// HR pilot — the team schedule as ONE continuous strip for the whole month (Hưng, 2026-11-06:
// "scroll right through the month", not jump week by week). Employees in rows (name column stays
// fixed on the left), days in columns, each week has a band on top with its own publication
// status — the leader publishes week by week from that band.
// Colour only on absences (day off gold, leave brown, holiday green, sick dashed red); working
// shifts stay light grey — Axel's palette rule.
import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { HR_OFF_CODES, fmtDays, DOW_EN, DOW_VI, dm, dow, hanoiToday, isWeekend, monthLabel, offLimit, scheduleCode, weekStart, type HrEmployee } from '@/lib/hr';
import type { HrMonthData } from '@/lib/hr-server';

export const BORDER = '1px solid #E6DCCF';
const COL = 36;      // day column width (px) — a full week fits a phone screen next to the names
const NAME = 96;     // name column width (px)

export function codeStyle(c: string): React.CSSProperties {
  switch (c) {
    case 'O': return { background: '#C9A84C', color: '#fff', fontWeight: 800 };
    // Half day: works one half, the other half is off → half-gold.
    case 'S': return { background: 'linear-gradient(90deg, #fff 50%, #EAD9A0 50%)', color: '#8B5E34', border: '1.5px solid #C9A84C', fontWeight: 800 };
    case 'C': return { background: 'linear-gradient(90deg, #EAD9A0 50%, #fff 50%)', color: '#8B5E34', border: '1.5px solid #C9A84C', fontWeight: 800 };
    case 'AL': case 'SN': return { background: '#8B5E34', color: '#fff', fontWeight: 800 };
    case 'PH': return { background: '#2A1810', color: '#F6F1EA', fontWeight: 800 };
    case 'OM': return { background: '#fff', color: '#B91C1C', border: '1.5px dashed #B91C1C', fontWeight: 800 };
    case 'KL': return { background: '#E5E7EB', color: '#374151', fontWeight: 800 };
    case 'CD': return { background: '#fff', color: '#8B5E34', border: '1.5px solid #8B5E34', fontWeight: 800 };
    default: return { color: '#9CA3AF' };
  }
}
export const codeText = (c: string, lang: string) => (c === 'OM' ? (lang === 'vi' ? 'ỐM' : 'SICK') : c);

export function MonthHeader({ month, lang, onPrev, onNext, sub, busy }: {
  month: string; lang: string; onPrev: () => void; onNext: () => void; sub?: React.ReactNode; busy?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl px-2.5 py-2 flex items-center justify-between gap-2" style={{ border: BORDER }}>
      <button onClick={onPrev} aria-label="Previous month" className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ border: BORDER, background: '#FBF7F0', color: '#2A1810' }}><ChevronLeft size={18} /></button>
      <div className="text-center min-w-0">
        <div className="font-bold text-[15px]" style={{ color: '#2A1810' }}>{monthLabel(month, lang)}{busy ? ' …' : ''}</div>
        {sub && <div className="text-[11px] font-semibold mt-0.5" style={{ color: '#8B5E34' }}>{sub}</div>}
      </div>
      <button onClick={onNext} aria-label="Next month" className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ border: BORDER, background: '#FBF7F0', color: '#2A1810' }}><ChevronRight size={18} /></button>
    </div>
  );
}

export default function MonthGrid({ data, lang, meId, hideUnpublished, onCell, onDay, onWeek, focusDay }: {
  data: HrMonthData; lang: string; meId?: string; hideUnpublished?: boolean;
  onCell?: (e: HrEmployee, day: string) => void; onDay?: (day: string) => void;
  onWeek?: (start: string, published: boolean) => void; // leader: publish / unpublish one week
  focusDay?: string;
}) {
  const wishes = new Set(data.wishes);
  const codeOf = (e: HrEmployee, d: string) => scheduleCode(e, d, data.stored, wishes, data.wishParts);
  const regular = data.employees.filter((e) => !e.is_casual);
  const offOn = (d: string) => regular.filter((e) => HR_OFF_CODES.includes(codeOf(e, d))).length;
  const pub = new Set(data.weeks.filter((w) => w.published).map((w) => w.start));
  const today = hanoiToday();
  const dl = lang === 'vi' ? DOW_VI : DOW_EN;
  const inMonth = (d: string) => d.slice(0, 7) === data.month.slice(0, 7);
  const scroller = useRef<HTMLDivElement>(null);

  // Open on the week in focus (today's week, or the leader's planning week).
  useEffect(() => {
    const target = weekStart(focusDay && data.days.includes(focusDay) ? focusDay : today);
    const i = data.days.indexOf(target);
    if (scroller.current) scroller.current.scrollLeft = i > 0 ? i * COL : 0;
  }, [data.month]); // eslint-disable-line react-hooks/exhaustive-deps

  const stickyName: React.CSSProperties = { position: 'sticky', left: 0, zIndex: 2, width: NAME, minWidth: NAME, maxWidth: NAME };
  const sep = (d: string): React.CSSProperties => (dow(d) === 1 ? { borderLeft: '2px solid #E6DCCF' } : {});

  return (
    <div ref={scroller} className="bg-white rounded-2xl overflow-x-auto overscroll-x-contain" style={{ border: BORDER, WebkitOverflowScrolling: 'touch' }}>
      <table className="border-separate" style={{ borderSpacing: 0, tableLayout: 'fixed' }}>
        <thead>
          {/* week bands — publication per week */}
          <tr>
            <th style={{ ...stickyName, background: '#FBF7F0' }} className="text-left pl-2 text-[10px] font-semibold">
              <span style={{ color: '#6B7280' }}>{lang === 'vi' ? 'Tuần' : 'Week'}</span>
            </th>
            {data.weeks.map((w) => {
              const p = pub.has(w.start);
              const end = data.days[data.days.indexOf(w.start) + 6];
              return (
                <th key={w.start} colSpan={7} className="p-1" style={{ borderLeft: '2px solid #E6DCCF', background: '#FBF7F0', borderBottom: '1px solid #F0E6B8' }}>
                  <div className="flex items-center justify-between gap-1 px-1">
                    <span className="text-[11px] font-bold whitespace-nowrap" style={{ color: '#2A1810' }}>{dm(w.start)} – {dm(end)}</span>
                    {onWeek ? (
                      <button onClick={() => onWeek(w.start, p)} className="text-[10px] font-bold rounded-full px-2.5 min-h-[28px] whitespace-nowrap active:scale-95"
                        style={p ? { background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' } : { background: '#2A1810', color: '#F6F1EA' }}>
                        {p ? (lang === 'vi' ? '✓ Đã công bố' : '✓ Published') : (lang === 'vi' ? 'Công bố tuần' : 'Publish week')}
                      </button>
                    ) : (
                      <span className="text-[10px] font-bold whitespace-nowrap" style={{ color: p ? '#047857' : '#b45309' }}>
                        ● {p ? (lang === 'vi' ? 'Đã công bố' : 'Published') : (lang === 'vi' ? 'Bản nháp · có thể đổi' : 'Draft · may change')}
                      </span>
                    )}
                  </div>
                </th>
              );
            })}
          </tr>
          {/* days */}
          <tr>
            <th style={{ ...stickyName, background: '#FBF7F0', borderBottom: '1px solid #E6DCCF' }} />
            {data.days.map((d) => {
              const isToday = d === today;
              const inner = (
                <span className="flex flex-col items-center leading-tight rounded-lg mx-[2px] py-0.5" style={isToday ? { background: '#F6F1EA', outline: '1.5px solid #C9A84C' } : {}}>
                  <b className="text-[10px]" style={{ color: '#2A1810' }}>{dl[dow(d)]}</b>
                  <span className="text-[10px]" style={{ color: '#6B7280' }}>{Number(d.slice(8))}</span>
                </span>
              );
              return (
                <th key={d} style={{ width: COL, minWidth: COL, background: isWeekend(d) ? '#FBF6E6' : '#FBF7F0', borderBottom: '1px solid #E6DCCF', opacity: inMonth(d) ? 1 : 0.45, ...sep(d) }}>
                  {onDay ? <button onClick={() => onDay(d)} className="w-full min-h-[34px]">{inner}</button> : inner}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.employees.map((e) => {
            const mine = e.id === meId;
            const used = data.monthOff[e.id] ?? 0;
            const over = !e.is_casual && used > data.allowance;
            const rowBg = mine ? '#FFF8DC' : '#fff';
            return (
              <tr key={e.id}>
                <td style={{ ...stickyName, background: rowBg, borderBottom: '1px solid #F3EED9', boxShadow: '2px 0 4px rgba(0,0,0,0.04)' }} className="pl-2 pr-1 py-1">
                  <div className="text-[11px] font-bold leading-tight" style={{ color: mine ? '#8B5E34' : '#2A1810' }}>{e.full_name}</div>
                  <div className="text-[9px] leading-tight mt-0.5" style={{ color: over ? '#DC2626' : '#9CA3AF', fontWeight: over ? 800 : 400 }}>
                    {e.is_casual ? (lang === 'vi' ? 'thời vụ' : 'seasonal') : `${lang === 'vi' ? 'nghỉ' : 'off'} ${fmtDays(used)}/${data.allowance}`}
                    {!e.profile_id ? (lang === 'vi' ? ' · không app' : ' · no app') : ''}
                  </div>
                </td>
                {data.days.map((d) => {
                  const c = codeOf(e, d);
                  const isWork = c === '7' || c === '8';
                  // Draft week (employee view): shifts shown in italics — may still change.
                  const draft = hideUnpublished && isWork && !pub.has(weekStart(d));
                  const shown = codeText(c, lang);
                  const full = HR_OFF_CODES.includes(c) && !e.is_casual && offOn(d) > offLimit(data.rules, d);
                  const cell = (
                    <span className={`w-[30px] h-[24px] rounded-md flex items-center justify-center mx-auto whitespace-nowrap ${shown.length > 2 ? 'text-[9px]' : 'text-[11px]'}`}
                      style={{ ...codeStyle(c), ...(draft ? { fontStyle: 'italic', color: '#C4B48A' } : {}), ...(full ? { outline: '2px solid #DC2626', outlineOffset: '1px' } : {}) }}>{shown}</span>
                  );
                  const st: React.CSSProperties = { background: mine ? '#FFF8DC' : isWeekend(d) ? '#FDFBF3' : undefined, borderBottom: '1px solid #F3EED9', opacity: inMonth(d) ? 1 : 0.45, height: 42, ...sep(d) };
                  return (
                    <td key={d} style={st} className="p-0">
                      {onCell ? <button onClick={() => onCell(e, d)} className="w-full h-[42px] flex items-center active:scale-95">{cell}</button> : cell}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr>
            <td style={{ ...stickyName, background: '#FBF7F0' }} className="pl-2 text-[10px] font-semibold py-2"><span style={{ color: '#6B7280' }}>{lang === 'vi' ? 'Nghỉ / tối đa' : 'Off / max'}</span></td>
            {data.days.map((d) => {
              const n = offOn(d), lim = offLimit(data.rules, d);
              return (
                <td key={d} className="text-center text-[10px]" style={{ background: '#FBF7F0', opacity: inMonth(d) ? 1 : 0.45, ...sep(d), ...(n > lim ? { color: '#DC2626', fontWeight: 800 } : n === lim ? { color: '#8B5E34', fontWeight: 700 } : { color: '#6B7280' }) }}>{n}/{lim}</td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function Legend({ lang }: { lang: string }) {
  const items: [string, string][] = [['O', lang === 'vi' ? 'nghỉ' : 'off'], ['S', lang === 'vi' ? 'làm sáng' : 'morning'], ['C', lang === 'vi' ? 'làm chiều' : 'afternoon'], ['AL', lang === 'vi' ? 'phép' : 'leave'], ['PH', lang === 'vi' ? 'lễ' : 'holiday'], ['OM', lang === 'vi' ? 'ốm' : 'sick'], ['CD', lang === 'vi' ? 'chế độ' : 'special'], ['KL', lang === 'vi' ? 'không lương' : 'unpaid']];
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] px-1 items-center" style={{ color: '#374151' }}>
      {items.map(([c, l]) => (
        <span key={c} className="inline-flex items-center gap-1 whitespace-nowrap"><span className="min-w-[22px] px-1 h-[16px] rounded text-[9px] leading-none inline-flex items-center justify-center whitespace-nowrap" style={codeStyle(c)}>{codeText(c, lang)}</span>{l}</span>
      ))}
      <span style={{ color: '#9CA3AF' }}>7 = 07–16h · 8 = 08–17h</span>
    </div>
  );
}
