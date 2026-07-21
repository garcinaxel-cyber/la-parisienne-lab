'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';

// Regenerate the universal shop order link. The old URL dies instantly —
// hand the new one to the shops. Managers only (also enforced by RLS).
export async function regenerateShopLinkAction(): Promise<{ ok?: boolean; token?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const token = randomUUID().replace(/-/g, '');
  const { data: row } = await supabase.from('lab_shop_link').select('id').limit(1).maybeSingle();
  if (row?.id) {
    const { error } = await supabase.from('lab_shop_link')
      .update({ token, active: true, regenerated_at: new Date().toISOString() }).eq('id', row.id);
    if (error) return { error: error.message };
  } else {
    const { error } = await supabase.from('lab_shop_link').insert({ token });
    if (error) return { error: error.message };
  }
  revalidatePath('/exceptional-orders');
  return { ok: true, token };
}
