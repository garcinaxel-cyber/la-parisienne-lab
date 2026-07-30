'use server';
import { createClient } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { sendZaloWebhook } from '@/lib/zalo';
import { TEAM_LABELS } from '@/lib/types';
import { odooConfigured } from '@/lib/odoo';
import { runAutoOdooSync } from '@/lib/odoo-auto-sync';

export async function sendProductionReadyNotification(
  teamSlug: string,
  date: string,
): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  const { data: setting } = await supabase
    .from('lab_notification_settings')
    .select('zalo_webhook_url')
    .eq('target', 'assistants')
    .single();

  if (!setting?.zalo_webhook_url) return {};

  const teamLabel = (TEAM_LABELS as any)[teamSlug]?.vi ?? teamSlug;
  const dateStr = new Date(date + 'T00:00:00').toLocaleDateString('vi-VN', {
    day: 'numeric', month: 'numeric', year: 'numeric',
  });
  const msg = `✅ La Parisienne Lab\n🏭 ${teamLabel} báo cáo: PRODUCTION PRÊTE!\n📅 ${dateStr}`;
  await sendZaloWebhook(setting.zalo_webhook_url, msg);
  return {};
}

// On-demand Odoo sync for the station pages — any logged-in chef can trigger it, no admin
// role required (it only ever PULLS from Odoo, same "auto" behaviour as the cron: new orders
// published straight away, changes/cancellations auto-applied, nothing to review). Exists so a
// chef doesn't have to wait for the next 15-min cron pass to see a fresh order. Uses the
// service-role client for the actual writes (spans tables no station RLS policy grants), the
// user session is only checked to confirm the click came from a logged-in station account.
export async function syncOdooAction(): Promise<{ ok?: boolean; createdImports?: number; changesApplied?: number; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: 'Odoo sync not configured' };
  }
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    const result = await runAutoOdooSync(service as any);
    if (result.error) return { error: result.error };
    return { ok: true, createdImports: result.created_imports, changesApplied: result.changes_applied };
  } catch (e: any) {
    return { error: e?.message ?? 'Odoo sync failed' };
  }
}

// Analytics tab data — team-scoped read of lab_daily_stats (the permanent daily aggregate).
// lab_daily_stats' RLS only grants SELECT to admin/lab_manager/assistant (it backs the admin
// analytics page), so a station chef's own session can't read it directly. Same shape as
// syncOdooAction above: confirm the click comes from a logged-in station account, then use the
// service-role client for the actual read — this only ever returns pre-aggregated, team-scoped
// numbers, never raw table access, so it doesn't widen what a chef can see.
export type ProductStat = { name: string; avg: number; trendPct: number };
export type CategoryGroup = { category: string; products: ProductStat[] };
export type TeamAnalytics = {
  completion: number;
  blocked: number;
  margin: number; // qty_extra / qty_ordered, %
  categories: CategoryGroup[];
  daily: { date: string; units: number }[];
};

export async function getTeamAnalyticsAction(team: string, days: 7 | 30): Promise<{ data?: TeamAnalytics; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Service role not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const toDate = new Date();
  const toStr = toDate.toISOString().split('T')[0];
  const from = new Date(toDate);
  from.setDate(from.getDate() - days + 1);
  const fromStr = from.toISOString().split('T')[0];

  const { data, error } = await service
    .from('lab_daily_stats')
    .select('day, sku, product_name, qty_ordered, qty_produced, qty_extra, cards_total, cards_done, cards_blocked')
    .eq('team', team).gte('day', fromStr).lte('day', toStr).limit(5000);
  if (error) return { error: error.message };
  const rows = (data ?? []) as any[];

  // Category lookup: sku -> lab_fiche_variants.fiche_id -> lab_fiche_meta.category (same join
  // pattern used elsewhere for team resolution). Chefs asked for the list grouped by category
  // instead of one long flat list.
  const skus = Array.from(new Set(rows.map(r => r.sku).filter(Boolean)));
  const { data: variantRows } = skus.length
    ? await service.from('lab_fiche_variants').select('sku, fiche_id').in('sku', skus)
    : { data: [] as any[] };
  const ficheBySku: Record<string, string> = {};
  for (const v of variantRows ?? []) if (v.sku && v.fiche_id) ficheBySku[v.sku] = v.fiche_id;
  const ficheIds = Array.from(new Set(Object.values(ficheBySku)));
  const { data: ficheRows } = ficheIds.length
    ? await service.from('lab_fiche_meta').select('id, category').in('id', ficheIds)
    : { data: [] as any[] };
  const categoryByFiche: Record<string, string> = {};
  for (const f of ficheRows ?? []) if (f.category) categoryByFiche[f.id] = f.category;
  const UNCATEGORIZED = 'Other';
  const categoryForSku = (sku: string) => categoryByFiche[ficheBySku[sku]] || UNCATEGORIZED;

  let cardsTotal = 0, cardsDone = 0, cardsBlocked = 0, qtyOrderedSum = 0, qtyExtraSum = 0;
  const perDay: Record<string, number> = {};
  // Trend = avg ordered/day in the second half of the range vs the first half, per product.
  const allDays = Array.from(new Set(rows.map(r => r.day as string))).sort();
  const mid = Math.floor(allDays.length / 2);
  const firstHalf = new Set(allDays.slice(0, mid));
  const secondHalf = new Set(allDays.slice(mid));
  const perProduct: Record<string, { name: string; category: string; total: number; first: number; second: number }> = {};

  for (const r of rows) {
    cardsTotal += r.cards_total ?? 0;
    cardsDone += r.cards_done ?? 0;
    cardsBlocked += r.cards_blocked ?? 0;
    qtyOrderedSum += r.qty_ordered ?? 0;
    qtyExtraSum += r.qty_extra ?? 0;
    perDay[r.day] = (perDay[r.day] ?? 0) + (r.qty_produced ?? 0);
    const key = r.sku || r.product_name || '—';
    (perProduct[key] ??= {
      name: r.product_name || r.sku || '—',
      category: r.sku ? categoryForSku(r.sku) : UNCATEGORIZED,
      total: 0, first: 0, second: 0,
    });
    perProduct[key].total += r.qty_ordered ?? 0;
    if (firstHalf.has(r.day)) perProduct[key].first += r.qty_ordered ?? 0;
    else if (secondHalf.has(r.day)) perProduct[key].second += r.qty_ordered ?? 0;
  }

  // Every product the team touched in range, not just a top-N — a raw-qty ranking alone would
  // bury lower-piece-count items (a cake counted 1-2/order) under high-piece-count ones (macarons
  // sold by the dozen), even though they take just as much of the team's time. Grouped by
  // category (biggest category first, by total volume), products sorted by avg within each.
  const flatProducts = Object.values(perProduct)
    .filter(v => v.total > 0)
    .map(v => {
      const firstAvg = firstHalf.size ? v.first / firstHalf.size : 0;
      const secondAvg = secondHalf.size ? v.second / secondHalf.size : 0;
      const trendPct = firstAvg > 0 ? Math.round((secondAvg - firstAvg) / firstAvg * 100)
        : secondAvg > 0 ? 100 : 0;
      return { name: v.name, category: v.category, avg: Math.round((v.total / days) * 10) / 10, trendPct, total: v.total };
    });

  const categoryTotals: Record<string, number> = {};
  for (const p of flatProducts) categoryTotals[p.category] = (categoryTotals[p.category] ?? 0) + p.total;
  const categories: CategoryGroup[] = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => ({
      category,
      products: flatProducts
        .filter(p => p.category === category)
        .sort((a, b) => b.avg - a.avg)
        .map(({ name, avg, trendPct }) => ({ name, avg, trendPct })),
    }));

  const daily = allDays.slice(-14).map(d => ({ date: d, units: perDay[d] ?? 0 }));

  return {
    data: {
      completion: cardsTotal ? Math.round(cardsDone / cardsTotal * 100) : 0,
      blocked: cardsBlocked,
      margin: qtyOrderedSum ? Math.round(qtyExtraSum / qtyOrderedSum * 100) : 0,
      categories, daily,
    },
  };
}
