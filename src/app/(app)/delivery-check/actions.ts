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

// A weighed raw material (e.g. "Mango" 152-MH.210, tracked in kg) never matches its nominal
// expected qty exactly. There's no unit-of-measure field on the line (Odoo qty is rounded to a
// whole number on import), so a non-integer typed value is treated as the weighed-item signal
// instead — nobody mistypes a count-based product ("4 bánh") as "3.87" by accident. Mirrors the
// client-side gate in DeliveryCheckOrderView.tsx exactly; must stay in sync with it (2026-08-14
// bug: fixing only the client button left this server gate still rejecting the save with
// "Reason required", so OK appeared to do nothing).
function isWeighedEntry(qty: number): boolean {
  return Number.isFinite(qty) && !Number.isInteger(qty);
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
  if (isDiff && !isWeighedEntry(qtyChecked) && !reason) return { error: 'Reason required' };

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

// Hide/show a checked line on the printed delivery slip without touching its tracked data —
// e.g. a wrong SKU an assistant checked to 0 after a mistake, where the real item was re-added
// on Odoo as a separate line; internal tracking keeps the ×0 record, but the client-facing print
// shouldn't show it (Axel, 2026-08-14).
export async function toggleHideFromPrintAction(lineId: string, hidden: boolean): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: line } = await supabase.from('lab_delivery_check_lines')
    .select('delivery_order_id').eq('id', lineId).single();
  if (!line) return { error: 'Line not found' };

  const { error } = await supabase.from('lab_delivery_check_lines')
    .update({ hidden_from_print: hidden, updated_at: new Date().toISOString() }).eq('id', lineId);
  if (error) return { error: error.message };

  const { data: header } = await supabase.from('lab_delivery_orders')
    .select('delivery_date, order_ref').eq('id', line.delivery_order_id).maybeSingle();
  if (header) revalidatePath(`/delivery-check/${header.delivery_date}/${header.order_ref}`);
  revalidatePath('/delivery-check');
  revalidatePath('/delivery-check/category');
  return { ok: true };
}

// Re-open a validated order so a line can be fixed and the order re-validated (Axel,
// 2026-08-14 — assistants had no way back once "Valider" was clicked, short of a DB edit).
// Does NOT clear qty_checked on any line — the previous values stay pre-filled, ready to tweak,
// matching the actual use case (fix one wrong line, not start the whole check over). Same role
// gate as every other delivery-check action; tracked (unlocked_by/at) the same way
// validated_by/printed_by already are on this table.
export async function unlockOrderAction(deliveryOrderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase.from('lab_delivery_orders').update({
    status: 'in_progress',
    unlocked_by: auth.session.user.id,
    unlocked_by_name: auth.profile?.full_name ?? null,
    unlocked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryOrderId);
  if (error) return { error: error.message };
  revalidatePath('/delivery-check');
  revalidatePath('/delivery-check/category');
  return { ok: true };
}

// Called when someone actually clicks "Imprimer" on the print page (not just opens it) — drives
// the "already printed" color-code Axel asked for (2026-08-11) on the index + order views.
export async function markPrintedAction(deliveryOrderId: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { data: current } = await supabase.from('lab_delivery_orders')
    .select('print_count').eq('id', deliveryOrderId).maybeSingle();
  const { error } = await supabase.from('lab_delivery_orders').update({
    printed_at: new Date().toISOString(),
    printed_by: auth.session.user.id,
    printed_by_name: auth.profile?.full_name ?? null,
    print_count: (current?.print_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }).eq('id', deliveryOrderId);
  if (error) return { error: error.message };
  revalidatePath('/delivery-check');
  revalidatePath('/delivery-check/category');
  return { ok: true };
}
