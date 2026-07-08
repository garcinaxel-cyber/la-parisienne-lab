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

    const orderById: Record<number, any> = {};
    for (const o of orders) orderById[o.id] = o;
    const replById: Record<number, any> = {};
    for (const r of repls) replById[r.id] = r;

    // ── 5. Anti-duplicate + change detection: refs already imported into the lab app ──
    const { data: existingLines } = await supabase
      .from('lab_order_lines')
      .select('id, order_ref, product_sku, product_name_vi, qty, import_id, team, variant_label, delivery_date')
      .gte('delivery_date', new Date().toISOString().split('T')[0])
      .limit(5000);
    const alreadyImported = new Set((existingLines ?? []).map(r => r.order_ref).filter(Boolean));

    // Current Odoo quantities per (order_ref, sku) — for already-imported refs
    const odooQtyByRefSku: Record<string, { qty: number; name: string }> = {};
    const refsSeenInOdoo = new Set<string>();
    const addOdooQty = (ref: string, sku: string, qty: number, name: string) => {
      refsSeenInOdoo.add(ref);
      const k = `${ref}||${sku}`;
      const cur = odooQtyByRefSku[k];
      odooQtyByRefSku[k] = { qty: (cur?.qty ?? 0) + qty, name };
    };
    for (const l of soLines) {
      const order = orderById[l.order_id?.[0]];
      const prod = skuByProductId[l.product_id?.[0]];
      if (order && prod?.sku && alreadyImported.has(order.name)) {
        addOdooQty(order.name, prod.sku, Math.round(Number(l.product_uom_qty ?? 0)), prod.name);
      }
    }
    for (const l of replLines) {
      const req = replById[l.request_id?.[0]];
      const prod = skuByProductId[l.product_id?.[0]];
      if (req && prod?.sku && alreadyImported.has(req.name)) {
        addOdooQty(req.name, prod.sku, Math.round(Number(l.quantity_requested ?? 0)), prod.name);
      }
    }
    // Refs imported into the lab but no longer returned by Odoo (cancelled, or state left the
    // imported scope) — check their actual state explicitly
    const missingRefs = Array.from(alreadyImported).filter(r => !refsSeenInOdoo.has(r)) as string[];
    const cancelledRefs: string[] = [];
    if (missingRefs.length > 0) {
      const soMissing: any[] = await odooExecute('sale.order', 'search_read',
        [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
      const rrMissing: any[] = await odooExecute('stock.replenishment.request', 'search_read',
        [[['name', 'in', missingRefs]]], { fields: ['name', 'state'], limit: 200 });
      for (const o of [...soMissing, ...rrMissing]) {
        if (['cancel', 'cancelled', 'rejected'].includes(o.state)) cancelledRefs.push(o.name);
      }
    }
    // Build the change list: lab vs Odoo, per (order_ref, sku)
    const labQtyByRefSku: Record<string, { qty: number; name: string }> = {};
    for (const r of existingLines ?? []) {
      if (!r.order_ref || !r.product_sku) continue;
      const k = `${r.order_ref}||${r.product_sku}`;
      labQtyByRefSku[k] = { qty: (labQtyByRefSku[k]?.qty ?? 0) + (r.qty ?? 0), name: r.product_name_vi ?? r.product_sku };
    }
    const changesByRef: Record<string, { sku: string; name: string; old_qty: number; new_qty: number }[]> = {};
    const pushChange = (ref: string, c: { sku: string; name: string; old_qty: number; new_qty: number }) => {
      (changesByRef[ref] = changesByRef[ref] ?? []).push(c);
    };
    for (const [k, lab] of Object.entries(labQtyByRefSku)) {
      const [ref, sku] = k.split('||');
      if (!alreadyImported.has(ref)) continue;
      if (cancelledRefs.includes(ref)) { pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: 0 }); continue; }
      if (!refsSeenInOdoo.has(ref)) continue; // ref not in scope anymore but not cancelled — leave untouched
      const odoo = odooQtyByRefSku[k];
      if (!odoo) { pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: 0 }); continue; }
      if (odoo.qty !== lab.qty) pushChange(ref, { sku, name: lab.name, old_qty: lab.qty, new_qty: odoo.qty });
    }
    for (const [k, odoo] of Object.entries(odooQtyByRefSku)) {
      const [ref, sku] = k.split('||');
      if (!labQtyByRefSku[k]) pushChange(ref, { sku, name: odoo.name, old_qty: 0, new_qty: odoo.qty });
    }
    const changes = Object.entries(changesByRef).map(([order_ref, items]) => ({
      order_ref,
      cancelled: cancelledRefs.includes(order_ref),
      items,
    }));

    // ── 6. Build ParsedLine[] (same shape as the Excel parser output) ──
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
      changes,
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

// Apply Odoo changes to already-imported orders.
// Body: { changes: [{ order_ref, cancelled, items: [{ sku, name, old_qty, new_qty }] }] }
// For each item: update lab_order_lines.qty, then adjust the matching assignment
// (total_qty / qty_to_produce ± delta, breakdown entry updated, note appended).
export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const changes: { order_ref: string; cancelled?: boolean; items: { sku: string; new_qty: number }[] }[] = body?.changes ?? [];
  if (!changes.length) return NextResponse.json({ error: 'No changes' }, { status: 400 });

  const today = new Date().toISOString().split('T')[0];
  const applied: string[] = [];
  const errors: string[] = [];

  for (const ch of changes) {
    for (const item of ch.items) {
      // All lab lines for this (ref, sku) from today onwards
      const { data: olRows } = await supabase
        .from('lab_order_lines')
        .select('id, qty, import_id, team, variant_label, product_name_vi, shop_name')
        .eq('order_ref', ch.order_ref)
        .eq('product_sku', item.sku)
        .gte('delivery_date', today);
      if (!olRows?.length) {
        // New product added in Odoo to an already-imported order — needs a fresh sync/import, skip here
        if (item.new_qty > 0) errors.push(`${ch.order_ref}/${item.sku}: new line — re-import to add it`);
        continue;
      }
      const oldTotal = olRows.reduce((s, r) => s + (r.qty ?? 0), 0);
      const delta = item.new_qty - oldTotal;
      if (delta === 0) continue;

      // Write the new qty on the first line, zero the others (consolidated view stays correct)
      const [first, ...rest] = olRows;
      await supabase.from('lab_order_lines').update({ qty: item.new_qty }).eq('id', first.id);
      for (const r of rest) await supabase.from('lab_order_lines').update({ qty: 0 }).eq('id', r.id);

      // Adjust the matching assignment (same import, team, variant)
      const { data: asgRows } = await supabase
        .from('lab_assignments')
        .select('id, total_qty, qty_to_produce, breakdown, notes')
        .eq('import_id', first.import_id)
        .eq('team', first.team)
        .eq('variant_label', first.variant_label)
        .eq('product_name_vi', first.product_name_vi);
      const asg = asgRows?.[0];
      if (asg) {
        const breakdown = Array.isArray(asg.breakdown) ? [...asg.breakdown] : [];
        const bIdx = breakdown.findIndex((b: any) => b.order_ref === ch.order_ref);
        if (bIdx >= 0) breakdown[bIdx] = { ...breakdown[bIdx], qty: item.new_qty };
        const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
        const note = ch.cancelled
          ? `⚠ ${ch.order_ref} annulée dans Odoo (−${oldTotal})`
          : `Odoo ${stamp}: ${ch.order_ref} ${delta > 0 ? '+' : ''}${delta}`;
        await supabase.from('lab_assignments').update({
          total_qty: Math.max(0, (asg.total_qty ?? 0) + delta),
          qty_to_produce: Math.max(0, (asg.qty_to_produce ?? 0) + delta),
          breakdown,
          notes: asg.notes ? `${asg.notes}\n${note}` : note,
          updated_at: new Date().toISOString(),
        }).eq('id', asg.id);
      }
      applied.push(`${ch.order_ref}/${item.sku}: ${oldTotal} → ${item.new_qty}`);
    }
  }

  return NextResponse.json({ applied, errors });
}
