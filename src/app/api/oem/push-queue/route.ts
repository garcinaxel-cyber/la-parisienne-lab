import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooExecute, odooWriteConfigured } from '@/lib/odoo';
import { createAndProduceOemMO, resumeOemMO } from '@/lib/odoo-oem-mo';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;
// never serve a Supabase read from Next's fetch cache here (06/11: a stale 'queued' read re-ran one entry)
export const fetchCache = 'force-no-store';
export const revalidate = 0;

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
    // atomic claim in the database (oldest queued entry, locked, set to 'running' in one statement)
    const { data: claimed, error: cErr } = await sb.rpc('lab_mm_claim_packaging');
    if (cErr) { out.push({ error: cErr.message }); break; }
    const row = (claimed as any[] | null)?.[0];
    if (!row) break;
    // Guard (06/11: one entry got 3 MOs): an MO already made for this entry (same product, origin
    // "OEM <day>", same qty, created in the last 6 h) is re-used, never made twice.
    let moId = row.odoo_mo_id ? Number(row.odoo_mo_id) : null;
    if (!moId) {
      const since = new Date(Date.now() - 6 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
      const twins = await odooExecute<any[]>('mrp.production', 'search_read',
        [[['product_id.default_code', '=', row.sku], ['origin', '=', `OEM ${row.pack_date}`], ['product_qty', '=', Number(row.qty)], ['create_date', '>=', since], ['state', '!=', 'cancel']]],
        { fields: ['id'], limit: 5 }).catch(() => []);
      if (twins.length) {
        const { data: used } = await sb.from('lab_mm_packaging_log').select('odoo_mo_id').in('odoo_mo_id', twins.map(t => t.id));
        const free = twins.find(t => !(used ?? []).some(u => Number(u.odoo_mo_id) === t.id));
        if (free) moId = free.id;
      }
      if (moId) await sb.from('lab_mm_packaging_log').update({ odoo_mo_id: moId }).eq('id', row.id);
    }
    const r = moId ? await resumeOemMO(moId, row.pack_date)
      : await createAndProduceOemMO(row.sku, Number(row.qty), row.pack_date);
    // keep the MO id at once, so a crash right after can never lead to a second MO
    if (!moId && r.moId) await sb.from('lab_mm_packaging_log').update({ odoo_mo_id: r.moId }).eq('id', row.id);
    await sb.from('lab_mm_packaging_log').update({
      odoo_status: r.ok ? 'done' : 'error', odoo_ref: r.moName ?? null, odoo_error: r.ok ? null : (r.error ?? 'Odoo error'),
      ...(r.moId ? { odoo_mo_id: r.moId } : {}),
    }).eq('id', row.id).eq('odoo_status', 'running');
    out.push({ sku: row.sku, date: row.pack_date, ok: r.ok, mo: r.moName, error: r.error });
  }
  const { count } = await sb.from('lab_mm_packaging_log').select('id', { count: 'exact', head: true }).eq('odoo_status', 'queued');
  return NextResponse.json({ ok: true, done: out.length, left: count ?? 0, results: out });
}
