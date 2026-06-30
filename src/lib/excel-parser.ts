import * as XLSX from 'xlsx';
import { ODOO_TEAM_MAP, type SourceType } from './types';

export interface ParsedLine {
  source_type: SourceType;
  order_ref: string;
  shop_name: string;
  product_sku: string;
  product_name_vi: string;
  team: string;           // raw from Odoo, normalised later
  variant_label: string;
  qty: number;
  delivery_date: string;  // ISO date
  delivery_time: string | null;
}

export interface ParseResult {
  lines: ParsedLine[];
  source_type: SourceType;
  filename: string;
  errors: string[];
}

function excelDateToISO(val: unknown): { date: string; time: string | null } {
  if (val instanceof Date) {
    const d = val.toISOString().split('T');
    const timePart = d[1]?.slice(0, 5) || null;
    return { date: d[0], time: timePart === '00:00' ? null : timePart };
  }
  if (typeof val === 'string') {
    const parts = val.split(' ');
    return { date: parts[0], time: parts[1]?.slice(0, 5) || null };
  }
  return { date: new Date().toISOString().split('T')[0], time: null };
}

function detectType(headers: string[]): SourceType | null {
  const h = headers.map(s => (s || '').toLowerCase());
  if (h.some(x => x.includes('order reference') && !x.includes('request'))) return 'sales_order';
  if (h.some(x => x.includes('request number') || x.includes('replenishment'))) return 'replenishment';
  return null;
}

function normaliseTeam(raw: string): string {
  const clean = (raw || '').trim();
  return ODOO_TEAM_MAP[clean] ?? ODOO_TEAM_MAP[clean.toLowerCase()] ?? clean;
}

/** Find a column index by exact header name (robust to column-order changes in Odoo exports). */
function col(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const idx = headers.findIndex(h => h.trim() === name);
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function parseExcelFile(file: File): Promise<ParseResult> {
  const errors: string[] = [];
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  if (rows.length < 2) return { lines: [], source_type: 'sales_order', filename: file.name, errors: ['Empty file'] };

  const headers = (rows[0] as string[]).map(h => String(h ?? ''));
  const type = detectType(headers);
  if (!type) return { lines: [], source_type: 'sales_order', filename: file.name, errors: ['Unrecognised file format'] };

  const lines: ParsedLine[] = [];

  if (type === 'sales_order') {
    // Find columns by name — robust to Odoo adding/reordering columns
    const orderRefIdx = col(headers, 'Order Reference');
    const shopIdx     = col(headers, 'Customer');
    const dateIdx     = col(headers, 'Delivery Date');
    const skuIdx      = col(headers, 'Order Lines/Product/Reference');
    const descIdx     = col(headers, 'Order Lines/Description');
    const productIdx  = col(headers, 'Order Lines/Product');
    const teamIdx     = col(headers, 'Order Lines/Product/All Product Tag');
    const qtyIdx      = col(headers, 'Order Lines/Quantity');

    let curOrderRef = '', curShop = '', curDate = '', curTime: string | null = null;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      if (orderRefIdx >= 0 && r[orderRefIdx]) curOrderRef = String(r[orderRefIdx]).trim();
      if (shopIdx >= 0 && r[shopIdx])         curShop     = String(r[shopIdx]).trim();
      if (dateIdx >= 0 && r[dateIdx])         { const dt = excelDateToISO(r[dateIdx]); curDate = dt.date; curTime = dt.time; }
      const sku  = skuIdx >= 0 ? String(r[skuIdx] ?? '').trim() : '';
      const rawName = descIdx >= 0 ? r[descIdx] : (productIdx >= 0 ? r[productIdx] : null);
      const name = String(rawName ?? '').replace(/\[.*?\]\s*/, '').trim();
      const team = teamIdx >= 0 ? String(r[teamIdx] ?? '').trim() : '';
      const qty  = qtyIdx >= 0 ? Math.round(Number(r[qtyIdx] ?? 0)) : 0;
      if (!sku || !qty) continue;
      lines.push({ source_type: 'sales_order', order_ref: curOrderRef, shop_name: curShop,
        product_sku: sku, product_name_vi: name, team: normaliseTeam(team),
        variant_label: 'Standard', qty, delivery_date: curDate, delivery_time: curTime });
    }
  }

  if (type === 'replenishment') {
    // Find columns by name — robust to Odoo adding/reordering columns
    const dateIdx      = col(headers, 'Delivery Date');
    const warehouseIdx = col(headers, 'Destination Warehouse');
    const requestIdx   = col(headers, 'Request Number');
    const nameIdx      = col(headers, 'Request Lines/Product/Name');
    const skuIdx       = col(headers, 'Request Lines/Product/Reference');
    const teamIdx      = col(headers, 'Request Lines/Product/Tags');
    const qtyIdx       = col(headers, 'Request Lines/Quantity Requested');

    let curDate = '', curTime: string | null = null, curWarehouse = '', curRef = '';
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      if (dateIdx >= 0 && r[dateIdx])        { const dt = excelDateToISO(r[dateIdx]); curDate = dt.date; curTime = dt.time; }
      if (warehouseIdx >= 0 && r[warehouseIdx]) curWarehouse = String(r[warehouseIdx]).trim();
      if (requestIdx >= 0 && r[requestIdx])  curRef = String(r[requestIdx]).trim();
      const name = nameIdx >= 0 ? String(r[nameIdx] ?? '').trim() : '';
      const sku  = skuIdx >= 0  ? String(r[skuIdx]  ?? '').trim() : '';
      const team = teamIdx >= 0 ? String(r[teamIdx] ?? '').trim() : '';
      const qty  = qtyIdx >= 0  ? Math.round(Number(r[qtyIdx] ?? 0)) : 0;
      if (!sku || !qty) continue;
      lines.push({ source_type: 'replenishment', order_ref: curRef, shop_name: curWarehouse,
        product_sku: sku, product_name_vi: name, team: normaliseTeam(team),
        variant_label: 'Standard', qty, delivery_date: curDate, delivery_time: curTime });
    }
  }

  if (!lines.length) errors.push('No valid lines found');
  return { lines, source_type: type, filename: file.name, errors };
}

/** Consolidated line ready for lab_assignments insert */
export interface ConsolidatedLine {
  team: string;
  product_sku: string;
  product_name_vi: string;
  variant_label: string;
  delivery_date: string; // ISO date from Excel — kept as grouping key
  total_qty: number;
  breakdown: { shop_name: string; order_ref: string; qty: number; delivery_time?: string | null }[];
}

/** Consolidate parsed lines into assignment groups (team + sku + variant + date).
 *  Same product on different delivery dates → separate assignments. */
export function consolidateLines(lines: ParsedLine[]): ConsolidatedLine[] {
  const map = new Map<string, ConsolidatedLine>();

  for (const l of lines) {
    const key = `${l.team}||${l.product_sku}||${l.variant_label}||${l.delivery_date}`;
    const existing = map.get(key);
    if (existing) {
      existing.total_qty += l.qty;
      existing.breakdown.push({ shop_name: l.shop_name, order_ref: l.order_ref, qty: l.qty, delivery_time: l.delivery_time });
    } else {
      map.set(key, {
        team: l.team, product_sku: l.product_sku, product_name_vi: l.product_name_vi,
        variant_label: l.variant_label, delivery_date: l.delivery_date, total_qty: l.qty,
        breakdown: [{ shop_name: l.shop_name, order_ref: l.order_ref, qty: l.qty, delivery_time: l.delivery_time }],
      });
    }
  }
  return Array.from(map.values());
}
