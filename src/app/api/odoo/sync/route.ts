import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooConfigured, odooExecute, odooDateTimeToLocal, labTodayUtcThreshold } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Pulls CONFIRMED work from Odoo (read-only):
//   - sale.order state='sale' with delivery (commitment_date) today or later
//   - stock.replenishment.request state='approved' with delivery_date today or later
// Returns lines in the exact shape of the Excel parser (ParsedLine), so the
// existing import pipeline (consolidation, fiche matching, control report) is reused as-is.
// Teams are resolved from the LAB FICHES (SKU → variant → fiche.teams[0]) — never from Odoo tags.
export async function GET() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!odooConfigured()) {
    return NextResponse.json({ error: 'Odoo is not configured (missing ODOO_* environment variables)' }, { status: 503 });
  }

  const threshold = labTodayUtcThreshold();

  try {
    // ── 1. Sales orders — everything entered except cancelled (draft quotations included:
    //     the lab produces from what is ENTERED, confirmation in Odoo comes later) ──
    const orders: any[] = await odooExecute('sale.order', 'search_read',
      [[['state', 'in', ['draft', 'sent', 'sale']], ['commitment_date', '>=', threshold]]],
      { fields: ['name', 'partner_id', 'commitment_date', 'state'], limit: 500 });

    const orderIds = orders.map(o => o.id);
    const soLines: any[] = orderIds.length
      ? await odooExecute('sale.order.line', 'search_read',
          [[['order_id', 'in', orderIds], ['display_type', '=', false]]],
          { fields: ['order_id', 'product_id', 'product_uom_qty', 'name'], limit: 4000 })
      : [];

    // ── 2. Replenishment requests — draft/submitted/approved (everything entered, not yet shipped) ──
    const repls: any[] = await odooExecute('stock.replenishment.request', 'search_read',
      [[['state', 'in', ['draft', 'submitted', 'approved']], ['delivery_date', '>=', threshold]]],
      { fields: ['name', 'warehouse_id', 'delivery_date', 'state'], limit: 200 });

    const replIds = repls.map(r => r.id);
    const replLines: any[] = replIds.length
      ? await odooExecute('stock.replenishment.request.line', 'search_read',
          [[['request_id', 'in', replIds]]],
          { fields: ['request_id', 'product_id', 'quantity_requested'], limit: 2000 })
      : [];

    // ── 3. SKUs for all products involved ──
    const productIds = Array.from(new Set([
      ...soLines.map(l => l.product_id?.[0]),
      ...replLines.map(l => l.product_id?.[0]),
    ].filter(Boolean))) as number[];
    const products: any[] = productIds.length
      ? await odooExecute('product.product', 'read', [productIds], { fields: ['default_code', 'name'] })
      : [];
    const skuByProductId: Record<number, { sku: string; name: string }> = {};
    for (const p of products) skuByProductId[p.id] = { sku: p.default_code || '', name: p.name || '' };

    // ── 4. Team resolution from lab fiches (SKU → variant → fiche.teams[0]) ──
    const allSkus = Array.from(new Set(Object.values(skuByProductId).map(p => p.sku).filter(Boolean)));
    const { data: variantRows } = allSkus.length
      ? await supabase.from('lab_fiche_variants').select('sku, fiche_id').in('sku', allSkus)
      : { data: [] as any[] };
    const ficheIds = Array.from(new Set((variantRows ?? []).map(v => v.fiche_id).filter(Boolean)));
    const { data: ficheRows } = ficheIds.length
      ? await supabase.from('lab_fiche_meta').select('id, teams').in('id', ficheIds)
      : { data: [] as any[] };
    const teamsByFiche: Record<string, string[]> = {};
    for (const f of ficheRows ?? []) teamsByFiche[f.id] = f.teams ?? [];
    const teamBySku: Record<string, { team: string; multi: boolean }> = {};
    for (const v of variantRows ?? []) {
      const teams = teamsByFiche[v.fiche_id] ?? [];
      if (v.sku) teamBySku[v.sku] = { team: teams[0] ?? '', multi: teams.length > 1 };
    }

    // ── 5. Anti-duplicate: order refs already imported into the lab app ──
    const { data: existingRefs } = await supabase
      .from('lab_order_lines')
      .select('order_ref')
      .gte('delivery_date', new Date().toISOString().split('T')[0])
      .limit(5000);
    const alreadyImported = new Set((existingRefs ?? []).map(r => r.order_ref).filter(Boolean));

    // ── 6. Build ParsedLine[] (same shape as the Excel parser output) ──
    const orderById: Record<number, any> = {};
    for (const o of orders) orderById[o.id] = o;
    const replById: Record<number, any> = {};
    for (const r of repls) replById[r.id] = r;

    const lines: any[] = [];
    const skippedRefs = new Set<string>();
    let multiTeamSkus = new Set<string>();

    for (const l of soLines) {
      const order = orderById[l.order_id?.[0]];
      if (!order) continue;
      if (alreadyImported.has(order.name)) { skippedRefs.add(order.name); continue; }
      const prod = skuByProductId[l.product_id?.[0]] ?? { sku: '', name: '' };
      const qty = Math.round(Number(l.product_uom_qty ?? 0));
      if (!prod.sku || !qty) continue;
      const dt = odooDateTimeToLocal(order.commitment_date);
      const t = teamBySku[prod.sku];
      if (t?.multi) multiTeamSkus.add(prod.sku);
      lines.push({
        source_type: 'sales_order',
        order_ref: order.name,
        shop_name: order.partner_id?.[1] ?? '',
        product_sku: prod.sku,
        product_name_vi: String(l.name || prod.name).replace(/\[.*?\]\s*/, '').split('\n')[0].trim(),
        team: t?.team ?? '',
        variant_label: 'Standard',
        qty,
        delivery_date: dt.date,
        delivery_time: dt.time,
      });
    }

    for (const l of replLines) {
      const req = replById[l.request_id?.[0]];
      if (!req) continue;
      if (alreadyImported.has(req.name)) { skippedRefs.add(req.name); continue; }
      const prod = skuByProductId[l.product_id?.[0]] ?? { sku: '', name: '' };
      const qty = Math.round(Number(l.quantity_requested ?? 0));
      if (!prod.sku || !qty) continue;
      const dt = odooDateTimeToLocal(req.delivery_date);
      const t = teamBySku[prod.sku];
      if (t?.multi) multiTeamSkus.add(prod.sku);
      lines.push({
        source_type: 'replenishment',
        order_ref: req.name,
        shop_name: (req.warehouse_id?.[1] ?? '').replace(/\s*-\s*warehouse\s*$/i, ''),
        product_sku: prod.sku,
        product_name_vi: prod.name,
        team: t?.team ?? '',
        variant_label: 'Standard',
        qty,
        delivery_date: dt.date,
        delivery_time: dt.time,
      });
    }

    // Odoo status per order ref — shown in the control report so assistants
    // can spot lines that are still unconfirmed quotations before publishing
    const orderStates: Record<string, string> = {};
    for (const o of orders) orderStates[o.name] = o.state;      // draft | sent | sale
    for (const r of repls) orderStates[r.name] = r.state;       // draft | submitted | approved

    return NextResponse.json({
      lines,
      stats: {
        sales_orders: orders.length,
        replenishments: repls.length,
        already_imported: Array.from(skippedRefs),
        multi_team_skus: Array.from(multiTeamSkus),
        order_states: orderStates,
      },
      synced_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Odoo sync failed' }, { status: 502 });
  }
}
