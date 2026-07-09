import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooConfigured } from '@/lib/odoo';
import { runOdooSync } from '@/lib/odoo-sync';
import { applyOdooChanges } from '@/lib/odoo-apply';

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
  const changes = body?.changes ?? [];
  if (!changes.length) return NextResponse.json({ error: 'No changes' }, { status: 400 });

  const { applied, errors } = await applyOdooChanges(supabase, changes);
  // Clear any matching pending-queue rows so the dashboard banner reflects reality
  const refs = Array.from(new Set(changes.map((c: any) => c.order_ref)));
  if (refs.length) {
    await supabase.from('lab_odoo_changes')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .in('order_ref', refs).eq('status', 'pending');
  }

  return NextResponse.json({ applied, errors });
}
