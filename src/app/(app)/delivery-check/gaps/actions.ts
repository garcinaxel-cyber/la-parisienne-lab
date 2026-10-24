'use server';
// Delivery gaps (preview 2026-10-13) — Lab side: assistants + Trish decide the cause of each gap.
// Odoo is simulated only (src/lib/reception-odoo.ts); decisions are stored only once lab_v121 exists.
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revalidatePath, revalidateTag } from 'next/cache';
import { listDeliveryGaps, decideGap, confirmDamagedReturn, orderSendState, sendOrderToOdoo, type DeliveryGap, type GapKind, type LabCause, type OrderSendState } from '@/lib/reception-gaps';
import type { SoFinalizeResult } from '@/lib/reception-odoo';
import { validateShopIn, inValidationLive, type ReceptionPlan, type InValidationResult } from '@/lib/reception-odoo';

function service() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServiceClient(url, key, { auth: { persistSession: false } });
}

// Axel 2026-10-14: settling gaps = assistants too; anything that WRITES to Odoo = lab manager / admin only.
const ODOO_SEND_ROLES = ['admin', 'lab_manager'];

async function requireLabStaff(): Promise<{ name: string; role: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' };
  return { name: profile?.full_name ?? session.user.email ?? 'Lab', role: profile?.role ?? '' };
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

export async function confirmDamagedReturnAction(input: { gapId: string; qty: number }): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const res = await confirmDamagedReturn(sb as any, { ...input, byName: auth.name });
  if (res.ok) revalidatePath('/reception');
  return res;
}

async function inLines(sb: any, deliveryOrderId: string) {
  const { data: header } = await sb.from('lab_delivery_orders').select('id, order_ref, source_type').eq('id', deliveryOrderId).maybeSingle();
  if (!header) return { error: 'Order not found' as const };
  const { data: lines } = await sb.from('lab_delivery_check_lines').select('id, sku, qty_expected, qty_checked').eq('delivery_order_id', deliveryOrderId);
  const { data: recs } = await sb.from('lab_shop_receipt_lines').select('*').eq('delivery_order_id', deliveryOrderId);
  const recByLine = new Map((recs ?? []).map((r: any) => [r.check_line_id, r]));
  const complete = (lines ?? []).length > 0 && (lines ?? []).every((l: any) => recByLine.has(l.id));
  const rows = (lines ?? []).map((l: any) => {
    const r: any = recByLine.get(l.id);
    return { sku: l.sku, sent: Number(l.qty_checked ?? l.qty_expected), received: Number(r?.qty_received ?? 0), damaged: Number(r?.qty_damaged ?? 0) };
  });
  return { header, rows, complete };
}

// Read-only: what Odoo would do to validate the shop IN of this order at the good quantity.
export async function previewInValidationAction(deliveryOrderId: string): Promise<{ result?: InValidationResult; complete?: boolean; live?: boolean; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const d = await inLines(sb, deliveryOrderId);
  if ('error' in d) return { error: d.error };
  const result = await validateShopIn(d.header.order_ref, d.rows, { dryRun: true });
  return { result, complete: d.complete, live: inValidationLive() };
}

// Assistants validate the shop IN of an order that needed a Lab check (Axel, 2026-10-14).
export async function validateInAction(deliveryOrderId: string): Promise<{ result?: InValidationResult; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  if (!ODOO_SEND_ROLES.includes(auth.role)) return { error: 'Only the Lab manager or an admin can validate on Odoo' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const d = await inLines(sb, deliveryOrderId);
  if ('error' in d) return { error: d.error };
  if (d.header.source_type !== 'replenishment') return { error: 'Only REP orders have a shop IN' };
  if (!d.complete) return { error: 'The shop has not confirmed every line yet' };
  const result = await validateShopIn(d.header.order_ref, d.rows);
  await sb.from('lab_reception_odoo_runs').insert({
    delivery_order_id: deliveryOrderId, order_ref: d.header.order_ref, action: 'validate_in',
    mode: result.live ? 'live' : 'simulated', ok: result.ok,
    plan: { picking: result.pickingName ?? null, alreadyDone: !!result.alreadyDone, writes: result.plan, by: 'lab' },
    error: result.error ?? result.skipped ?? null, created_by_name: auth.name,
  });
  return { result };
}

export async function getOrderSendStateAction(deliveryOrderId: string): Promise<{ state?: OrderSendState; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const st = await orderSendState(sb as any, deliveryOrderId);
  return 'error' in st ? { error: st.error } : { state: st };
}

export async function sendOrderToOdooAction(deliveryOrderId: string): Promise<{ result?: SoFinalizeResult; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  if (!ODOO_SEND_ROLES.includes(auth.role)) return { error: 'Only the Lab manager or an admin can send to Odoo' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const res = await sendOrderToOdoo(sb as any, deliveryOrderId, auth.name);
  revalidatePath('/delivery-check/gaps');
  return res;
}

// ── Products received that were on NO slip (Axel, 2026-10-16) ──────────────────────────────────
export type OffslipRow = import('@/lib/offslip').OffslipItem & { suggestions: import('@/lib/offslip').OffslipSuggestion[] };

export async function getOffslipItemsAction(): Promise<{ items?: OffslipRow[]; canSendOdoo?: boolean; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { listOffslipItems, suggestSourceOrders, offslipReady } = await import('@/lib/offslip');
  if (!(await offslipReady(sb as any))) return { items: [], canSendOdoo: ODOO_SEND_ROLES.includes(auth.role) };
  const items = await listOffslipItems(sb as any, { days: 14 });
  const rows: OffslipRow[] = [];
  for (const i of items) rows.push({ ...i, suggestions: i.status === 'open' ? await suggestSourceOrders(sb as any, i) : [] });
  return { items: rows, canSendOdoo: ODOO_SEND_ROLES.includes(auth.role) };
}

export async function settleOffslipAction(input: { id: string; cause: import('@/lib/offslip').OffslipCause; sourceOrderRef: string | null }): Promise<{ ok?: boolean; done?: string[]; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  // Same rule as the other gaps: anything that writes to Odoo = lab manager / admin only.
  if (input.cause !== 'shop_error' && !ODOO_SEND_ROLES.includes(auth.role)) return { error: 'Only the Lab manager or an admin can send to Odoo' };
  if (!['customer_order', 'lab_extra', 'shop_error'].includes(input.cause)) return { error: 'Bad cause' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { settleOffslip } = await import('@/lib/offslip');
  const res = await settleOffslip(sb as any, { id: input.id, cause: input.cause, sourceOrderRef: input.sourceOrderRef?.trim() || null, byName: auth.name });
  revalidatePath('/delivery-check/gaps');
  revalidatePath('/delivery-check');
  return res;
}

// ── Receptions done by the shop but whose IN is still open on Odoo (Axel, 2026-10-20) ──────────
export async function getStuckShopInsAction(): Promise<{ items?: import('@/lib/reception-auto-in').StuckShopIn[]; canRetry?: boolean; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  try {
    const { listStuckShopIns } = await import('@/lib/reception-auto-in');
    return { items: await listStuckShopIns(sb as any), canRetry: ODOO_SEND_ROLES.includes(auth.role) };
  } catch (e: any) { return { error: e?.message ?? String(e) }; }
}

export async function retryShopInAction(deliveryOrderId: string, orderRef: string): Promise<{ outcome?: string; detail?: string; error?: string }> {
  const auth = await requireLabStaff();
  if ('error' in auth) return { error: auth.error };
  if (!ODOO_SEND_ROLES.includes(auth.role)) return { error: 'Only the Lab manager or an admin can send to Odoo' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { autoValidateShopIn } = await import('@/lib/reception-auto-in');
  const r = await autoValidateShopIn(sb as any, deliveryOrderId, orderRef, auth.name);
  revalidatePath('/delivery-check/gaps');
  return r;
}

// Stock recount alert raised at delivery check ("Hết hàng trong kho" on a stock product) —
// the Lab recounts and closes it here (Axel, 2026-10-24). Never touches Odoo stock.
export async function closeRecountAlertAction(id: string, note: string | null): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { error } = await sb.from('lab_stock_recount_alerts').update({
    status: 'done', done_by_name: profile?.full_name ?? null, done_at: new Date().toISOString(), note: note ? note.slice(0, 300) : null,
  }).eq('id', id).eq('status', 'open');
  if (error) return { error: error.message };
  revalidatePath('/delivery-check/gaps');
  return { ok: true };
}

// "Made without order" answer (Axel, 2026-10-24) — see resolveMadeWithoutOrder in delivery-gap.ts.
export async function resolveMadeWithoutOrderAction(input: { date: string; sku: string; qty: number; product: string; choice: 'to_stock' | 'lost' | 'not_made'; photoUrl?: string | null }):
  Promise<{ ok?: boolean; odooStatus?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  if (!['to_stock', 'lost', 'not_made'].includes(input.choice) || !(input.qty > 0)) return { error: 'Invalid input' };
  if (input.choice === 'lost' && !input.photoUrl) return { error: 'Photo required' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { resolveMadeWithoutOrder } = await import('@/lib/delivery-gap');
  try { revalidateTag('delivery-tasks'); } catch {}
  try {
    const { withLock } = await import('@/lib/named-lock');
    const r = await withLock(sb as any, `gap|${input.sku}|${input.date}`, () => resolveMadeWithoutOrder(sb as any, input.date, input.sku, Math.round(input.qty), input.choice,
      { photoUrl: input.photoUrl ?? null, byName: profile?.full_name ?? null, byId: session.user.id, productName: input.product }));
    revalidatePath('/delivery-check/gaps');
    return { ok: true, odooStatus: r.odooStatus, error: r.error };
  } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

export async function retryMadeWithoutOrderAction(date: string, sku: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };
  const sb = service();
  if (!sb) return { error: 'Server not configured' };
  const { retryMadeWithoutOrderOdoo } = await import('@/lib/delivery-gap');
  try { revalidateTag('delivery-tasks'); } catch {}
  try { const { withLock } = await import('@/lib/named-lock'); const r = await withLock(sb as any, `gap|${sku}|${date}`, () => retryMadeWithoutOrderOdoo(sb as any, date, sku)); revalidatePath('/delivery-check/gaps'); return r.error ? { error: r.error } : { ok: true }; }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
}
