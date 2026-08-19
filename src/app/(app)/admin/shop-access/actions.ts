'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

async function requireProfile(supabase: ReturnType<typeof createClient>) {
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' as const };
  return { session, profile };
}

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function generateShopLinkAction(shopName: string): Promise<{ token?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const name = shopName.trim();
  if (!name) return { error: 'Nom de boutique manquant' };

  const token = newToken();
  const { error } = await supabase.from('lab_shop_portal_links').upsert({
    shop_name: name, token, active: true,
    created_by: auth.session.user.id, created_by_name: auth.profile?.full_name ?? null,
  }, { onConflict: 'shop_name' });
  if (error) return { error: error.message };
  revalidatePath('/admin/shop-access');
  return { token };
}

export async function regenerateShopLinkAction(id: string): Promise<{ token?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const token = newToken();
  const { error } = await supabase.from('lab_shop_portal_links').update({
    token, regenerated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/shop-access');
  return { token };
}

export async function setShopLinkActiveAction(id: string, active: boolean): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const { error } = await supabase.from('lab_shop_portal_links').update({ active }).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/shop-access');
  return { ok: true };
}
