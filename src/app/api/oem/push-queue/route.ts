import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooWriteConfigured } from '@/lib/odoo';
import { createAndProduceOemMO, resumeOemMO } from '@/lib/odoo-oem-mo';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// OEM packaging queue (Axel, 2026-11-06). 'packed' entries with odoo_status = 'queued' — made
// automatically when an assistant receives a batch, or by a back-fill — become Odoo MOs here,
// oldest production day first (so the average cost builds up in the right order). Each MO is
// dated on its production day (stock + accounting, see odoo-oem-mo.ts). A failure is left as
// 'error' with its message for the existing "retry" button — never retried in a loop.
// Called by pg_cron (job oem-push-queue) with ?secret=CRON_SECRET.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !odooWriteConfigured()) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const { data: on } = await sb.from('lab_mm_settings').select('value').eq('key', 'odoo_mo_enabled').maybeSingle();
  if (on?.value !== 'true') return NextResponse.json({ ok: true, skipped: 'odoo_mo_enabled is off' });

  const t0 = Date.now(); const out: any[] = [];
  while (Date.now() - t0 < 200_000) {
    const { data: next } = await sb.from('lab_mm_packaging_log').select('id')
      .eq('kind', 'packed').eq('odoo_status', 'queued').order('pack_date').order('created_at').limit(1);
    if (!next?.length) break;
    // claim it (a parallel run cannot take the same row)
    const { data: claimed } = await sb.from('lab_mm_packaging_log').update({ odoo_status: 'running' })
      .eq('id', next[0].id).eq('odoo_status', 'queued').select('id, sku, qty, pack_date, odoo_mo_id');
    const row = claimed?.[0];
    if (!row) continue;
    const r = row.odoo_mo_id ? await resumeOemMO(Number(row.odoo_mo_id), row.pack_date)
      : await createAndProduceOemMO(row.sku, Number(row.qty), row.pack_date);
    await sb.from('lab_mm_packaging_log').update({
      odoo_status: r.ok ? 'done' : 'error', odoo_ref: r.moName ?? null, odoo_error: r.ok ? null : (r.error ?? 'Odoo error'),
      ...(r.moId ? { odoo_mo_id: r.moId } : {}),
    }).eq('id', row.id);
    out.push({ sku: row.sku, date: row.pack_date, ok: r.ok, mo: r.moName, error: r.error });
  }
  const { count } = await sb.from('lab_mm_packaging_log').select('id', { count: 'exact', head: true }).eq('odoo_status', 'queued');
  return NextResponse.json({ ok: true, done: out.length, left: count ?? 0, results: out });
}
