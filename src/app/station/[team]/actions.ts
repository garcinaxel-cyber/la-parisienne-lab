'use server';
import { createClient } from '@/lib/supabase-server';
import { sendZaloWebhook } from '@/lib/zalo';
import { TEAM_LABELS } from '@/lib/types';

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
