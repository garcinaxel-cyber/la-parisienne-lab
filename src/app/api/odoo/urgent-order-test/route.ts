import { NextResponse } from 'next/server';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// TEMPORARY — validates the exact write shape used by createOdooOrderForBatch (draft
// sale.order + line for partner LAB, and draft stock.replenishment.request + line for
// warehouse LP) against a REAL existing product, with qty=1. Nothing is confirmed.
// To be deleted right after a human checks the two created drafts in Odoo and removes them.
export async function GET(req: Request) {
  if (!odooWriteConfigured()) return NextResponse.json({ error: 'not configured' }, { status: 503 });
  const url = new URL(req.url);

  // ?cleanup=repl:857 or ?cleanup=so:3046 — delete a specific test record by model:id,
  // since the Odoo UI's "My Quotations" filter hides records created by the API user and
  // there's no easy UI path to stock.replenishment.request records.
  const cleanup = url.searchParams.get('cleanup');
  if (cleanup) {
    const [kind, idStr] = cleanup.split(':');
    const id = Number(idStr);
    if (!id) return NextResponse.json({ error: 'bad cleanup param' }, { status: 400 });
    const model = kind === 'repl' ? 'stock.replenishment.request' : kind === 'so' ? 'sale.order' : null;
    if (!model) return NextResponse.json({ error: 'unknown kind' }, { status: 400 });
    try {
      await odooExecuteWrite(model, 'unlink', [[id]]);
      return NextResponse.json({ ok: true, deleted: `${model}#${id}` });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
    }
  }

  const sku = url.searchParams.get('sku');
  if (!sku) return NextResponse.json({ error: 'missing ?sku=' }, { status: 400 });

  const out: any = {};
  try {
    const prods = await odooExecute<any[]>('product.product', 'search_read',
      [[['default_code', '=', sku]]], { fields: ['id', 'uom_id', 'name'], limit: 1 });
    const p = prods[0];
    if (!p) return NextResponse.json({ error: `sku ${sku} not found` }, { status: 404 });
    out.product = { id: p.id, name: p.name };

    // ── Quotation: partner LAB ──
    // Exact '=' match on name came back empty even though the UI shows "LAB" (checked
    // 07-28) — ilike + JS filter confirmed res.partner id 347 is the real record.
    const partners = await odooExecute<any[]>('res.partner', 'search_read', [[['name', 'ilike', 'LAB']]], { fields: ['id', 'name'], limit: 20 });
    const labPartner = partners.find((p: any) => String(p.name ?? '').trim().toLowerCase() === 'lab');
    if (!labPartner) return NextResponse.json({ error: 'partner LAB not found', candidates: partners }, { status: 404 });
    // Discover the real UoM field name on sale.order.line for this Odoo version instead
    // of guessing (bit us once already: 'product_uom_id' doesn't exist here).
    const solFields = await odooExecute<any>('sale.order.line', 'fields_get', [[]], { attributes: ['type'] });
    const uomField = ['product_uom_id', 'product_uom'].find(f => solFields[f]) ?? null;
    out.uomFieldUsed = uomField;

    const orderId = await odooExecuteWrite<number>('sale.order', 'create', [{
      partner_id: labPartner.id, commitment_date: '2026-08-01 02:00:00',
    }]);
    out.quotationIdCreated = orderId; // recorded even if the line create below fails, for cleanup
    await odooExecuteWrite('sale.order.line', 'create', [{
      order_id: orderId, product_id: p.id, product_uom_qty: 1,
      ...(uomField ? { [uomField]: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id } : {}),
      name: p.name,
    }]);
    const [order] = await odooExecuteWrite<any[]>('sale.order', 'read', [[orderId]], { fields: ['name', 'state'] });
    out.quotation = { id: orderId, name: order?.name, state: order?.state };

    // ── Replenishment: warehouse LP, sourced from warehouse LAB ──
    const whs = await odooExecute<any[]>('stock.warehouse', 'search_read', [[['code', '=', 'LP']]], { fields: ['id', 'name'], limit: 1 });
    if (!whs[0]) return NextResponse.json({ error: 'warehouse LP not found', out }, { status: 404 });
    const sourceWhs = await odooExecute<any[]>('stock.warehouse', 'search_read', [[['code', '=', 'LAB']]], { fields: ['id', 'name'], limit: 1 });
    if (!sourceWhs[0]) return NextResponse.json({ error: 'source warehouse LAB not found', out }, { status: 404 });
    const reqId = await odooExecuteWrite<number>('stock.replenishment.request', 'create', [{
      warehouse_id: whs[0].id, source_warehouse_id: sourceWhs[0].id, delivery_date: '2026-08-01 02:00:00',
    }]);
    await odooExecuteWrite('stock.replenishment.request.line', 'create', [{
      request_id: reqId, product_id: p.id, quantity_requested: 1,
    }]);
    const [reqRow] = await odooExecuteWrite<any[]>('stock.replenishment.request', 'read', [[reqId]], { fields: ['name', 'state'] });
    out.replenishment = { id: reqId, name: reqRow?.name, state: reqRow?.state };

    return NextResponse.json({ ok: true, ...out });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e), ...out }, { status: 500 });
  }
}
