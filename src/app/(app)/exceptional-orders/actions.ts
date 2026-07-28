'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';
import { createOdooOrderForSelection } from '@/lib/odoo-shop-order-sync';

// Regenerate the universal shop order link. The old URL dies instantly —
// hand the new one to the shops. Managers only (also enforced by RLS).
export async function regenerateShopLinkAction(): Promise<{ ok?: boolean; token?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  // Short, unguessable, URL-friendly (14 hex chars ≈ 56 bits — plenty for an internal form)
  const token = randomUUID().replace(/-/g, '').slice(0, 14);
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


// Semi-automatic Odoo creation: an admin picks one or more exceptional orders (all from the
// same shop) on /exceptional-orders and this creates ONE draft quotation/replenishment
// covering all of them — grouping same-day orders for one client is the whole point (e.g.
// several Moon Flower birthday cakes ordered separately in one day). Synchronous: the admin
// sees the result (order ref or error) immediately, no background queue/cron involved.
export async function createOdooOrderAction(manualCakeIds: string[]): Promise<{ ok?: boolean; orderRef?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const res = await createOdooOrderForSelection(supabase, manualCakeIds);
  revalidatePath('/exceptional-orders');
  if (!res.ok) return { error: res.error ?? 'Unknown error' };
  return { ok: true, orderRef: res.order_ref, error: res.error };
}
