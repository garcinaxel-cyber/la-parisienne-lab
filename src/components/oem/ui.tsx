'use client';
import type { ReactNode } from 'react';
import { GREEN, BORDER, MUTED, evalQty, hasOp, cleanExpr } from './model';

export function Bar({ pct, color = GREEN, h = 2 }: { pct: number; color?: string; h?: number }) {
  return (
    <div className="rounded-full overflow-hidden" style={{ backgroundColor: '#F3F4F6', height: h * 4 }}>
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, backgroundColor: color }} />
    </div>
  );
}
export function Empty({ text }: { text: string }) {
  return <div className="bg-white rounded-2xl p-8 text-center text-sm" style={{ color: MUTED, border: `1px solid ${BORDER}` }}>{text}</div>;
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl ${className}`} style={{ border: `1px solid ${BORDER}` }}>{children}</div>;
}
export function Title({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs font-bold uppercase tracking-wide" style={{ color: MUTED }}>{children}</div>
      {right}
    </div>
  );
}
export function Banner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  const s = tone === 'warn' ? { backgroundColor: '#FFFBEB', color: '#92400E', border: '1px solid #FDE68A' } : { backgroundColor: '#F7F5F0', color: '#4B5563', border: `1px solid ${BORDER}` };
  return <div className="rounded-xl px-3 py-2 text-xs" style={s}>{children}</div>;
}
export function Chip({ children, tone = 'grey' }: { children: ReactNode; tone?: 'grey' | 'green' | 'red' | 'amber' | 'blue' }) {
  const m = { grey: ['#F3F4F6', '#6B7280'], green: ['#ECFDF5', '#047857'], red: ['#FEF2F2', '#DC2626'], amber: ['#FFFBEB', '#B45309'], blue: ['#EFF6FF', '#1D4ED8'] }[tone];
  return <span className="inline-flex items-center gap-1 text-[10px] font-bold rounded px-1.5 py-0.5 whitespace-nowrap" style={{ backgroundColor: m[0], color: m[1] }}>{children}</span>;
}
export const inputCls = 'rounded-lg px-2 py-1.5 text-sm';
export const inputStyle = { border: '1px solid #D1D5DB' };
export function Btn({ children, onClick, disabled, primary, danger }: { children: ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  const style = primary ? { backgroundColor: GREEN, color: '#fff' } : danger ? { backgroundColor: '#DC2626', color: '#fff' } : { backgroundColor: '#fff', color: '#374151', border: `1px solid ${BORDER}` };
  return (
    <button onClick={onClick} disabled={disabled} className="inline-flex items-center justify-center gap-1.5 text-xs font-bold rounded-lg px-3 py-1.5 disabled:opacity-40" style={style}>
      {children}
    </button>
  );
}

// Quantity input with the mini calculator: "+" and "×" keys (phone keypads have neither),
// the result shown under the field while an operation is typed, red border when invalid.
export function ExprInput({ value, onChange, unit, decimal = true, integer = false, className = '', big = false, placeholder = '0' }: {
  value: string; onChange: (v: string) => void; unit?: string; decimal?: boolean; integer?: boolean; className?: string; big?: boolean; placeholder?: string;
}) {
  const v = evalQty(value);
  // integer: bags are whole units — 5.5 bags is refused (Axel, 2026-09-26)
  const bad = v !== null && (Number.isNaN(v) || (integer && !Number.isInteger(v)));
  const add = (op: string) => onChange(((value ?? '').replace(/[+×]+$/, '') || '') + op);
  const key = 'w-7 h-7 shrink-0 rounded-md text-sm font-bold flex items-center justify-center';
  return (
    <span className={`inline-flex flex-col items-stretch ${className}`}>
      <span className="flex items-center gap-1">
        <input inputMode={decimal ? 'decimal' : 'numeric'} placeholder={placeholder} value={value}
          onChange={e => onChange(cleanExpr(e.target.value))}
          className={`min-w-0 flex-1 rounded-lg px-2 ${big ? 'h-10 text-lg text-center' : 'h-8 text-sm text-right'} font-bold tabular-nums`}
          style={{ border: `1px solid ${bad ? '#DC2626' : '#D1D5DB'}`, backgroundColor: bad ? '#FEF2F2' : '#fff' }} />
        <button type="button" tabIndex={-1} onClick={() => add('+')} className={key} style={{ backgroundColor: '#F3F4F6', color: '#374151' }} aria-label="plus">+</button>
        <button type="button" tabIndex={-1} onClick={() => add('×')} className={key} style={{ backgroundColor: '#F3F4F6', color: '#374151' }} aria-label="times">×</button>
      </span>
      {bad ? <span className="text-[10px] font-semibold text-right" style={{ color: '#DC2626' }}>{integer && v !== null && !Number.isNaN(v) ? `✕ ${v} — số nguyên / whole number` : '✕'}</span>
        : hasOp(value) && v !== null ? <span className="text-[11px] font-bold text-right tabular-nums" style={{ color: '#047857' }}>= {v.toLocaleString('en-US', { maximumFractionDigits: 3 })}{unit ? ` ${unit}` : ''}</span> : null}
    </span>
  );
}
