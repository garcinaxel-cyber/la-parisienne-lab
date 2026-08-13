import { odooExecute, odooExecuteWrite, odooWriteConfigured, labDateOf, labDayUtcRange } from '@/lib/odoo';

export interface OrderLockBucket {
  eligible: number;
  confirmed: { id: number; name: string }[];
  errors: { id: number; name: string; error: string }[];
}

export interface OrderLockResult {
  date: string; // tomorrow's lab-local delivery date being locked (J+1 relative to the run)
  dryRun: boolean;
  salesOrders: OrderLockBucket;
  replenishments: OrderLockBucket;
}

// UTC [start,end) covering LAB-LOCAL TOMORROW (today+1 in VN calendar terms), formatted the
// same way Odoo domain filters expect elsewhere in this codebase (see labTodayUtcThreshold in
// odoo.ts): "YYYY-MM-DD HH:MM:SS", not raw ISO with 'T'/milliseconds.
function tomorrowUtcRange(): { date: string; start: string; end: string } {
  const todayLocal = labDateOf(new Date().toISOString())!;
  const d = new Date(todayLocal + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().split('T')[0];
  const { start, end } = labDayUtcRange(date);
  const fmt = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, '');
  return { date, start: fmt(start), end: fmt(end) };
}

// Auto-lock TOMORROW's (J+1) orders — enforces the 15h/16h deadline rule Axel announced to
// the team 2026-08-13: past the deadline, assistants may only adjust DELIVERED qty (already
// supported by the delivery-check screen), never the client-requested qty, and can't add a new
// SKU to a locked order — that requires a brand-new order + oral production approval (no app
// feature for that, by design — deliberately handled outside the app).
//
// Scoped STRICTLY by delivery date (commitment_date / delivery_date), never by creation time —
// an order entered early today but for delivery 2+ days out must NOT be locked yet (Axel,
// 2026-08-13 explicit clarification: "si une commande est cree a 14h mais la delivery date est
// dans 2 j, il faut pas la valider"). Same-day (J) deliveries are deliberately OUT of scope —
// treated like exceptional orders, never auto-locked by this job.
//
// Called twice daily by pg_cron with the exact same "tomorrow" window — 16h VN (first pass,
// the announced deadline) and 23:59 VN (catch-all for anything entered between the two, or
// entered late but still meant for tomorrow). Both runs only ever match draft/sent (sale.order)
// or draft/submitted (stock.replenishment.request) — an order already locked by the 16h run no
// longer matches the search, so the 23:59 run just skips it. Safe to run more than twice, or to
// re-run by hand — idempotent by construction.
//
// stock.replenishment.request: two-step transition, both confirmed via live Odoo dev-mode
// screenshots (2026-08-13) — "Submit for Approval" (method action_submit) is only visible when
// state == 'draft', and "Approve" (method action_approve) is only visible when state ==
// 'submitted'. A draft record therefore needs action_submit called first (draft → submitted)
// before action_approve (submitted → approved) — calling action_approve directly on a draft
// would have silently been the wrong method. Per-record try/catch (same pattern as
// confirmDoneMOs in odoo-mo-confirm.ts) still isolates any failure to that one record.
export async function lockTomorrowOrders(dryRun: boolean): Promise<OrderLockResult> {
  const { date, start, end } = tomorrowUtcRange();
  const res: OrderLockResult = {
    date, dryRun,
    salesOrders: { eligible: 0, confirmed: [], errors: [] },
    replenishments: { eligible: 0, confirmed: [], errors: [] },
  };
  if (!odooWriteConfigured()) return res;

  const orders = await odooExecute<any[]>('sale.order', 'search_read',
    [[['state', 'in', ['draft', 'sent']], ['commitment_date', '>=', start], ['commitment_date', '<', end]]],
    { fields: ['id', 'name'] });
  res.salesOrders.eligible = orders.length;
  for (const o of orders) {
    if (dryRun) { res.salesOrders.confirmed.push({ id: o.id, name: o.name }); continue; }
    try {
      await odooExecuteWrite('sale.order', 'action_confirm', [[o.id]]);
      res.salesOrders.confirmed.push({ id: o.id, name: o.name });
    } catch (e: any) {
      res.salesOrders.errors.push({ id: o.id, name: o.name, error: String(e?.message ?? e) });
    }
  }

  const repls = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
    [[['state', 'in', ['draft', 'submitted']], ['delivery_date', '>=', start], ['delivery_date', '<', end]]],
    { fields: ['id', 'name', 'state'] });
  res.replenishments.eligible = repls.length;
  for (const r of repls) {
    if (dryRun) { res.replenishments.confirmed.push({ id: r.id, name: r.name }); continue; }
    try {
      if (r.state === 'draft') {
        await odooExecuteWrite('stock.replenishment.request', 'action_submit', [[r.id]]);
      }
      await odooExecuteWrite('stock.replenishment.request', 'action_approve', [[r.id]]);
      res.replenishments.confirmed.push({ id: r.id, name: r.name });
    } catch (e: any) {
      res.replenishments.errors.push({ id: r.id, name: r.name, error: String(e?.message ?? e) });
    }
  }

  return res;
}
