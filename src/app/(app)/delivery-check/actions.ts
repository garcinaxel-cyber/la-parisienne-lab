'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { odooConfigured } from '@/lib/odoo';
import { runAutoOdooSync } from '@/lib/odoo-auto-sync';
import { syncOrderPackagingLines } from '@/lib/odoo-packaging-sync';
import { validateDeliveryOnOdoo, type SplitInput, type DeliveryValidateResult } from '@/lib/odoo-delivery-validate';
import { OTHER_NOTE_MIN } from '@/lib/delivery-check-reasons';
import { computeDayPool, contextFor, followUpLine, type GapContext, type FollowUpResult } from '@/lib/delivery-gap';

function serviceClient() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

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
  // Axel 2026-10-20 (REP/02079): a line changed 1 → 3 six minutes AFTER the order was validated
  // and its Lab OUT pushed to Odoo at 1 — the shop then received 3, Odoo transit went −2. A
  // validated order is locked: unlock first (re-validation re-pushes), and once Odoo holds the OUT
  // any extra goes through the gaps screen ("Lab gửi dư" = LAB → shop transfer).
  const { data: hdr } = await supabase.from('lab_delivery_orders')
    .select('status, odoo_push_status').eq('id', line.delivery_order_id).maybeSingle();
  if (hdr?.odoo_push_status === 'validated' || hdr?.odoo_push_status === 'already_done') {
    return { error: 'Đơn đã xác nhận trên Odoo — không sửa được. Gửi thêm hàng: dùng « Lệch giao hàng » (Lab gửi dư). / Already validated on Odoo — use the gaps screen for extra units.' };
  }
  if (hdr?.status === 'validated') return { error: 'Đơn đã khoá — bấm « Mở khoá » trước khi sửa. / Order locked — unlock it first.' };
  const isDiff = qtyChecked !== line.qty_expected;
  if (isDiff && !isWeighedEntry(qtyChecked) && !reason) return { error: 'Reason required' };
  // "Lý do khác" needs a real explanation (Axel, 2026-10-24: no more silent "other").
  if (isDiff && reason === 'other' && (note ?? '').trim().length < OTHER_NOTE_MIN) return { error: 'Ghi rõ lý do / Explain the reason' };

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

// "Ne sera pas livré" (Axel, 2026-09-18) — une commande REP/SO qu'Odoo force à clôturer
// avec 0 unité livrée (impossible d'y supprimer une commande) restait bloquée avec le badge
// "À valider sur Odoo" pour toujours, alors qu'il n'y a plus rien à valider là-bas. Purement
// app-only et réversible : aucune écriture Odoo, n'affecte ni odoo_push_status ni aucun
// calcul de réconciliation/KPI — seulement l'affichage de cette page. toggle=false annule.
export async function setMarkedNotDeliveredAction(deliveryOrderId: string, marked: boolean): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  const { error } = await supabase.from('lab_delivery_orders').update({
    marked_not_delivered: marked,
    marked_not_delivered_at: marked ? new Date().toISOString() : null,
    marked_not_delivered_by_name: marked ? (auth.profile?.full_name ?? null) : null,
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

// On-demand "Sync Odoo" for delivery-check specifically (Axel, 2026-08-16: "si les assistantes
// voient pas un produit directement elles peuvent synchro" — REP/2026/01049's VTTH113/VTTH085
// packaging lines were invisible until the next cron tick because of the one-shot-forever guard
// in odoo-packaging-sync.ts; see that file's 2026-08-16 fix comment). Mirrors station/[team]
// actions.ts's syncOdooAction (same runAutoOdooSync call, any logged-in assistant/admin can
// trigger it), but ALSO runs syncOrderPackagingLines — the station button never did, only the
// cron route did, which is exactly why re-syncing from the station page alone wouldn't have
// surfaced a missing packaging line either. Revalidates every delivery-check path so a stale RSC
// snapshot doesn't hide the newly-synced line even after a successful sync (same bug class as
// checkLineAction's own revalidation, 2026-08-11).
function labUpcomingDatesVN(days: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(now.getTime() + i * 24 * 3600 * 1000)));
}

export async function syncOdooForDeliveryCheckAction(
  orderDate?: string, orderRef?: string,
): Promise<{ ok?: boolean; createdImports?: number; changesApplied?: number; packagingSynced?: number; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };

  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Odoo sync not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  try {
    // BUG FIX 2026-08-17 (REP/2026/01076): runAutoOdooSync silently no-ops (ok, zero counts, no
    // error) when the cron/another click already holds the 2-min sync lock — before this fix that
    // looked identical to a real "nothing changed" success. One retry after a short wait covers
    // the common case (cron runs are seconds long, not the full 2-min expiry); if it's still
    // locked after that, say so explicitly instead of a misleading "Synchronisé".
    let result = await runAutoOdooSync(service as any);
    if (result.skipped_concurrent) {
      await new Promise(r => setTimeout(r, 4000));
      result = await runAutoOdooSync(service as any);
    }
    if (result.error) return { error: result.error };
    if (result.skipped_concurrent) return { error: 'Đang có một lượt đồng bộ khác chạy, vui lòng thử lại sau một phút' };

    let packagingSynced = (result.packaging_only_synced ?? 0);
    try {
      const pkg = await syncOrderPackagingLines(service as any, labUpcomingDatesVN(3));
      packagingSynced += pkg.lines_synced ?? 0;
    } catch { /* best-effort, same as the cron route — never fail the sync over this */ }

    if (orderDate && orderRef) revalidatePath(`/delivery-check/${orderDate}/${orderRef}`);
    revalidatePath('/delivery-check');
    revalidatePath('/delivery-check/category');
    if (result.packaging_only_error) return { error: `Đồng bộ một phần: ${result.packaging_only_error}` };
    return { ok: true, createdImports: result.created_imports, changesApplied: result.changes_applied, packagingSynced };
  } catch (e: any) {
    return { error: e?.message ?? 'Odoo sync failed' };
  }
}

// "Valider la livraison sur Odoo" (Axel, 2026-08-17) — writes delivered quantities back onto
// Odoo's stock.move lines and validates the picking. REP orders only for this pilot phase (see
// odoo-delivery-validate.ts's own doc comment for the full design). Called twice from the UI for
// a real (non-dry-run) validation: once with dryRun=true to preview + surface any needsSplit
// requirement, then again with dryRun=false once the assistant has confirmed (and provided any
// required splits) — never a single blind write.
export async function validateDeliveryOnOdooAction(
  deliveryOrderId: string, dryRun: boolean, splits: SplitInput[] = [],
): Promise<DeliveryValidateResult> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { ok: false, dryRun, error: auth.error };

  const { data: header } = await supabase.from('lab_delivery_orders')
    .select('order_ref, source_type, delivery_date, status').eq('id', deliveryOrderId).maybeSingle();
  if (!header) return { ok: false, dryRun, error: 'Commande introuvable' };
  // The checklist itself must already be fully checked + validated (existing "Valider" button) —
  // that's what guarantees every line below has a real qty_checked, not a half-finished count.
  if (header.status !== 'validated') return { ok: false, dryRun, error: "La fiche de vérification doit d'abord être validée (bouton \"Valider\")" };

  const { data: lines } = await supabase.from('lab_delivery_check_lines')
    .select('sku, product_name_vi, qty_checked, qty_expected').eq('delivery_order_id', deliveryOrderId);
  // Ghost 0/0 lines (Axel, 2026-08-18, REP/2026/01069 "BBF"/"BBB") — same root cause as the
  // page.tsx gt('qty', 0) filter and the odoo-apply.ts qty-change collapse: Odoo dropped its
  // demand for that SKU to 0 (order edited/cancelled after the checklist line was first
  // materialized) but the row itself is never deleted, so it sits forever at qty_expected=0,
  // qty_checked=0 — never actually checked, just a leftover. Odoo genuinely has no live move for
  // a 0-demand product, so pushing this line always fails with "produit introuvable". A real
  // shortfall (qty_expected > 0, assistant checked 0 because it was actually out of stock) still
  // goes through untouched — only the true both-zero ghost rows are skipped.
  const checklistLines = (lines ?? [])
    .filter((l: any) => l.sku && l.qty_checked != null && !(Number(l.qty_expected) === 0 && Number(l.qty_checked) === 0))
    .map((l: any) => ({ sku: l.sku as string, product_name_vi: l.product_name_vi as string, qty_checked: Number(l.qty_checked), qty_expected: Number(l.qty_expected) }));

  const result = await validateDeliveryOnOdoo(
    supabase as any, header.order_ref, header.source_type, checklistLines, dryRun, splits,
  );

  // Only persist an outcome for a REAL attempt (not a dry-run preview, and not a needsSplit
  // pause — neither of those is a final state worth recording).
  if (!dryRun && !result.needsSplit) {
    const patch: Record<string, any> = { updated_at: new Date().toISOString() };
    if (result.ok) {
      patch.odoo_push_status = result.alreadyDoneOnOdoo ? 'already_done' : 'validated';
      patch.odoo_push_error = null;
      patch.odoo_picking_ids = result.pickingId ? [result.pickingId] : null;
      patch.odoo_validated_at = new Date().toISOString();
      patch.odoo_validated_by = auth.session.user.id;
      patch.odoo_validated_by_name = auth.profile?.full_name ?? null;
    } else {
      patch.odoo_push_status = 'error';
      patch.odoo_push_error = result.error ?? 'Erreur inconnue';
    }
    await supabase.from('lab_delivery_orders').update(patch).eq('id', deliveryOrderId);
    // The shop may have finished its reception before the Lab's OUT existed (2026-10-20,
    // REP/02089): validate its IN now that there is something in transit. No-op otherwise.
    if (result.ok && header.source_type === 'replenishment') {
      try {
        const { autoValidateShopIn } = await import('@/lib/reception-auto-in');
        await autoValidateShopIn(supabase as any, deliveryOrderId, header.order_ref, auth.profile?.full_name ?? 'Lab');
      } catch (e) { console.error('autoValidateShopIn after OUT failed:', e); }
    }
    // Point 3 (Axel, 2026-09-02) — permanent push journal: odoo_push_error above is overwritten
    // by the next successful attempt, so failures (and auto-created missing lines) would vanish
    // from history. This log is append-only and never rewritten. Best-effort: a log failure
    // must never fail the push itself.
    const { error: logErr } = await supabase.from('lab_delivery_push_log').insert({
      delivery_order_id: deliveryOrderId,
      order_ref: header.order_ref,
      source_type: header.source_type,
      ok: result.ok,
      error: result.error ?? null,
      plan: result.plan ?? null,
      created_moves: result.createdMoves ?? null,
      backorder_warning: result.backorderWarning ?? null,
      by_name: auth.profile?.full_name ?? null,
    });
    if (logErr) console.error('[delivery-validate] push log insert failed:', logErr.message);
    revalidatePath(`/delivery-check/${header.delivery_date}/${header.order_ref}`);
    revalidatePath('/delivery-check');
    revalidatePath('/delivery-check/category');
  }

  return result;
}


// ── Gap barriers (Axel, 2026-10-24) ─────────────────────────────────────────────────────────
// What the assistant sees when the quantity she checks ≠ the order: the day's figures for this
// product (all orders) and which question to ask. Read-only.
export async function getGapContextAction(lineId: string, qty: number): Promise<{ ctx?: GapContext; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const sb = serviceClient() ?? supabase;
  const { data: line } = await sb.from('lab_delivery_check_lines')
    .select('delivery_date, sku, product_category, category, qty_expected').eq('id', lineId).maybeSingle();
  if (!line) return { error: 'Line not found' };
  if (!line.sku) return { ctx: { family: line.category === 'packaging' ? 'packaging' : 'mto', dir: qty < Number(line.qty_expected) ? 'short' : 'over', diff: Math.abs(qty - Number(line.qty_expected)), made: 0, sent: 0, otherLeft: 0, lost: 0, thisQty: qty, expected: Number(line.qty_expected), autoNotMade: false, autoNote: null, madeCovers: false } };
  const { pool } = await computeDayPool(sb, line.delivery_date, line.sku, lineId, line.product_category, line.category);
  return { ctx: contextFor(pool, Number(line.qty_expected), qty) };
}

// Called right after a line is saved, without making the assistant wait: recount alert, card
// correction, forgotten transfer, Lab scrap, Odoo production up/down. Result kept on the line.
export async function followUpLineAction(lineId: string, photoUrl?: string | null): Promise<{ ok?: boolean; result?: FollowUpResult; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const sb = serviceClient();
  if (!sb) return { error: 'Server not configured' };
  try {
    const result = await followUpLine(sb, lineId, { photoUrl: photoUrl ?? null, byName: auth.profile?.full_name ?? null, byId: auth.session.user.id });
    return { ok: true, result };
  } catch (e: any) {
    await sb.from('lab_delivery_check_lines').update({ resolution_odoo_status: 'error', resolution_odoo_error: String(e?.message ?? e).slice(0, 300) }).eq('id', lineId);
    return { error: String(e?.message ?? e) };
  }
}

// Photo of a broken product (delivery check or Lab scrap tab).
export async function uploadLossPhotoAction(formData: FormData): Promise<{ url?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireProfile(supabase);
  if ('error' in auth) return { error: auth.error };
  const sb = serviceClient();
  if (!sb) return { error: 'Server not configured' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images' };
  if (file.size > 8 * 1024 * 1024) return { error: 'Image too large (max 8MB)' };
  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const path = `lab-loss/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('lab-design-photos').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (error) return { error: error.message };
  return { url: sb.storage.from('lab-design-photos').getPublicUrl(path).data.publicUrl };
}
