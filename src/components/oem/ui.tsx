'use client';
import type { ReactNode } from 'react';
import { GREEN, BORDER, MUTED } from './model';

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
