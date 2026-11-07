import { unstable_cache } from 'next/cache';
import { rawService } from '@/lib/raw-materials-db';
import type { UserRole } from '@/lib/types';
import type { Badges } from '@/lib/nav';

// Counts behind the menu badges and the Control board (moved out of (app)/layout.tsx on
// 2026-11-07, unchanged: same queries, same 20 s shared cache, same cache key and tags so the
// existing revalidateTag('layout-badges' | 'delivery-tasks' | 'birthday-cakes') calls still work).
export type RawCounts = {
  pendingTransfers: number; pendingExceptional: number; pendingOemReceptions: number;
  pendingPurchasing: number; reconciliationIssues: number; tasksBase: number; tasksToSend: number; cakesNoMessage: number;
};

export async function loadRawCounts(): Promise<RawCounts | null> {
  // Badges: transfer notes awaiting reception (both reception sub-tabs — internal AND
  // Shop ↔ Lab, Axel 2026-09-16: "l onglet qui averti du nombre de reception a check doit
  // prendre en compte le deuxieme sous onglet") + manual orders still to enter in Odoo.
  // Shop ↔ Lab transfers + losses counts mirror shop/actions.ts's since-yesterday (VN calendar
  // day) cutoff on getMyShopTransfersAction('Lab')/getShopLossesForLabReceptionAction — same
  // vnYesterdayStartIso() logic, duplicated here since that file is 'use server' (exports must be
  // async actions, not a plain helper to import).
  // Axel, 2026-09-17 (2nd correction): the unbounded "however old" losses count above (badge was
  // showing 318 — everything ever reported, since this reception step is brand new) was reverted
  // for the same reason the reception query itself was: "on avait rien mis en place avant ...
  // plus de 300 pertes a check c'est pas possible". Both badges now count only what's actually
  // reachable in the reception tab: reported since yesterday, still unconfirmed.
  function vnYesterdayStartIso(): string {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
    const yesterday = fmt.format(new Date(Date.now() - 24 * 3600 * 1000));
    return new Date(`${yesterday}T00:00:00+07:00`).toISOString();
  }
  // Perf (Axel 2026-10-26: "quand je navigue c'est vraiment lent"): every page load AND every
  // server action that revalidates re-renders this layout. All sidebar counts are now computed in
  // ONE parallel batch with the service key and cached 20 s (shared by all staff; a badge may lag
  // by up to 20 s). Who sees which badge is unchanged (role checks below).
  const db = rawService();
  return unstable_cache(async () => {
    if (!db) return null;
    const yesterdayVNIso = vnYesterdayStartIso();
    const { computeDeliveryTaskCount } = await import('@/lib/delivery-tasks');
    const { countCakesWithoutMessage } = await import('@/lib/birthday-cakes-data');
    const [a, b, c, d, e, f, g, h, tasks, cakes] = await Promise.all([
      db.from('lab_stock_transfers').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      db.from('lab_shop_transfers').select('*', { count: 'exact', head: true }).eq('to_shop', 'Lab').eq('status', 'sent').gte('sent_at', yesterdayVNIso),
      db.from('lab_shop_losses').select('*', { count: 'exact', head: true }).is('lab_received_at', null).is('cancelled_at', null).gte('reported_at', yesterdayVNIso),
      db.from('lab_manual_cakes').select('*', { count: 'exact', head: true }).eq('needs_odoo', true).is('matched_order_ref', null),
      // OEM Orders (Axel, 2026-09-28): batches Hưng declared that no assistant has received yet
      db.from('lab_mm_production_log').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      // Purchasing (Axel 2026-10-12/13): lines to order (not yet in a draft PO) + slips to confirm
      db.from('lab_purchase_request_lines').select('*', { count: 'exact', head: true }).eq('status', 'pending').is('po_odoo_id', null),
      // team ↔ team transfers wait for the other team, not storage (Axel, 2026-11-07)
      db.from('lab_raw_withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'to_confirm')
        .or('kind.is.null,kind.neq.transfer,from_team.eq.kho,to_team.eq.kho'),
      // Check badge (admin only, shown below): sums all 4 checks (2026-08-20)
      db.from('lab_reconciliation_runs').select('issue_count, delivery_coverage_count, production_stock_count, stock_odoo_count').order('run_at', { ascending: false }).limit(1).maybeSingle(),
      computeDeliveryTaskCount(db as any).catch(() => ({ base: 0, toSend: 0 })),
      countCakesWithoutMessage(db as any).catch(() => 0),
    ]);
    const run: any = h.data;
    return {
      pendingTransfers: (a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0),
      pendingExceptional: d.count ?? 0,
      pendingOemReceptions: e.count ?? 0,
      pendingPurchasing: (f.count ?? 0) + (g.count ?? 0),
      reconciliationIssues: (run?.issue_count ?? 0) + (run?.delivery_coverage_count ?? 0) + (run?.production_stock_count ?? 0) + (run?.stock_odoo_count ?? 0),
      tasksBase: tasks.base, tasksToSend: tasks.toSend, cakesNoMessage: cakes,
    };
  }, ['layout-badges-v1'], { revalidate: 20, tags: ['layout-badges', 'delivery-tasks', 'birthday-cakes'] })();
}

/** Same role rules as before the menu change (who sees which badge). */
export function badgesForRole(raw: RawCounts | null, p: { role: UserRole; can_purchase?: boolean }): Badges {
  const r = raw;
  const canSeePurchasing = p.role === 'purchasing' || p.role === 'admin' || !!p.can_purchase;
  const isDeliveryRole = ['admin', 'lab_manager', 'assistant'].includes(p.role);
  const b: Badges = {
    reception: r?.pendingTransfers ?? 0,
    special: r?.pendingExceptional ?? 0,
    specialRed: isDeliveryRole ? (r?.cakesNoMessage ?? 0) : 0,
    oem: r?.pendingOemReceptions ?? 0,
    purchasing: canSeePurchasing ? (r?.pendingPurchasing ?? 0) : 0,
    check: p.role === 'admin' ? (r?.reconciliationIssues ?? 0) : 0,
    delivery: isDeliveryRole ? (r?.tasksBase ?? 0) + (['admin', 'lab_manager'].includes(p.role) ? (r?.tasksToSend ?? 0) : 0) : 0,
  };
  return b;
}
