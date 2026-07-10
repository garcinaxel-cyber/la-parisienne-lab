'use server';
import { createClient } from '@/lib/supabase-server';
import { applyOdooChanges } from '@/lib/odoo-apply';
import { revalidatePath } from 'next/cache';

async function guard() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { supabase, ok: false };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  return { supabase, ok: ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''), userId: session.user.id };
}

// Apply all pending Odoo modifications detected by the auto-sync, then mark them resolved.
export async function applyPendingChangesAction(): Promise<{ applied?: number; error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { data: pending } = await supabase
    .from('lab_odoo_changes').select('id, order_ref, cancelled, items').eq('status', 'pending');
  if (!pending?.length) return { applied: 0 };

  const { applied } = await applyOdooChanges(supabase, pending.map((p: any) => ({
    order_ref: p.order_ref, cancelled: p.cancelled, items: p.items,
  })));
  await supabase.from('lab_odoo_changes')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .in('id', pending.map((p: any) => p.id));

  revalidatePath('/dashboard');
  return { applied: applied.length };
}

// Dismiss pending changes without applying (e.g. false positive)
export async function dismissPendingChangesAction(): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  await supabase.from('lab_odoo_changes')
    .update({ status: 'dismissed', resolved_at: new Date().toISOString() }).eq('status', 'pending');
  revalidatePath('/dashboard');
  return {};
}

// Permanently exclude a SKU from production (packaging, drinks…)
export async function excludeSkuAction(sku: string, name: string, reason?: string): Promise<{ error?: string }> {
  const { supabase, ok, userId } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus')
    .upsert({ sku, product_name: name, reason: reason ?? null, excluded_by: userId }, { onConflict: 'sku' });
  if (error) return { error: error.message };
  revalidatePath('/orders', 'layout');
  return {};
}

// From a "changed in Odoo" banner (dashboard/import): mark ONE sku as never-produced.
// Excludes it AND strips it from every pending change; a change with no items left is resolved.
export async function excludeChangeSkuAction(sku: string, name: string): Promise<{ error?: string }> {
  const { supabase, ok, userId } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus')
    .upsert({ sku, product_name: name, reason: 'packaging/not produced', excluded_by: userId }, { onConflict: 'sku' });
  if (error) return { error: error.message };

  const { data: pending } = await supabase
    .from('lab_odoo_changes').select('id, items').eq('status', 'pending');
  for (const row of pending ?? []) {
    const items = (row.items ?? []).filter((it: any) => it.sku !== sku);
    if (items.length === (row.items ?? []).length) continue; // this sku wasn't in the row
    if (items.length === 0) {
      await supabase.from('lab_odoo_changes')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', row.id);
    } else {
      await supabase.from('lab_odoo_changes').update({ items }).eq('id', row.id);
    }
  }
  revalidatePath('/dashboard');
  revalidatePath('/orders', 'layout');
  return {};
}

export async function unexcludeSkuAction(sku: string): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { error } = await supabase.from('lab_excluded_skus').delete().eq('sku', sku);
  if (error) return { error: error.message };
  revalidatePath('/admin/excluded');
  return {};
}
