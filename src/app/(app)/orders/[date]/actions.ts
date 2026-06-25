'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { sendZaloWebhook } from '@/lib/zalo';
import { TEAM_LABELS } from '@/lib/types';

export async function publishImportAction(
  importId: string,
  date: string,
): Promise<{ error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''))
    return { error: 'Not authorized' };

  const { error: updateError } = await supabase
    .from('lab_imports')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', importId);
  if (updateError) return { error: updateError.message };

  // Notifications — best-effort
  const { data: imp } = await supabase
    .from('lab_imports').select('type, order_number').eq('id', importId).single();
  const { data: asgns } = await supabase
    .from('lab_assignments').select('team').eq('import_id', importId);
  const teams = Array.from(new Set((asgns ?? []).map((a: any) => a.team as string)));
  const { data: settings } = await supabase
    .from('lab_notification_settings')
    .select('target, zalo_webhook_url').in('target', teams);

  const dateStr = new Date(date + 'T00:00:00').toLocaleDateString('vi-VN', {
    weekday: 'long', day: 'numeric', month: 'numeric',
  });
  const orderLabel = imp?.type === 'daily' ? 'Đơn chính' : 'Đơn khẩn';

  for (const s of settings ?? []) {
    if (!s.zalo_webhook_url) continue;
    const count = (asgns ?? []).filter((a: any) => a.team === s.target).length;
    const teamLabel = (TEAM_LABELS as any)[s.target]?.vi ?? s.target;
    const msg = `🍰 La Parisienne Lab\n📋 ${orderLabel} #${imp?.order_number} — ${dateStr}\n✅ Đã phát hành cho ${teamLabel}: ${count} sản phẩm cần sản xuất`;
    await sendZaloWebhook(s.zalo_webhook_url, msg);
  }

  revalidatePath(`/orders/${date}`);
  return {};
}
