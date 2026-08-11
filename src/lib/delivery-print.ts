// Formatting helpers for the app-generated LAB/OUT print, kept byte-for-byte consistent with
// the Odoo "Picking Operations" export it replaces (same date format quirk, same "- warehouse"
// suffix on the destination) — see the 2026-08-11 mockup review with Axel.

// Odoo's own export displays dates as MM/DD/YYYY (not the Vietnamese DD/MM convention) —
// replicated here on purpose so the printed slip matches what the team is used to reading.
export function formatOdooStyleDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  if (!y || !m || !d) return isoDate;
  return `${m}/${d}/${y}`;
}

// lab_order_lines / lab_order_packaging_lines store shop_name with the Odoo warehouse's
// " - warehouse" suffix already stripped (see odoo-sync.ts) — re-append it here only, so the
// "Từ / Đến" line reads exactly like the Odoo original.
export function withWarehouseSuffix(shopName: string | null): string {
  if (!shopName) return '';
  return /-\s*warehouse\s*$/i.test(shopName) ? shopName : `${shopName} - warehouse`;
}
