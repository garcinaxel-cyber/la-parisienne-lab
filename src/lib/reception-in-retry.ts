import type { SupabaseClient } from '@supabase/supabase-js';
import { gapsSchemaReady, GAPS_FROM } from '@/lib/reception-gaps';
import { validateShopIn } from '@/lib/reception-odoo';

// Retry of the shop IN auto-validation (Axel, 2026-10-15 — "je veux une relance automatique").
// The shop confirms its reception as soon as the goods arrive, but the Lab sometimes creates /
// validates the REP's LAB/OUT in Odoo later (REP/2026/01989: confirmed 08:00 UTC, OUT + IN
// created 09:44 UTC). The one-shot auto-validation then logs no_shop_in / lab_out_not_validated
// and nothing ever tries again. Run from the 15-min Odoo cron: every COMPLETE and CONFORMING
// replenishment reception of the last 3 days whose IN is not yet known as validated is passed
// again through validateShopIn (idempotent: an IN already done comes back ok/alreadyDone).
// Receptions with a gap are never touched here — they stay with the Lab's final button.

const RETRY_DAYS = 3;
const MAX_PER_RUN = 10;
const BY_NAME = 'Tự động (cron)';

function vnDate(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() + offsetDays * 86400000));
}

export type InRetryResult = { checked: number; retried: number; validated: string[]; stillPending: { orderRef: string; reason: string }[] };

export async function retryPendingShopIns(sb: SupabaseClient): Promise<InRetryResult> {
  const out: InRetryResult = { checked: 0, retried: 0, validated: [], stillPending: [] };
  if (!(await gapsSchemaReady(sb))) return out;

  const { data: orders } = await sb.from('lab_delivery_orders')
    .select('id, order_ref, marked_not_delivered')
    .eq('source_type', 'replenishment').eq('status', 'validated')
    // Never before GAPS_FROM: earlier deliveries were reconciled by hand.
    .gte('delivery_date', [vnDate(-RETRY_DAYS), GAPS_FROM].sort()[1]).lte('delivery_date', vnDate(0));
  const candidates = (orders ?? []).filter((o: any) => !o.marked_not_delivered && o.order_ref);
  if (!candidates.length) return out;
  const ids = candidates.map((o: any) => o.id);

  const [{ data: lines }, { data: recs }, { data: runs }] = await Promise.all([
    sb.from('lab_delivery_check_lines').select('id, delivery_order_id, sku, qty_expected, qty_checked').in('delivery_order_id', ids),
    sb.from('lab_shop_receipt_lines').select('check_line_id, delivery_order_id, qty_received, qty_damaged').in('delivery_order_id', ids),
    sb.from('lab_reception_odoo_runs').select('delivery_order_id, action, mode, ok, error, created_at')
      .in('delivery_order_id', ids).in('action', ['validate_in', 'rep_finalize']).order('created_at', { ascending: true }),
  ]);
  const recByLine = new Map((recs ?? []).map((r: any) => [r.check_line_id, r]));
  const linesByOrder = new Map<string, any[]>();
  for (const l of lines ?? []) linesByOrder.set(l.delivery_order_id, [...(linesByOrder.get(l.delivery_order_id) ?? []), l]);
  const runsByOrder = new Map<string, any[]>();
  for (const r of runs ?? []) runsByOrder.set(r.delivery_order_id, [...(runsByOrder.get(r.delivery_order_id) ?? []), r]);

  for (const o of candidates) {
    const ls = linesByOrder.get(o.id) ?? [];
    if (!ls.length) continue;
    const rows = ls.map((l: any) => {
      const r: any = recByLine.get(l.id);
      return { sku: l.sku as string | null, sent: Number(l.qty_checked ?? l.qty_expected), received: Number(r?.qty_received ?? NaN), damaged: Number(r?.qty_damaged ?? 0) };
    });
    // Same rule as the shop-side auto-validation: every line confirmed, received = sent, nothing damaged.
    if (!rows.every(r => r.received === r.sent && r.damaged === 0)) continue;
    const rs = runsByOrder.get(o.id) ?? [];
    // Already validated (live), or handled by the Lab's final button → nothing to do.
    if (rs.some(r => r.ok && r.mode === 'live' && (r.action === 'validate_in' || r.action === 'rep_finalize'))) continue;
    out.checked++;
    if (out.retried >= MAX_PER_RUN) { out.stillPending.push({ orderRef: o.order_ref, reason: 'deferred' }); continue; }

    out.retried++;
    const res = await validateShopIn(o.order_ref, rows);
    const error = res.error ?? res.skipped ?? null;
    if (res.ok && res.live) out.validated.push(o.order_ref);
    else out.stillPending.push({ orderRef: o.order_ref, reason: error ?? (res.live ? 'unknown' : 'not_live') });
    // Log only what changes the picture (a success, or a new reason) — not the same skip every 15 min.
    const vins = rs.filter(r => r.action === 'validate_in');
    const last = vins[vins.length - 1];
    if (res.ok || !last || last.error !== error) {
      await sb.from('lab_reception_odoo_runs').insert({
        delivery_order_id: o.id, order_ref: o.order_ref, action: 'validate_in', created_by_name: BY_NAME,
        mode: res.live ? 'live' : 'simulated', ok: res.ok,
        plan: { picking: res.pickingName ?? null, alreadyDone: !!res.alreadyDone, writes: res.plan, retry: true },
        error,
      });
    }
  }
  return out;
}
