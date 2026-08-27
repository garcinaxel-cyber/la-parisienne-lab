import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooExecuteWrite } from '@/lib/odoo';

// Staff-only diagnostic/fix tool for stock.scrap records created via the shop portal.
// Axel, 2026-08-27: reported a scrap he created through the shop loss-report flow shows as
// 'draft' in Odoo even though createShopScrap() (odoo-scrap.ts) calls action_validate right
// after create and never sees an error — meaning action_validate is returning something instead
// of raising (most likely an insufficient-quantity confirmation wizard action, which Odoo returns
// as a dict rather than throwing), and our code silently ignores that return value. This route
// exists to (a) inspect a scrap's real state + what action_validate actually returns, and
// (b) let a specific test/mistaken scrap be cancelled cleanly, without touching the app's own
// createShopScrap() write path yet — kept separate on purpose until the actual cause is
// confirmed from a real response, not guessed.
async function requireStaff() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' as const };
  return { ok: true as const };
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 403 });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id'));
  const action = url.searchParams.get('action') ?? 'inspect';
  if (!id) return NextResponse.json({ error: 'Missing ?id=' }, { status: 400 });

  try {
    if (action === 'inspect') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], {
        fields: ['state', 'product_id', 'scrap_qty', 'location_id', 'scrap_location_id', 'origin'],
      });
      const scrap = rows[0];
      let qtyAvailable: any = null;
      if (scrap?.product_id) {
        const pid = Array.isArray(scrap.product_id) ? scrap.product_id[0] : scrap.product_id;
        const prod = await odooExecuteWrite<any[]>('product.product', 'read', [[pid]], { fields: ['qty_available', 'name', 'default_code'] });
        qtyAvailable = prod[0];
      }
      return NextResponse.json({ scrap, qtyAvailable });
    }
    if (action === 'validate') {
      const result = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[id]]);
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], { fields: ['state'] });
      return NextResponse.json({ validateResult: result, stateAfter: after[0]?.state ?? null });
    }
    if (action === 'cancel') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], { fields: ['state'] });
      const state = rows[0]?.state;
      if (state === 'done') return NextResponse.json({ error: `Scrap is already 'done' — cannot cancel/unlink safely from here` }, { status: 400 });
      // Draft scraps can just be unlinked outright.
      await odooExecuteWrite('stock.scrap', 'unlink', [[id]]);
      return NextResponse.json({ ok: true, unlinked: id });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
