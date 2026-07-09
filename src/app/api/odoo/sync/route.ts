import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooConfigured } from '@/lib/odoo';
import { runOdooSync } from '@/lib/odoo-sync';

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

  try {
    const result = await runOdooSync(supabase);
    return NextResponse.json({ ...result, synced_at: new Date().toISOString() });
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
