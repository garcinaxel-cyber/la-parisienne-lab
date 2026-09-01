'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { applyOdooChanges } from '@/lib/odoo-apply';
import { revalidatePath } from 'next/cache';

async function guard() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { supabase, ok: false };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  return { supabase, ok: ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''), userId: session.user.id };
}

// Apply all pending Odoo modifications detected by the auto-sync, then mark them resolved.
export async function applyPendingChangesAction(): Promise<{ applied?: number; error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  const { data: pending } = await supabase
    .from('lab_odoo_changes').select('id, order_ref, cancelled, items, delivery_date').eq('status', 'pending');
  if (!pending?.length) return { applied: 0 };

  const { applied, errors } = await applyOdooChanges(supabase, pending.map((p: any) => ({
    order_ref: p.order_ref, cancelled: p.cancelled, items: p.items,
  })));
  await supabase.from('lab_odoo_changes')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .in('id', pending.map((p: any) => p.id));

  // Same silent-failure risk as the auto-sync path — surface any card-write failure instead
  // of letting it vanish once these rows flip to 'resolved'.
  if (errors.length) {
    const dateByRef = new Map((pending as any[]).map((p: any) => [p.order_ref, p.delivery_date]));
    const byOrder = new Map<string, { sku: string; name?: string; reason: string }[]>();
    for (const e of errors) {
      const arr = byOrder.get(e.order_ref) ?? [];
      arr.push({ sku: e.sku, name: e.name, reason: e.reason });
      byOrder.set(e.order_ref, arr);
    }
    await supabase.from('lab_odoo_changes').insert(Array.from(byOrder.entries()).map(([order_ref, items]) => ({
      order_ref, cancelled: false, items,
      delivery_date: dateByRef.get(order_ref) ?? null, status: 'error',
    })));
  }

  revalidatePath('/dashboard');
  return { applied: applied.length };
}

// Acknowledge sync-error alerts (production card write failures) once handled — e.g. after
// manually running "Generate missing cards" or fixing the underlying data.
export async function resolveSyncErrorsAction(): Promise<{ error?: string }> {
  const { supabase, ok } = await guard();
  if (!ok) return { error: 'Not authorized' };
  await supabase.from('lab_odoo_changes')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('status', 'error');
  revalidatePath('/dashboard');
  return {};
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
