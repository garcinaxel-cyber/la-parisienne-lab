import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooWriteConfigured } from '@/lib/odoo';
import { createOdooOrderForBatch } from '@/lib/odoo-shop-order-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Drains lab_odoo_sync_queue — one urgent shop order at a time, in arrival order (oldest
// pending first). Called every few minutes by pg_cron / external scheduler with
// ?secret=CRON_SECRET (same pattern as /api/odoo/cron). Processing is SEQUENTIAL (awaited
// one row after another, never Promise.all) so two urgent orders arriving close together
// never race each other creating Odoo documents at the same time.
// The production card was already created at submission time (existing flow) — this only
// creates the matching Odoo document (draft quotation or replenishment) for the record.
// A failure here never removes visibility for the chef; the row just stays 'error' and
// surfaces in the /exceptional-orders warning banner for manual follow-up.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooWriteConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (ODOO_WRITE_* / SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: pending, error: pendingErr, count: pendingCount, status: pendingStatus, statusText: pendingStatusText } = await supabase
    .from('lab_odoo_sync_queue')
    .select('id, order_batch_id, shop_name, doc_type', { count: 'exact' })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);

  const results: { id: string; ok: boolean; order_ref?: string; error?: string }[] = [];

  for (const row of pending ?? []) {
    // Claim it atomically (pending -> processing, only if still pending) so a second
    // overlapping invocation of this same cron never double-processes the same row.
    const { data: claimed } = await supabase
      .from('lab_odoo_sync_queue')
      .update({ status: 'processing' })
      .eq('id', row.id).eq('status', 'pending')
      .select('id').maybeSingle();
    if (!claimed) continue; // already picked up by another concurrent run

    // Need the delivery date / ready time — pull from the batch's manual cake rows.
    const { data: mc } = await supabase.from('lab_manual_cakes')
      .select('delivery_date, ready_time').eq('order_batch_id', row.order_batch_id).limit(1).maybeSingle();

    const res = await createOdooOrderForBatch(supabase as any, {
      orderBatchId: row.order_batch_id, shopName: row.shop_name, docType: row.doc_type as any,
      deliveryDate: mc?.delivery_date ?? new Date().toISOString().split('T')[0],
      readyTime: mc?.ready_time ?? null,
    });

    if (res.ok) {
      await supabase.from('lab_odoo_sync_queue')
        .update({ status: 'done', order_ref: res.order_ref ?? null, processed_at: new Date().toISOString() })
        .eq('id', row.id);
    } else {
      await supabase.from('lab_odoo_sync_queue')
        .update({ status: 'error', error: res.error ?? 'Unknown error', processed_at: new Date().toISOString() })
        .eq('id', row.id);
    }
    results.push({ id: row.id, ok: res.ok, order_ref: res.order_ref, error: res.error });
  }

  return NextResponse.json({
    processed: results.length, results,
    _debug: {
      pendingErr: pendingErr ? JSON.stringify(pendingErr) : null,
      pendingCount, pendingLen: pending?.length ?? 0,
      pendingStatus, pendingStatusText,
      hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      vercelRegion: process.env.VERCEL_REGION ?? null,
      now: new Date().toISOString(),
    },
  });
}
