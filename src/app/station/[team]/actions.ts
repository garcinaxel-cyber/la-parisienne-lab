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
