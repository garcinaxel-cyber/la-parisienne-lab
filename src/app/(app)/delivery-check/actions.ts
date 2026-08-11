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

export async function checkLineAction(
  lineId: string, qtyChecked: number, reason: string | null, note: string | null,
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: line } = await supabase.from('lab_delivery_check_lines')
    .select('qty_expected, delivery_order_id').eq('id', lineId).single();
  if (!line) return { error: 'Line not found' };
  const isDiff = qtyChecked !== line.qty_expected;
  if (isDiff && !reason) return { error: 'Reason required' };

  const { error } = await supabase.from('lab_delivery_check_lines').update({
    qty_checked: qtyChecked,
    status: isDiff ? 'adjusted' : 'ok',
    discrepancy_reason: isDiff ? reason : null,
    discrepancy_note: isDiff ? (note || null) : null,
    checked_by: auth.session.user.id,
    checked_by_name: auth.profile?.full_name ?? null,
    checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', lineId);
  if (error) return { error: error.message };

  // Invalidate the client Router Cache for this order's own page + the index/category lists.
  // Without this, checking a line here never told Next.js the page was stale, so navigating
  // back to the order (or to the list showing X/Y progress) served the RSC snapshot from
  // before the check — the checkmark appeared to "disappear" even though it was saved fine
  // in lab_delivery_check_lines all along (2026-08-11 bug report).
  const { data: header } = await supabase.from('lab_delivery_orders')
    .select('delivery_date, order_ref').eq('id', line.delivery_order_id).maybeSingle();
  if (header) revalidatePath(`/delivery-check/${header.delivery_date}/${header.order_ref}`);
  revalidatePath('/delivery-check');
  revalidatePath('/delivery-check/category');

  return { ok: true };
}

// Odoo write-back (stock.move.quantity + validate picking) lands in a later step, gated on
// the write account getting Create+Write on stock.picking/stock.move. For now "Valider"
// locks the order once every line is checked, and records that it's ready to push.
export async function validateOrderAction(deliveryOrderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: lines } = await supabase.from('lab_delivery_check_lines')
    .select('id, qty_checked').eq('delivery_order_id', deliveryOrderId);
  if (!lines?.length) return { error: 'No lines to validate' };
  if (lines.some(l => l.qty_checked == null)) return { error: 'All lines must be checked first' };

  const { error } = await supabase.from('lab_delivery_orders').update({
    status: 'validated',
    validated_by: auth.session.user.id,
    validated_by_name: auth.profile?.full_name ?? null,
    validated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryOrderId);
  if (error) return { error: error.message };
  revalidatePath('/delivery-check');
  revalidatePath('/delivery-check/category');
  return { ok: true };
}
