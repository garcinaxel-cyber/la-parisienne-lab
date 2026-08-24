import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

// One-off correction (2026-08-22, Axel): a batch of 286 inventory-adjustment stock.move.line
// records shows a "Date" somewhere in July 2026, but Axel confirms they're really all from a
// single physical inventory count done on 2026-06-30 — the "Date" field on stock.move.line is
// NOT fixed at creation; Odoo's own tooltip says it updates "until updated due to: quantity
// being increased, 'picked' status has updated, or move line is done", so a line genuinely
// created 06-30 can show a July date if it was touched again later (e.g. a follow-up count
// correction). This module is READ-ONLY by default (inspectInventoryDateBatch) — the actual
// write (fixInventoryDateBatch) is a separate, explicit function, never auto-run.
//
// Scope: reference = 'Product Quantity Updated' (the label visible in the Moves History list
// for these lines), state = 'done', date within the July window Axel filtered on in the
// screenshot. Matches Odoo's own "Inventory" + "Done" + date-range filter as closely as
// possible from the API side.
export interface InventoryDateLine {
  id: number;
  date: string;
  create_date: string;
  write_date: string;
  reference: string | null;
  product: string;
  qty: number;
  from: string;
  to: string;
  move_id: number | null;
}

export async function inspectInventoryDateBatch(fromDate: string, toDate: string, opts?: { byLocation?: boolean }): Promise<InventoryDateLine[]> {
  // "Inventory" filter in Odoo's Moves History = either side of the move is a virtual
  // inventory-adjustment location (usage='inventory') — covers BOTH directions: increases
  // (Virtual Locations/Inventory adjustment -> LAB/Stock) and decreases (LAB/Stock -> Virtual
  // Locations/Inventory adjustment), not just the incoming half.
  const domain: any[] = opts?.byLocation
    ? [
        ['state', '=', 'done'],
        ['date', '>=', fromDate],
        ['date', '<=', toDate],
        '|', ['location_id.usage', '=', 'inventory'], ['location_dest_id.usage', '=', 'inventory'],
      ]
    : [
        ['state', '=', 'done'],
        ['reference', '=', 'Product Quantity Updated'],
        ['date', '>=', fromDate],
        ['date', '<=', toDate],
      ];
  const rows = await odooExecute<any[]>('stock.move.line', 'search_read',
    [domain],
    {
      fields: ['id', 'date', 'create_date', 'write_date', 'reference', 'product_id', 'quantity', 'location_id', 'location_dest_id', 'move_id'],
      limit: 1000,
    });
  return rows.map((r: any) => ({
    id: r.id,
    date: r.date,
    create_date: r.create_date,
    write_date: r.write_date,
    reference: r.reference ?? null,
    product: Array.isArray(r.product_id) ? r.product_id[1] : String(r.product_id ?? ''),
    qty: r.quantity,
    from: Array.isArray(r.location_id) ? r.location_id[1] : String(r.location_id ?? ''),
    to: Array.isArray(r.location_dest_id) ? r.location_dest_id[1] : String(r.location_dest_id ?? ''),
    move_id: Array.isArray(r.move_id) ? r.move_id[0] : (r.move_id ?? null),
  }));
}

export interface FixResult {
  targetDate: string;
  eligible: number;
  updated: number[];
  errors: { id: number; error: string }[];
}

// Writes stock.move.line.date (and its parent stock.move.date, when different) to targetDate
// for every id in `ids`. Time-of-day is preserved per-record (only the calendar date moves) so
// the original count's intra-day ordering isn't flattened to midnight.
export async function fixInventoryDateBatch(ids: number[], targetDate: string): Promise<FixResult> {
  const res: FixResult = { targetDate, eligible: ids.length, updated: [], errors: [] };
  if (!odooWriteConfigured()) return res;
  if (!ids.length) return res;

  const lines = await odooExecute<any[]>('stock.move.line', 'search_read',
    [[['id', 'in', ids]]], { fields: ['id', 'date', 'move_id'] });

  for (const l of lines) {
    try {
      const timeOfDay = String(l.date).split(' ')[1] ?? '12:00:00';
      const newDate = `${targetDate} ${timeOfDay}`;
      await odooExecuteWrite('stock.move.line', 'write', [[l.id], { date: newDate }]);
      const moveId = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      if (moveId) {
        try { await odooExecuteWrite('stock.move', 'write', [[moveId], { date: newDate }]); } catch { /* best-effort, line itself already corrected */ }
      }
      res.updated.push(l.id);
    } catch (e: any) {
      res.errors.push({ id: l.id, error: String(e?.message ?? e) });
    }
  }
  return res;
}
