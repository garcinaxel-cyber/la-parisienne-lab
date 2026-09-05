import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooWriteConfigured } from '@/lib/odoo';
import { createManagerReplenishment, tomorrowLabDate } from '@/lib/odoo-manager-order';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// 14h00 safety net for the shop manager order draft feature (Axel, 2026-09-05): "laisser la
// possibilité de mettre la commande en draft ... si ils oublient de valider, à partir de 14h
// automatiquement la commande s'envoie". Any staff member can build the draft cart (no PIN,
// see saveManagerOrderDraftAction in src/app/shop/actions.ts); only a manager confirming
// manually, or this job, ever actually sends it to Odoo. Called once daily by pg_cron at 14h00
// VN with ?secret=CRON_SECRET, same pattern as /api/odoo/lock-orders.
//
// Scoped to drafts still in status='draft' for TOMORROW's delivery specifically — that's the
// only delivery date with a real ordering deadline (ORDER_CUTOFF_HOUR in odoo-manager-order.ts);
// a draft for a later date has no deadline and is left alone here no matter how old it is.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !odooWriteConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (ODOO_* / SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const tomorrow = tomorrowLabDate();

  const { data: drafts, error: fetchErr } = await supabase
    .from('lab_shop_manager_order_drafts')
    .select('id, shop_name, delivery_date, delivery_time, lines')
    .eq('status', 'draft')
    .eq('delivery_date', tomorrow);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 502 });

  // A manager never typed a PIN for this one — the audit trail (lab_shop_manager_orders,
  // manager_name NOT NULL) needs something non-null here, so it's attributed to the job itself
  // rather than to any specific person.
  const AUTO_MANAGER_NAME = 'Tự động (14h00)';

  const results: Array<{ id: string; shopName: string; ok: boolean; orderRef?: string; error?: string; skipped?: string }> = [];
  for (const draft of drafts ?? []) {
    const lines = Array.isArray(draft.lines) ? draft.lines : [];
    if (!lines.length) {
      // Nothing was ever added — the draft just quietly expires, no Odoo document created.
      await supabase.from('lab_shop_manager_order_drafts').update({ status: 'cancelled' }).eq('id', draft.id);
      results.push({ id: draft.id, shopName: draft.shop_name, ok: true, skipped: 'empty' });
      continue;
    }
    try {
      // skipWindowCheck=true: this job deliberately fires at/after the 14h00 cutoff on behalf
      // of a manager who left the draft unconfirmed — that's the entire point of it existing.
      const res = await createManagerReplenishment(draft.shop_name, lines, draft.delivery_date, draft.delivery_time ?? undefined, true);
      if (!res.ok || !res.orderRef) {
        await supabase.from('lab_shop_manager_order_drafts').update({ submit_error: res.error ?? 'unknown error' }).eq('id', draft.id);
        results.push({ id: draft.id, shopName: draft.shop_name, ok: false, error: res.error });
        continue;
      }
      await supabase.from('lab_shop_manager_order_drafts').update({
        status: 'submitted', auto_submitted: true, submitted_order_ref: res.orderRef, submitted_at: new Date().toISOString(),
      }).eq('id', draft.id);
      await supabase.from('lab_shop_manager_orders').insert({
        manager_id: null,
        manager_name: AUTO_MANAGER_NAME,
        shop_name: draft.shop_name,
        order_ref: res.orderRef,
        delivery_date: res.deliveryDate,
        delivery_time: res.deliveryTime,
        lines,
        auto_submitted: true,
      });
      results.push({ id: draft.id, shopName: draft.shop_name, ok: true, orderRef: res.orderRef });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await supabase.from('lab_shop_manager_order_drafts').update({ submit_error: msg }).eq('id', draft.id);
      results.push({ id: draft.id, shopName: draft.shop_name, ok: false, error: msg });
    }
  }

  // Surface failures the same way lock-orders does — an auto-submit that silently fails must
  // not just leave a draft sitting there forever with no one told.
  const failures = results.filter(r => !r.ok);
  if (failures.length) {
    await supabase.from('lab_odoo_changes').insert({
      order_ref: `auto-submit-manager-orders:${tomorrow}`,
      cancelled: false,
      items: failures.map(f => ({ sku: f.shopName, name: f.shopName, reason: f.error })),
      delivery_date: tomorrow,
      status: 'error',
    });
  }

  return NextResponse.json({ date: tomorrow, processed: results.length, results });
}
