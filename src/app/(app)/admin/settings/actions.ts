'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

export async function saveNotificationSetting(
  target: string,
  webhookUrl: string,
): Promise<{ error?: string; success?: true }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) {
    return { error: 'Not authorized' };
  }

  const { error } = await supabase
    .from('lab_notification_settings')
    .upsert(
      { target, zalo_webhook_url: webhookUrl.trim() || null, updated_at: new Date().toISOString() },
      { onConflict: 'target' }
    );

  if (error) return { error: error.message };
  revalidatePath('/admin/settings');
  return { success: true };
}
