'use server';
// Delivery gaps (preview 2026-10-13) — Lab side: assistants + Trish decide the cause of each gap.
// Odoo is simulated only (src/lib/reception-odoo.ts); decisions are stored only once lab_v121 exists.
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { listDeliveryGaps, decideGap, confirmDamagedReturn, type DeliveryGap, type GapKind, type LabCause } from '@/lib/reception-gaps';
import { planInValidation, type ReceptionPlan } from '@/lib/reception-odoo';

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, { auth: { persistSession: false } });
}

async function requireLabStaff(): Promise<{ name: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' };
  return { name: profile?.full_name ?? session.user.email ?? 'Lab' };
}

export async function getDeliveryGapsAction(): Promise<{ gaps?: DeliveryGap[]; schemaReady?: boolean; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  return listDeliveryGaps(sb as any);
}

export async function decideGapAction(input: { checkLineId: string; kind: GapKind; cause: LabCause; message: string | null }): Promise<{ ok?: boolean; plan?: ReceptionPlan; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const res = await decideGap(sb as any, { ...input, byName: auth.name });
  if (res.ok) revalidatePath('/delivery-check/gaps');
  return res;
}

export async function confirmDamagedReturnAction(input: { gapId: string; qty: number }): Promise<{ ok?: boolean; plan?: ReceptionPlan; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const res = await confirmDamagedReturn(sb as any, { ...input, byName: auth.name });
  if (res.ok) revalidatePath('/reception');
  return res;
}

// Read-only: what Odoo WOULD do to validate the shop IN of this order at the good quantity.
export async function previewInValidationAction(deliveryOrderId: string): Promise<{ plan?: ReceptionPlan; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { data: header } = await sb.from('lab_delivery_orders').select('id, order_ref').eq('id', deliveryOrderId).maybeSingle();
  if (!header) return { error: 'Order not found' };
  const { data: lines } = await sb.from('lab_delivery_check_lines').select('id, sku, product_name_vi, qty_expected, qty_checked').eq('delivery_order_id', deliveryOrderId);
  const { data: recs } = await sb.from('lab_shop_receipt_lines').select('*').eq('delivery_order_id', deliveryOrderId);
  const recByLine = new Map((recs ?? []).map((r: any) => [r.check_line_id, r]));
  const plan = await planInValidation(header.order_ref, (lines ?? []).map((l: any) => {
    const r: any = recByLine.get(l.id);
    return { sku: l.sku, product: l.product_name_vi, sent: Number(l.qty_checked ?? l.qty_expected), received: Number(r?.qty_received ?? 0), damaged: Number(r?.qty_damaged ?? 0) };
  }));
  return { plan };
}
