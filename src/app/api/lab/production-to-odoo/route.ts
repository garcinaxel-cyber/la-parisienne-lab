import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooConfigured, odooWriteConfigured } from '@/lib/odoo';
import { syncStockToOdoo } from '@/lib/odoo-mo-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Manual full-resync of a day's production to Odoo draft Manufacturing Orders. The source is what
// was SENT TO STOCK that day; the sync keeps SUM(non-cancelled MOs) == qty sent to stock per
// product (validated MOs are never touched — a new draft is created for any delta). Real-time
// syncing on each stock transfer is handled in submitStockTransferAction; this route is the
// manual catch-up. Dry-run by default; ?commit=1 writes. Admin only.
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
  if (commit && !odooWriteConfigured()) return NextResponse.json({ error: 'ODOO_WRITE_* not configured — cannot create MOs' }, { status: 500 });

  const r = await syncStockToOdoo(supabase, date, { commit });

  const summary: any = {
    date: r.date, origin: r.origin,
    to_create: r.toCreate.length, to_update: r.toUpdate.length,
    unchanged: r.unchanged.length, no_odoo_product: r.noProduct.length,
    missing_sku: r.missingSku.length,
  };
  if (!commit) {
    return NextResponse.json({
      dryRun: true, summary,
      toCreate: r.toCreate.map(({ values, ...x }) => x), toUpdate: r.toUpdate, noProduct: r.noProduct,
      missingSku: r.missingSku,
    });
  }
  summary.created = r.created?.length ?? 0;
  summary.updated = r.updated?.length ?? 0;
  summary.errors = r.errors?.length ?? 0;
  return NextResponse.json({ committed: true, summary, created: r.created ?? [], updated: r.updated ?? [], errors: r.errors ?? [], noProduct: r.noProduct, missingSku: r.missingSku });
}
