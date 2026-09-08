'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

async function guard() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { supabase, ok: false, userId: null as string | null, name: null as string | null };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  return {
    supabase,
    ok: ['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? ''),
    userId: session.user.id,
    name: profile?.full_name ?? null,
  };
}

export interface ReceiveLineInput {
  lineId: string;
  qtyReceived: number;
  reason?: string | null;   // required when qtyReceived <> qty_sent
  note?: string | null;
}

// Assistant confirms a transfer note: records received qty (+ discrepancy reason) per line,
// then marks the whole note received. Does not touch stock levels yet.
export async function receiveStockTransferAction(
  transferId: string,
  lines: ReceiveLineInput[],
): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, ok, userId, name } = await guard();
  if (!ok) return { error: 'Not authorized' };

  // Load sent quantities to enforce "reason required on discrepancy"
  const { data: existing } = await supabase
    .from('lab_stock_transfer_lines').select('id, qty_sent').eq('transfer_id', transferId);
  const sentById: Record<string, number> = {};
  for (const l of existing ?? []) sentById[l.id] = l.qty_sent ?? 0;

  for (const l of lines) {
    const qty = Math.round(l.qtyReceived);
    const isDiscrepancy = qty !== (sentById[l.lineId] ?? qty);
    if (isDiscrepancy && !(l.reason && l.reason.trim())) {
      return { error: 'A reason is required for every discrepancy' };
    }
    await supabase.from('lab_stock_transfer_lines').update({
      qty_received: qty,
      discrepancy_reason: isDiscrepancy ? l.reason : null,
      discrepancy_note: isDiscrepancy ? (l.note ?? null) : null,
    }).eq('id', l.lineId);
  }

  const { error } = await supabase.from('lab_stock_transfers').update({
    status: 'received', received_by: userId, received_by_name: name, received_at: new Date().toISOString(),
  }).eq('id', transferId);
  if (error) return { error: error.message };

  revalidatePath('/reception');
  revalidatePath('/dashboard');
  return { ok: true };
}

// Validate ONE line of a transfer. When it was the last un-received line, the whole
// note auto-closes (status = received). Lets assistants receive product by product.
export async function receiveTransferLineAction(
  transferId: string, lineId: string, qtyReceived: number, reason?: string | null, note?: string | null,
): Promise<{ ok?: boolean; closed?: boolean; error?: string }> {
  const { supabase, ok, userId, name } = await guard();
  if (!ok) return { error: 'Not authorized' };

  const { data: line } = await supabase
    .from('lab_stock_transfer_lines').select('qty_sent').eq('id', lineId).single();
  const sent = line?.qty_sent ?? qtyReceived;
  const qty = Math.round(qtyReceived);
  const isDiscrepancy = qty !== sent;
  if (isDiscrepancy && !(reason && reason.trim())) return { error: 'A reason is required for a discrepancy' };

  await supabase.from('lab_stock_transfer_lines').update({
    qty_received: qty,
    discrepancy_reason: isDiscrepancy ? reason : null,
    discrepancy_note: isDiscrepancy ? (note ?? null) : null,
  }).eq('id', lineId);

  const { data: remaining } = await supabase
    .from('lab_stock_transfer_lines').select('id').eq('transfer_id', transferId).is('qty_received', null);
  let closed = false;
  if (!remaining || remaining.length === 0) {
    await supabase.from('lab_stock_transfers').update({
      status: 'received', received_by: userId, received_by_name: name, received_at: new Date().toISOString(),
    }).eq('id', transferId);
    closed = true;
  }
  revalidatePath('/reception');
  revalidatePath('/dashboard');
  return { ok: true, closed };
}

// Void a transfer note that hasn't been touched yet (still fully "pending" — nothing received
// or reconciled against it). Added 2026-09-08 after a real duplicate note ("Phiếu #8EE131" /
// "#D6B25B") had no way to be cancelled in the app once created — Axel had to fix Odoo by hand.
// Also un-flags the source production cards so the same stock can be sent again correctly, and
// excludes the note from syncStockToOdoo's totals (see lab/odoo-mo-sync.ts) going forward.
export async function cancelStockTransferAction(
  transferId: string,
): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, ok, name } = await guard();
  if (!ok) return { error: 'Not authorized' };

  const { data: t } = await supabase.from('lab_stock_transfers').select('id, status').eq('id', transferId).maybeSingle();
  if (!t) return { error: 'Transfer note not found' };
  if (t.status !== 'pending') {
    return { error: t.status === 'received' ? 'Already received — cannot cancel' : 'Already cancelled' };
  }

  const { data: lines } = await supabase.from('lab_stock_transfer_lines')
    .select('assignment_id, qty_sent').eq('transfer_id', transferId);

  const { error } = await supabase.from('lab_stock_transfers')
    .update({ status: 'cancelled', cancelled_by_name: name, cancelled_at: new Date().toISOString() })
    .eq('id', transferId);
  if (error) return { error: error.message };

  // Roll back qty_sent_total on every card this note touched, so the real remaining quantity
  // becomes sendable again instead of looking already-covered forever.
  for (const l of lines ?? []) {
    if (!l.assignment_id) continue;
    const { data: card } = await supabase.from('lab_assignments')
      .select('qty_sent_total').eq('id', l.assignment_id).maybeSingle();
    const newTotal = Math.max(0, (card?.qty_sent_total ?? 0) - (l.qty_sent ?? 0));
    await supabase.from('lab_assignments').update({ qty_sent_total: newTotal, transferred: false }).eq('id', l.assignment_id);
  }

  revalidatePath('/reception');
  revalidatePath('/dashboard');
  return { ok: true };
}
