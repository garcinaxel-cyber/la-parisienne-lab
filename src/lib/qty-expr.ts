// Mini calculator for quantity fields (Axel, 2026-09-25 for OEM, extended 2026-09-30 to the shop
// daily Kiểm kho, the shop monthly official inventory and the LAB finished-goods inventory):
// stock is often counted in several places or in cartons — "12+3+50", "12×24+7" (12 cartons of
// 24 + 7 loose). Only digits, one decimal separator per number ("," or "."), "+" and "×"/"x"/"*".
// PURE — no imports, safe for client and server.

/** null when empty, NaN when invalid, else the value (multiplication before addition). */
export function evalQty(raw: string | undefined | null): number | null {
  const s = (raw ?? '').replace(/\s+/g, '').replace(/[xX×*]/g, '*').replace(/,/g, '.');
  if (!s) return null;
  if (!/^\d+(\.\d+)?([+*]\d+(\.\d+)?)*$/.test(s)) return NaN;
  const v = s.split('+').reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f), 1), 0);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : NaN;
}
export const hasOp = (raw: string | undefined | null) => /[+xX×*]/.test(raw ?? '');
/** what the user may type in a quantity field */
export const cleanExpr = (raw: string) => raw.replace(/[^0-9.,+xX×*\s]/g, '');
/** true when the field holds something that is not a valid quantity */
export const qtyExprBad = (raw: string | undefined | null) => Number.isNaN(evalQty(raw) as number);
