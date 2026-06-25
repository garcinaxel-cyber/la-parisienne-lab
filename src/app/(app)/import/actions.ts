'use server';
import { createClient } from '@/lib/supabase-server';

export async function createFicheFromSku(
  sku: string,
  nameVi: string,
): Promise<{ ficheId?: string; error?: string }> {
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

  const { data, error } = await supabase
    .from('lab_fiche_meta')
    .insert({ name_vi: nameVi, is_active: true })
    .select('id')
    .single();

  if (error || !data?.id) return { error: error?.message ?? 'Failed to create fiche' };
  return { ficheId: data.id };
}
