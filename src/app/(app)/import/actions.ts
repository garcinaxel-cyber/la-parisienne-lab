'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { sendTeamPush } from '@/lib/push-notify';

// Phase-3 push notification for the MANUAL publish flow (2026-09-04). ImportView.tsx ('use
// client') calls persistImportsFromLines directly with a browser Supabase client — web-push
// needs Node-only modules (net/tls) that can't be bundled into client JS, so the actual send has
// to happen here, server-side, as a small follow-up call with the team counts
// persistImportsFromLines already handed back. Same auth posture as createFicheFromSku below
// (session + admin/lab_manager role), service-role client for the actual read/send since
// lab_push_subscriptions has zero RLS policies.
export async function notifyNewOrdersPushAction(teamCounts: Record<string, number>): Promise<void> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return;
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return;
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;

  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  for (const [team, count] of Object.entries(teamCounts ?? {})) {
    if (!count) continue;
    await sendTeamPush(service, team, {
      title: 'La Parisienne Lab',
      body: count > 1 ? `${count} đơn hàng mới vừa đến` : 'Có đơn hàng mới vừa đến',
      url: `/station/${team}`,
    }).catch(() => {});
  }
}

export async function createFicheFromSku(
  sku: string,
  nameVi: string,
): Promise<{ ficheId?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
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

  // Create a default "Standard" variant with the SKU so future imports recognise it
  if (sku) {
    await supabase.from('lab_fiche_variants').insert({
      fiche_id: data.id,
      label: 'Standard',
      sku,
      is_default: true,
      sort_order: 0,
    });
  }

  return { ficheId: data.id };
}
