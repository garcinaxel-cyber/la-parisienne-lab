'use client';
// HR pilot — one week of the team schedule (employees in rows, Mon→Sun in columns), shared by the
// leader ("Nhóm") and the employees ("Của tôi"). Swipe left/right = next/previous week.
// Colour only on absences (day off gold, leave brown, holiday green, sick dashed red), working
// shifts stay light grey — Axel's palette rule.
import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { HR_OFF_CODES, DOW_EN, DOW_VI, dm, hanoiToday, isWeekend, offLimit, scheduleCode, type HrEmployee } from '@/lib/hr';
import type { HrWeekData } from '@/lib/hr-server';

export const BORDER = '1px solid #E0D49A';

export function codeStyle(c: string): React.CSSProperties {
  switch (c) {
    case 'O': return { background: '#C9A84C', color: '#fff', fontWeight: 800 };
    case 'AL': case 'SN': return { background: '#8B5E34', color: '#fff', fontWeight: 800 };
    case 'PH': return { background: '#1A4731', color: '#FFF4CC', fontWeight: 800 };
    case 'OM': return { background: '#fff', color: '#B91C1C', border: '1.5px dashed #B91C1C', fontWeight: 800 };
    case 'KL': return { background: '#E5E7EB', color: '#374151', fontWeight: 800 };
    case 'CD': return { background: '#fff', color: '#8B5E34', border: '1.5px solid #8B5E34', fontWeight: 800 };
    default: return { color: '#9CA3AF' };
  }
}
export const codeText = (c: string, lang: string) => (c === 'OM' ? (lang === 'vi' ? 'ỐM' : 'SICK') : c);

export function WeekHeader({ week, lang, onPrev, onNext, status, busy }: {
  week: HrWeekData; lang: string; onPrev: () => void; onNext: () => void; status: React.ReactNode; busy?: boolean;
}) {
  const end = week.days[6];
  return (
    <div className="bg-white rounded-2xl px-2.5 py-2 flex items-center justify-between gap-2" style={{ border: BORDER }}>
      <button onClick={onPrev} aria-label="Previous week" className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ border: BORDER, background: '#FFFAEE', color: '#1A4731' }}><ChevronLeft size={18} /></button>
      <div className="text-center min-w-0">
        <div className="font-bold text-[15px]" style={{ color: '#1A4731' }}>{lang === 'vi' ? 'Tuần' : 'Week'} {dm(week.weekStart)} – {dm(end)}{busy ? ' …' : ''}</div>
        <div className="text-[11px] font-semibold mt-0.5">{status}</div>
      </div>
      <button onClick={onNext} aria-label="Next week" className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ border: BORDER, background: '#FFFAEE', color: '#1A4731' }}><ChevronRight size={18} /></button>
    </div>
  );
}

export default function WeekGrid({ week, lang, meId, hideWork, onCell, onDay, onPrev, onNext }: {
  week: HrWeekData; lang: string; meId?: string; hideWork?: boolean;
  onCell?: (e: HrEmployee, day: string) => void; onDay?: (day: string) => void; onPrev: () => void; onNext: () => void;
}) {
  const wishes = new Set(week.wishes);
  const codeOf = (e: HrEmployee, d: string) => scheduleCode(e, d, week.stored, wishes);
  const regular = week.employees.filter((e) => !e.is_casual);
  const offOn = (d: string) => regular.filter((e) => HR_OFF_CODES.includes(codeOf(e, d))).length;
  const today = hanoiToday();
  const dl = lang === 'vi' ? DOW_VI : DOW_EN;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const cols = '92px repeat(7, minmax(0,1fr)) 34px';

  return (
    <div className="bg-white rounded-2xl overflow-hidden select-none" style={{ border: BORDER, touchAction: 'pan-y' }}
      onTouchStart={(ev) => { const t = ev.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
      onTouchEnd={(ev) => {
        const s = touch.current; touch.current = null; if (!s) return;
        const t = ev.changedTouches[0]; const dx = t.clientX - s.x; const dy = t.clientY - s.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? onNext : onPrev)();
      }}>
      <div className="grid items-center text-center text-[10px] py-1.5" style={{ gridTemplateColumns: cols, background: '#FFFAEE', borderBottom: '1px solid #E0D49A', color: '#1A4731' }}>
        <span />
        {week.days.map((d, i) => {
          const isToday = d === today;
          const inner = <><b className="block">{dl[(i + 1) % 7]}</b><span style={{ color: '#6B7280' }}>{Number(d.slice(8))}</span></>;
          return onDay
            ? <button key={d} onClick={() => onDay(d)} className="leading-tight min-h-[34px] rounded-lg mx-[1px]" style={isToday ? { background: '#FFF4CC', outline: '1.5px solid #C9A84C' } : {}}>{inner}</button>
            : <span key={d} className="leading-tight min-h-[34px] flex flex-col justify-center rounded-lg mx-[1px]" style={isToday ? { background: '#FFF4CC', outline: '1.5px solid #C9A84C' } : {}}>{inner}</span>;
        })}
        <span style={{ color: '#6B7280' }}>{lang === 'vi' ? 'tháng' : 'month'}</span>
      </div>
      {week.employees.map((e) => {
        const mine = e.id === meId;
        const used = week.monthOff[e.id] ?? 0;
        const over = !e.is_casual && used > week.allowance;
        return (
          <div key={e.id} className="grid items-center min-h-[42px]" style={{ gridTemplateColumns: cols, borderBottom: '1px solid #F3EED9', background: mine ? '#FFF8DC' : undefined }}>
            <div className="pl-2 pr-1 min-w-0">
              <div className="text-[11px] font-bold leading-tight" style={{ color: mine ? '#8B5E34' : '#1A4731' }}>{e.full_name}</div>
              {(e.is_casual || !e.profile_id) && <div className="text-[9px]" style={{ color: '#9CA3AF' }}>{e.is_casual ? (lang === 'vi' ? 'thời vụ' : 'seasonal') : ''}{!e.profile_id ? (lang === 'vi' ? ' · không app' : ' · no app') : ''}</div>}
            </div>
            {week.days.map((d) => {
              const c = codeOf(e, d);
              const isWork = c === '7' || c === '8';
              const shown = hideWork && isWork ? '·' : codeText(c, lang);
              const full = HR_OFF_CODES.includes(c) && !e.is_casual && offOn(d) > offLimit(week.rules, d);
              const cell = (
                <span className={`w-[30px] h-[24px] rounded-md flex items-center justify-center mx-auto whitespace-nowrap ${shown.length > 2 ? 'text-[9px]' : 'text-[11px]'}`}
                  style={{ ...codeStyle(c), ...(full ? { outline: '2px solid #DC2626', outlineOffset: '1px' } : {}) }}>{shown}</span>
              );
              const wk = isWeekend(d);
              return onCell
                ? <button key={d} onClick={() => onCell(e, d)} className="h-full min-h-[42px] flex items-center active:scale-95" style={{ background: wk ? 'rgba(201,168,76,0.07)' : undefined }}>{cell}</button>
                : <span key={d} className="h-full min-h-[42px] flex items-center" style={{ background: wk ? 'rgba(201,168,76,0.07)' : undefined }}>{cell}</span>;
            })}
            <span className="text-[10px] text-center" style={{ color: over ? '#DC2626' : '#6B7280', fontWeight: over ? 800 : 400 }}>
              {e.is_casual ? '—' : `${used}/${week.allowance}`}
            </span>
          </div>
        );
      })}
      <div className="grid items-center text-center text-[10px] min-h-[32px]" style={{ gridTemplateColumns: cols, background: '#FFFAEE', color: '#6B7280' }}>
        <span className="text-left pl-2 font-semibold">{lang === 'vi' ? 'Nghỉ / tối đa' : 'Off / max'}</span>
        {week.days.map((d) => {
          const n = offOn(d), lim = offLimit(week.rules, d);
          return <span key={d} style={n > lim ? { color: '#DC2626', fontWeight: 800 } : n === lim ? { color: '#8B5E34', fontWeight: 700 } : {}}>{n}/{lim}</span>;
        })}
        <span />
      </div>
    </div>
  );
}

export function Legend({ lang }: { lang: string }) {
  const items: [string, string][] = [['O', lang === 'vi' ? 'nghỉ' : 'off'], ['AL', lang === 'vi' ? 'phép' : 'leave'], ['PH', lang === 'vi' ? 'lễ' : 'holiday'], ['OM', lang === 'vi' ? 'ốm' : 'sick'], ['CD', lang === 'vi' ? 'chế độ' : 'special'], ['KL', lang === 'vi' ? 'không lương' : 'unpaid']];
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] px-1 items-center" style={{ color: '#374151' }}>
      {items.map(([c, l]) => (
        <span key={c} className="inline-flex items-center gap-1"><span className="min-w-[22px] px-1 h-[16px] rounded text-[9px] leading-none inline-flex items-center justify-center whitespace-nowrap" style={codeStyle(c)}>{codeText(c, lang)}</span>{l}</span>
      ))}
      <span style={{ color: '#9CA3AF' }}>7 = 07–16h · 8 = 08–17h</span>
    </div>
  );
}
