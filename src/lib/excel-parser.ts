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
        // Columns: OrderRef, Customer, DeliveryDate, LineOrderRef, Description, Product, Tag, SKU, Qty
      let curOrderRef = '', curShop = '', curDate = '', curTime: string | null = null;
        for (let i = 1; i < rows.length; i++) {
                const r = rows[i] as unknown[];
                if (r[0]) { curOrderRef = String(r[0]).trim(); }
                if (r[1]) { curShop = String(r[1]).trim(); }
                if (r[2]) { const dt = excelDateToISO(r[2]); curDate = dt.date; curTime = dt.time; }
                const sku  = String(r[7] ?? '').trim();
                const name = String(r[4] ?? r[5] ?? '').replace(/\[.*?\]\s*/, '').trim();
                const team = String(r[6] ?? '').trim();
                const qty  = Math.round(Number(r[8] ?? 0));
                if (!sku || !qty) continue;
                lines.push({ source_type: 'sales_order', order_ref: curOrderRef, shop_name: curShop,
                                    product_sku: sku, product_name_vi: name, team: normaliseTeam(team),
                                    variant_label: 'Standard', qty, delivery_date: curDate, delivery_time: curTime });
        }
  }

  if (type === 'replenishment') {
        // Columns: DeliveryDate, DestWarehouse, RequestNumber, ProductName, SKU, Tags, QtyRequested
      let curDate = '', curTime: string | null = null, curWarehouse = '', curRef = '';
        for (let i = 1; i < rows.length; i++) {
                const r = rows[i] as unknown[];
                if (r[0]) { const dt = excelDateToISO(r[0]); curDate = dt.date; curTime = dt.time; }
                if (r[1]) curWarehouse = String(r[1]).trim();
                if (r[2]) curRef = String(r[2]).trim();
                const name = String(r[3] ?? '').trim();
                const sku  = String(r[4] ?? '').trim();
                const team = String(r[5] ?? '').trim();
                const qty  = Math.round(Number(r[6] ?? 0));
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
    total_qty: number;
    breakdown: { shop_name: string; order_ref: string; qty: number }[];
}

/** Consolidate parsed lines into assignment groups (team + sku + variant) */
export function consolidateLines(lines: ParsedLine[]): ConsolidatedLine[] {
    const map = new Map<string, ConsolidatedLine>();

  for (const l of lines) {
        const key = `${l.team}||${l.product_sku}||${l.variant_label}`;
        const existing = map.get(key);
        if (existing) {
                existing.total_qty += l.qty;
                existing.breakdown.push({ shop_name: l.shop_name, order_ref: l.order_ref, qty: l.qty });
        } else {
                map.set(key, {
                          team: l.team, product_sku: l.product_sku, product_name_vi: l.product_name_vi,
                          variant_label: l.variant_label, total_qty: l.qty,
                          breakdown: [{ shop_name: l.shop_name, order_ref: l.order_ref, qty: l.qty }],
                });
        }
  }
    return Array.from(map.values());
}
