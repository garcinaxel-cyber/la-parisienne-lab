'use client';
import { evalQty, hasOp, cleanExpr } from '@/lib/qty-expr';

// Quantity field with the mini calculator (same behaviour as the OEM ExprInput in
// src/components/oem/ui.tsx): "+" and "×" keys (phone keypads have neither), the result shown
// under the field while an operation is typed, red border when invalid. The two keys keep focus
// in the field (pointerdown preventDefault) so tapping them never fires the field's onBlur with a
// half-typed expression and never closes the phone keyboard.
export default function QtyExprInput({
  value, onChange, onBlur, onEnter, disabled, placeholder = '0', width = 80, borderColor = '#D1D5DB', filledBorderColor, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: (v: string) => void;
  onEnter?: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  width?: number;
  borderColor?: string;
  filledBorderColor?: string;
  ariaLabel?: string;
}) {
  const v = evalQty(value);
  const bad = v !== null && Number.isNaN(v);
  const add = (op: string) => onChange(((value ?? '').replace(/[+×]+$/, '') || '') + op);
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  const border = bad ? '#DC2626' : (v !== null && filledBorderColor) ? filledBorderColor : borderColor;
  const key = 'w-7 h-7 shrink-0 rounded-md text-sm font-bold flex items-center justify-center disabled:opacity-40';
  return (
    <span className="inline-flex flex-col items-stretch shrink-0">
      <span className="flex items-center gap-1">
        <input type="text" inputMode="decimal" autoComplete="off" placeholder={placeholder} value={value} disabled={disabled}
          aria-label={ariaLabel}
          onChange={e => onChange(cleanExpr(e.target.value))}
          onBlur={e => onBlur?.(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onEnter ? onEnter(value) : (e.target as HTMLInputElement).blur(); } }}
          className="rounded-lg px-2 h-8 text-sm font-bold text-right tabular-nums disabled:opacity-50"
          style={{ width, border: `1px solid ${border}`, backgroundColor: bad ? '#FEF2F2' : '#fff' }} />
        <button type="button" tabIndex={-1} disabled={disabled} onPointerDown={keep} onMouseDown={keep} onClick={() => add('+')}
          className={key} style={{ backgroundColor: '#F3F4F6', color: '#374151' }} aria-label="plus">+</button>
        <button type="button" tabIndex={-1} disabled={disabled} onPointerDown={keep} onMouseDown={keep} onClick={() => add('×')}
          className={key} style={{ backgroundColor: '#F3F4F6', color: '#374151' }} aria-label="times">×</button>
      </span>
      {bad ? <span className="text-[10px] font-semibold text-right" style={{ color: '#DC2626' }}>✕</span>
        : hasOp(value) && v !== null ? <span className="text-[11px] font-bold text-right tabular-nums" style={{ color: '#047857' }}>= {v.toLocaleString('en-US', { maximumFractionDigits: 3 })}</span> : null}
    </span>
  );
}
