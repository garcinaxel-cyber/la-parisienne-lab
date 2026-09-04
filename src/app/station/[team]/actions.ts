'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { sendZaloWebhook } from '@/lib/zalo';
import { TEAM_LABELS } from '@/lib/types';
import { odooConfigured } from '@/lib/odoo';
import { runAutoOdooSync } from '@/lib/odoo-auto-sync';

// Push subscribe/unsubscribe (phase 3, 2026-09-04) — same auth posture as syncOdooAction: the
// user session only confirms the click came from a logged-in station account, the actual write
// goes through the service-role client since lab_push_subscriptions has zero RLS policies (see
// lab_v61_push_subscriptions). endpoint is globally unique per device subscription, so upsert on
// it — a chef re-enabling on the same device/browser just refreshes the row instead of
// duplicating it.
export async function subscribePushAction(
  team: string,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return { error: 'Invalid subscription' };
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Not configured' };
  // push_all_teams (profiles): Axel, 2026-09-04 — his account only, not every admin, receives
  // push for every team's orders regardless of which station he taps the bell on.
  const { data: profile } = await supabase.from('profiles').select('push_all_teams').eq('id', session.user.id).single();
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await service.from('lab_push_subscriptions').upsert({
    team,
    all_teams: profile?.push_all_teams ?? false,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_id: session.user.id,
    user_name: session.user.email ?? null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  if (error) return { error: error.message };
  return { ok: true };
}

export async function unsubscribePushAction(endpoint: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  if (!endpoint) return { error: 'Missing endpoint' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  await service.from('lab_push_subscriptions').delete().eq('endpoint', endpoint);
  return { ok: true };
}

export async function sendProductionReadyNotification(
  teamSlug: string,
  date: string,
): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
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
  const { data: { session } } = await getSafeSession(supabase);
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

// Analytics tab data — reworked 2026-08-21 (Axel: "Completion by team (delivery) du jour" + Lab
// stock for the team's own products; everything from lab_daily_stats removed). Same access
// pattern as before: lab_delivery_check_lines/lab_excluded_skus RLS only grants SELECT to admin/
// lab_manager/assistant, so a station chef's own session can't read them directly — confirm the
// call comes from a logged-in station account, then use the service-role client, returning only
// pre-aggregated, team-scoped numbers.
export type StockLevel = { sku: string; name: string; qty: number; found: boolean; threshold: number | null };
export type StockCategoryGroup = { category: string; items: StockLevel[] };
export type CompletionProductDetail = { sku: string; name: string; expected: number; checked: number; gap: number };
export type TeamAnalytics = {
  completion: { expected: number; checked: number; rate: number; products: CompletionProductDetail[] };
  stock: StockCategoryGroup[]; // empty for teams with no dedicated stock category (entremet, baker)
};

// Which lab_fiche_meta.category values to show live Odoo stock for, per team (Axel, 2026-08-21:
// "stocks Lab des tiramisu (baby_mama), macaron et biscuit voyage (team hung)"). Confirmed live:
// category='Tiramisu' → 11 SKUs, all team baby_mama; 'Macaron' → 35 SKUs + 'Biscuit Voyage' → 22
// SKUs, both team hung. Entremet/baker intentionally have no entry — completion-only (Axel "OUI").
// IMPORTANT: 'Biscuit Voyage' is NOT exclusive to hung — 5 "Lady Finger" ("Bánh Sampa...") SKUs
// in that same category belong to baby_mama (confirmed live, 2026-09-04: teams=['baby_mama'] on
// all 5, vs. hung's 22 and baker's 3 in the same category). 'Biscuit Voyage' is listed for BOTH
// teams below on purpose — filtering by category alone would leak baby_mama's items into hung's
// stock card (and vice versa), so getTeamAnalyticsAction also filters lab_fiche_meta.teams @>
// [team], which scopes each team to only its own SKUs within the shared category.
const TEAM_STOCK_CATEGORIES: Record<string, string[]> = {
  baby_mama: ['Tiramisu', 'Biscuit Voyage'],
  hung: ['Macaron', 'Biscuit Voyage'],
};

export async function getTeamAnalyticsAction(team: string): Promise<{ data?: TeamAnalytics; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Service role not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Today only, Vietnam local day boundary — same convention used across the app (shop portal,
  // delivery-check today/tomorrow picker, lib/checks.ts).
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  const [{ data: checkLines }, { data: excludedRows }] = await Promise.all([
    service.from('lab_delivery_check_lines')
      .select('sku, product_name_vi, qty_expected, qty_checked')
      .eq('team', team).eq('category', 'production').eq('delivery_date', todayStr),
    service.from('lab_excluded_skus').select('sku'),
  ]);
  // Same "non produit" exclusion as the admin Completion by team (delivery) metric (Axel,
  // 2026-08-20) — a SKU that's really packaging/drinks/raw material but stuck at
  // category='production' (stale bucketing) shouldn't count against a chef's completion.
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
  let expected = 0, checked = 0;
  const perProduct: Record<string, { name: string; expected: number; checked: number }> = {};
  for (const l of checkLines ?? []) {
    if (l.sku && excludedSkuSet.has(l.sku)) continue;
    expected += l.qty_expected ?? 0;
    checked += l.qty_checked ?? 0;
    const key = l.sku || l.product_name_vi || '—';
    (perProduct[key] ??= { name: l.product_name_vi || l.sku || '—', expected: 0, checked: 0 });
    perProduct[key].expected += l.qty_expected ?? 0;
    perProduct[key].checked += l.qty_checked ?? 0;
  }
  // Detail (Axel, 2026-08-21: "je veux le detail aussi") — which products are actually behind,
  // not just the aggregate rate. Any real mismatch, worst first in either direction (Axel,
  // 2026-08-29: afficher aussi le supplément livré, pas juste les manques — gap<0 = surplus).
  const products: CompletionProductDetail[] = Object.entries(perProduct)
    .map(([sku, v]) => ({ sku, name: v.name, expected: v.expected, checked: v.checked, gap: v.expected - v.checked }))
    .filter(p => p.gap !== 0)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const completion = { expected, checked, rate: expected ? Math.round(checked / expected * 100) : 0, products };

  // Lab stock — read-only, live from Odoo (lib/odoo-inventory.ts, same LAB/Stock lookup as the
  // finished-goods inventory-count feature). Grouped by category (Axel, 2026-08-21: "faut que ce
  // soit ranger par categorie"), category order fixed by TEAM_STOCK_CATEGORIES above rather than
  // alphabetical. Swallow Odoo errors so a chef still sees today's completion even if Odoo is
  // briefly unreachable.
  let stock: StockCategoryGroup[] = [];
  const categories = TEAM_STOCK_CATEGORIES[team];
  if (categories?.length) {
    const { data: fiches } = await service.from('lab_fiche_meta')
      .select('id, category').in('category', categories).contains('teams', [team]);
    const categoryByFiche: Record<string, string> = {};
    for (const f of fiches ?? []) categoryByFiche[f.id] = f.category;
    const ficheIds = Object.keys(categoryByFiche);
    const { data: variants } = ficheIds.length
      ? await service.from('lab_fiche_variants').select('sku, fiche_id').in('fiche_id', ficheIds)
      : { data: [] as any[] };
    const categoryBySku: Record<string, string> = {};
    for (const v of variants ?? []) if (v.sku && v.fiche_id) categoryBySku[v.sku] = categoryByFiche[v.fiche_id] ?? '';
    const skus = Array.from(new Set(Object.keys(categoryBySku)));
    if (skus.length) {
      try {
        const { getLabStockLevels } = await import('@/lib/odoo-inventory');
        const [levels, { data: thresholdRows }] = await Promise.all([
          getLabStockLevels(skus),
          service.from('lab_stock_safety_thresholds').select('sku, threshold').in('sku', skus),
        ]);
        const thresholdBySku: Record<string, number> = {};
        for (const t of thresholdRows ?? []) thresholdBySku[t.sku] = Number(t.threshold);
        const byCategory: Record<string, StockLevel[]> = {};
        for (const l of levels) {
          const withThreshold: StockLevel = { ...l, threshold: thresholdBySku[l.sku] ?? null };
          (byCategory[categoryBySku[l.sku] || ''] ??= []).push(withThreshold);
        }
        for (const cat of Object.keys(byCategory)) byCategory[cat].sort((a, b) => a.name.localeCompare(b.name));
        stock = categories.filter(c => byCategory[c]?.length).map(c => ({ category: c, items: byCategory[c] }));
      } catch {
        stock = [];
      }
    }
  }

  return { data: { completion, stock } };
}

// Safety stock threshold per SKU (Axel, 2026-08-21: "mettre la possibilite de mettre un stock de
// securite par ligne de produit, si ca passe sous ce seuil la ligne se met en rouge et dit : faut
// produire"). Chefs edit this themselves, inline in the Lab stock card — same auth gate as the
// rest of this file (must be a logged-in station session), service-role write since
// lab_stock_safety_thresholds has no client RLS policies (see lab_v47). userName comes from the
// client (already known there, same as blocked_by_name in StationView.tsx) rather than an extra
// profile lookup.
export async function setStockThresholdAction(sku: string, threshold: number, userName: string | null): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  if (!Number.isFinite(threshold) || threshold < 0) return { error: 'Invalid threshold' };

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Service role not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { error } = await service.from('lab_stock_safety_thresholds').upsert({
    sku, threshold, updated_by: session.user.id, updated_by_name: userName, updated_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };
  return { ok: true };
}
