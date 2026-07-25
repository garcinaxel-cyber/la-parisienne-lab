import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooExecuteWrite, odooConfigured, odooWriteConfigured } from '@/lib/odoo';
import { fetchDoneForProdDate, aggregateBySku } from '@/lib/production-days';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Create the day's production as DRAFT Manufacturing Orders in Odoo, from what was physically
// produced that day (produced_at). Reads with the readonly key, writes with the dedicated
// ODOO_WRITE_* account. Dry-run by default (?commit=1 writes). Idempotent: every MO is tagged
// origin = "Lab {date}"; products already tagged for the day are skipped, so re-running is safe.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 500 });

  const url = new URL(req.url);
  const commit = url.searchParams.get('commit') === '1';
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
  const origin = `Lab ${date}`;

  if (commit && !odooWriteConfigured())
    return NextResponse.json({ error: 'ODOO_WRITE_* not configured — cannot create MOs' }, { status: 500 });

  // 1) What was produced that day → per-SKU quantity
  const done = await fetchDoneForProdDate(supabase, date);
  const vids = Array.from(new Set(done.map(c => c.variant_id).filter(Boolean))) as string[];
  const { data: variants } = vids.length
    ? await supabase.from('lab_fiche_variants').select('id, sku').in('id', vids)
    : { data: [] as any[] };
  const skuByV: Record<string, string> = {};
  for (const v of variants ?? []) if (v.sku) skuByV[v.id] = v.sku;
  const agg = aggregateBySku(done, skuByV);
  const rows = Array.from(agg.values()).filter(r => r.qty > 0);

  // 2) Resolve SKUs → Odoo product (id, uom, template) + a BoM — READ ONLY
  const skus = rows.map(r => r.sku).filter(Boolean) as string[];
  const prods = skus.length
    ? await tmo(odooExecute<any[]>('product.product', 'search_read',
        [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code', 'uom_id', 'product_tmpl_id'], limit: 2000 }), 30000, 'prods')
    : [];
  const prodBySku: Record<string, any> = {};
  const tmplByProd: Record<number, number> = {};
  for (const p of prods) if (p.default_code) {
    prodBySku[p.default_code] = p;
    tmplByProd[p.id] = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
  }
  const prodIds = Object.values(prodBySku).map((p: any) => p.id);
  const tmplIds = Array.from(new Set(Object.values(tmplByProd)));
  const boms = (prodIds.length || tmplIds.length)
    ? await tmo(odooExecute<any[]>('mrp.bom', 'search_read',
        [['|', ['product_id', 'in', prodIds], ['product_tmpl_id', 'in', tmplIds]]],
        { fields: ['id', 'product_id', 'product_tmpl_id'], limit: 5000 }), 30000, 'boms')
    : [];
  const bomByProd: Record<number, number> = {};
  const bomByTmpl: Record<number, number> = {};
  for (const b of boms) {
    const pid = Array.isArray(b.product_id) ? b.product_id[0] : (b.product_id || null);
    const tid = Array.isArray(b.product_tmpl_id) ? b.product_tmpl_id[0] : (b.product_tmpl_id || null);
    if (pid) bomByProd[pid] = b.id; else if (tid) bomByTmpl[tid] = b.id;
  }
  const bomFor = (p: any) => bomByProd[p.id] ?? bomByTmpl[tmplByProd[p.id]] ?? null;

  // 3) Existing MOs for this day (origin tag), excluding cancelled ones (so a product can be
  // recreated after cancelling its draft). Keyed by product → { id, qty, state, name }. A DRAFT MO
  // whose qty is now out of date is UPDATED (export mid-day, then more is produced → resync).
  const existing = await tmo(odooExecute<any[]>('mrp.production', 'search_read',
    [[['origin', '=', origin], ['state', '!=', 'cancel']]], { fields: ['id', 'product_id', 'product_qty', 'state', 'name'] }), 20000, 'existing');
  const existingByProd: Record<number, { id: number; qty: number; state: string; name: string }> = {};
  for (const m of existing.sort((a: any, z: any) => a.id - z.id)) {
    const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
    if (pid) existingByProd[pid] = { id: m.id, qty: m.product_qty, state: m.state, name: m.name };
  }

  // 3b) The MO date must reflect the PRODUCTION day (not the export/creation day). Discover the
  // start-date field (Odoo 17+ = date_start; older = date_planned_start) so we only set one that
  // exists, then use the lab day at ~09:00 VN (02:00 UTC) — safely inside that calendar day.
  let moDateField: string | null = null;
  try {
    const fg = await tmo(odooExecute<any>('mrp.production', 'fields_get',
      [['date_start', 'date_planned_start']], { attributes: ['type'] }), 15000, 'fg');
    moDateField = fg?.date_start ? 'date_start' : (fg?.date_planned_start ? 'date_planned_start' : null);
  } catch { moDateField = null; }
  const moDate = `${date} 02:00:00`;

  // 4) Build the plan: create new, update out-of-date DRAFT MOs, skip up-to-date / confirmed.
  const toCreate: any[] = [];
  const toUpdate: any[] = [];
  const skipped: any[] = [];
  const noProduct: any[] = [];
  for (const r of rows) {
    const p = r.sku ? prodBySku[r.sku] : null;
    if (!p) { noProduct.push({ sku: r.sku, name: r.appName, qty: r.qty }); continue; }
    const ex = existingByProd[p.id];
    if (ex) {
      if (ex.state !== 'draft') { skipped.push({ sku: r.sku, product: p.name, qty: r.qty, mo: ex.name, reason: 'already confirmed in Odoo — not modified' }); continue; }
      if (ex.qty === r.qty) { skipped.push({ sku: r.sku, product: p.name, qty: r.qty, mo: ex.name, reason: 'up to date' }); continue; }
      toUpdate.push({ id: ex.id, mo: ex.name, sku: r.sku, product: p.name, from: ex.qty, to: r.qty });
      continue;
    }
    toCreate.push({
      sku: r.sku, product: p.name, qty: r.qty,
      values: {
        product_id: p.id, product_qty: r.qty,
        product_uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id,
        origin,
        ...(bomFor(p) ? { bom_id: bomFor(p) } : {}),
        ...(moDateField ? { [moDateField]: moDate } : {}),
      },
    });
  }

  const summary = { date, origin, produced_products: rows.length, to_create: toCreate.length, to_update: toUpdate.length, unchanged: skipped.length, no_odoo_product: noProduct.length };
  if (!commit) {
    return NextResponse.json({ dryRun: true, summary, toCreate: toCreate.map(({ values, ...r }) => r), toUpdate, skipped, noProduct });
  }

  // 5) Create new MOs + update out-of-date drafts, one by one (one failure doesn't block the rest)
  const created: any[] = [];
  const updated: any[] = [];
  const errors: any[] = [];
  for (const item of toCreate) {
    try {
      const id = await tmo(odooExecuteWrite<number>('mrp.production', 'create', [item.values]), 25000, 'create');
      const [mo] = await tmo(odooExecuteWrite<any[]>('mrp.production', 'read', [[id]], { fields: ['name'] }), 15000, 'read');
      created.push({ sku: item.sku, product: item.product, qty: item.qty, mo: mo?.name, id });
    } catch (e: any) {
      errors.push({ sku: item.sku, product: item.product, error: String(e?.message ?? e) });
    }
  }
  for (const item of toUpdate) {
    try {
      await tmo(odooExecuteWrite<boolean>('mrp.production', 'write', [[item.id], { product_qty: item.to }]), 25000, 'update');
      updated.push({ sku: item.sku, product: item.product, mo: item.mo, from: item.from, to: item.to });
    } catch (e: any) {
      errors.push({ sku: item.sku, product: item.product, error: `update ${item.mo}: ${String(e?.message ?? e)}` });
    }
  }
  return NextResponse.json({ committed: true, summary: { ...summary, created: created.length, updated: updated.length, errors: errors.length }, created, updated, skipped, noProduct, errors });
}
