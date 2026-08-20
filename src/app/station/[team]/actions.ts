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

// Analytics tab data — reworked 2026-08-21 (Axel: "Completion by team (delivery) du jour" + Lab
// stock for the team's own products; everything from lab_daily_stats removed). Same access
// pattern as before: lab_delivery_check_lines/lab_excluded_skus RLS only grants SELECT to admin/
// lab_manager/assistant, so a station chef's own session can't read them directly — confirm the
// call comes from a logged-in station account, then use the service-role client, returning only
// pre-aggregated, team-scoped numbers.
export type StockLevel = { sku: string; name: string; qty: number; found: boolean };
export type TeamAnalytics = {
  completion: { expected: number; checked: number; rate: number };
  stock: StockLevel[]; // empty for teams with no dedicated stock category (entremet, baker)
};

// Which lab_fiche_meta.category values to show live Odoo stock for, per team (Axel, 2026-08-21:
// "stocks Lab des tiramisu (baby_mama), macaron et biscuit voyage (team hung)"). Confirmed live:
// category='Tiramisu' → 11 SKUs, team baby_mama; 'Macaron' → 35 SKUs + 'Biscuit Voyage' → 4 SKUs,
// both team hung. Entremet/baker intentionally have no entry — completion-only, per Axel ("OUI").
const TEAM_STOCK_CATEGORIES: Record<string, string[]> = {
  baby_mama: ['Tiramisu'],
  hung: ['Macaron', 'Biscuit Voyage'],
};

export async function getTeamAnalyticsAction(team: string): Promise<{ data?: TeamAnalytics; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Service role not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Today only, Vietnam local day boundary — same convention used across the app (shop portal,
  // delivery-check today/tomorrow picker, lib/checks.ts).
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  const [{ data: checkLines }, { data: excludedRows }] = await Promise.all([
    service.from('lab_delivery_check_lines')
      .select('sku, qty_expected, qty_checked')
      .eq('team', team).eq('category', 'production').eq('delivery_date', todayStr),
    service.from('lab_excluded_skus').select('sku'),
  ]);
  // Same "non produit" exclusion as the admin Completion by team (delivery) metric (Axel,
  // 2026-08-20) — a SKU that's really packaging/drinks/raw material but stuck at
  // category='production' (stale bucketing) shouldn't count against a chef's completion.
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));
  let expected = 0, checked = 0;
  for (const l of checkLines ?? []) {
    if (l.sku && excludedSkuSet.has(l.sku)) continue;
    expected += l.qty_expected ?? 0;
    checked += l.qty_checked ?? 0;
  }
  const completion = { expected, checked, rate: expected ? Math.round(checked / expected * 100) : 0 };

  // Lab stock — read-only, live from Odoo (lib/odoo-inventory.ts, same LAB/Stock lookup as the
  // finished-goods inventory-count feature). Swallow Odoo errors so a chef still sees today's
  // completion even if Odoo is briefly unreachable.
  let stock: StockLevel[] = [];
  const categories = TEAM_STOCK_CATEGORIES[team];
  if (categories?.length) {
    const { data: fiches } = await service.from('lab_fiche_meta').select('id').in('category', categories);
    const ficheIds = (fiches ?? []).map((f: any) => f.id);
    const { data: variants } = ficheIds.length
      ? await service.from('lab_fiche_variants').select('sku').in('fiche_id', ficheIds)
      : { data: [] as any[] };
    const skus = Array.from(new Set((variants ?? []).map((v: any) => v.sku).filter(Boolean))) as string[];
    if (skus.length) {
      try {
        const { getLabStockLevels } = await import('@/lib/odoo-inventory');
        stock = (await getLabStockLevels(skus)).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        stock = [];
      }
    }
  }

  return { data: { completion, stock } };
}
