import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooExecuteWrite } from '@/lib/odoo';
import { resolveShopWarehouseLocation, resolveProductsBySku, resolveDefaultScrapLocationId, resolveLabWarehouseLocation } from '@/lib/odoo-scrap';
import { prefillReplenishmentReceivedQty } from '@/lib/odoo-shop-receipt-sync';

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
  const idlessActions = new Set(['productname', 'fields', 'reporder', 'testprefill', 'lablocation', 'modulecheck']);
  if (!id && !idlessActions.has(action)) return NextResponse.json({ error: 'Missing ?id=' }, { status: 400 });

  try {
    if (action === 'modulecheck') {
      // Read-only diagnosis (2026-08-27, Axel: purchase workflow redesign with Miss Flavor —
      // "option 2" = the OCA purchase_request module family). Checks install state of every
      // module in that suite, and if the core one is installed, introspects its model/workflow
      // before any decision is made. Zero writes.
      const names = [
        'purchase_request', 'purchase_request_to_po', 'purchase_request_line_procurement',
        'purchase_request_department', 'purchase_request_tier_validation', 'purchase_request_budget',
      ];
      const modules = await odooExecuteWrite<any[]>('ir.module.module', 'search_read',
        [[['name', 'in', names]]], { fields: ['name', 'state', 'shortdesc', 'installed_version'] });
      let modelInfo: any = null;
      let sampleCount: number | null = null;
      let lineFields: string[] | null = null;
      let groups: any[] | null = null;
      const coreInstalled = modules.some(m => m.name === 'purchase_request' && m.state === 'installed');
      if (coreInstalled) {
        modelInfo = await odooExecuteWrite<Record<string, any>>('purchase.request', 'fields_get',
          [], { attributes: ['string', 'type', 'selection', 'required', 'help'] });
        sampleCount = await odooExecuteWrite<number>('purchase.request', 'search_count', [[]]);
        const lineFieldsObj = await odooExecuteWrite<Record<string, any>>('purchase.request.line', 'fields_get',
          [], { attributes: ['string', 'type'] });
        lineFields = Object.keys(lineFieldsObj);
        groups = await odooExecuteWrite<any[]>('res.groups', 'search_read',
          [[['category_id.name', '=', 'Purchase Request']]], { fields: ['name', 'full_name'] });
      }
      return NextResponse.json({ modules, coreInstalled, sampleCount, groups, purchaseRequestStateOptions: modelInfo?.state?.selection ?? null, purchaseRequestKeyFields: modelInfo ? Object.keys(modelInfo) : null, lineFields });
    }
    if (action === 'lablocation') {
      // Read-only check for the new LAB scrap feature (2026-08-27): confirms resolveLabWarehouseLocation
      // actually resolves a real Odoo location via warehouse code 'LAB', before trusting the UI.
      const loc = await resolveLabWarehouseLocation();
      return NextResponse.json({ loc });
    }
    if (action === 'testprefill') {
      // End-to-end test of prefillReplenishmentReceivedQty against a REAL REP order/line, using
      // a value equal to the line's own quantity_requested so the test is realistic, then reverts
      // quantity_received back to its original value afterward — no permanent data change, unlike
      // the scrap-wizard test (that one couldn't be undone once 'done'; a plain float field write
      // can always be reverted).
      const ref = url.searchParams.get('ref') ?? '';
      const sku = url.searchParams.get('sku') ?? '';
      if (!ref || !sku) return NextResponse.json({ error: 'Missing ?ref= or ?sku=' }, { status: 400 });
      const before = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'search_read',
        [[['request_id.name', '=', ref]]], { fields: ['id', 'product_id', 'quantity_requested', 'quantity_received'] });
      const targetLine = before.find((l: any) => Array.isArray(l.product_id) && String(l.product_id[1]).includes(`[${sku}]`));
      if (!targetLine) return NextResponse.json({ error: `No REP line found for ${sku} on ${ref}`, before });
      const originalReceived = targetLine.quantity_received;
      const testQty = targetLine.quantity_requested;
      const result = await prefillReplenishmentReceivedQty(ref, [{ sku, qtyReceived: testQty }]);
      const after = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'read', [[targetLine.id]], { fields: ['quantity_received'] });
      // Revert
      await odooExecuteWrite('stock.replenishment.request.line', 'write', [[targetLine.id], { quantity_received: originalReceived }]);
      const reverted = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'read', [[targetLine.id]], { fields: ['quantity_received'] });
      return NextResponse.json({ result, before: { id: targetLine.id, originalReceived, testQty }, afterWrite: after[0], afterRevert: reverted[0] });
    }
    if (action === 'fields') {
      // Read-only introspection for Axel's request (2026-08-27): "prefill the reception quantity
      // on the REP order when the shop finishes its receipt check" — need to know whether
      // stock.replenishment.request(.line) has its OWN received-qty field (separate from the
      // stock.move/picking flow odoo-delivery-validate.ts already writes), before designing
      // anything.
      const model = url.searchParams.get('model') ?? 'stock.replenishment.request.line';
      const fields = await odooExecuteWrite<Record<string, any>>(model, 'fields_get', [], { attributes: ['string', 'type', 'help'] });
      return NextResponse.json({ model, fields });
    }
    if (action === 'reporder') {
      // Read-only: full field dump for one real REP order's lines, to see actual values in any
      // received-qty-looking field once found via `fields`.
      const ref = url.searchParams.get('ref') ?? '';
      if (!ref) return NextResponse.json({ error: 'Missing ?ref=' }, { status: 400 });
      const reqs = await odooExecuteWrite<any[]>('stock.replenishment.request', 'search_read', [[['name', '=', ref]]], { fields: ['id', 'name', 'state'] });
      const req = reqs[0];
      if (!req) return NextResponse.json({ error: 'not found' });
      const lines = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'search_read', [[['request_id', '=', req.id]]], { fields: [] });
      return NextResponse.json({ req, lines });
    }
    if (action === 'productname') {
      // Read-only check for Axel's report (2026-08-27): "Bánh La Plume D14" shows on the app
      // without its flavor even though the product has variants in Odoo. Hypothesis: our sync
      // reads product.product's plain `name` field, which is related to the TEMPLATE name and
      // does NOT include the variant's attribute values (e.g. flavor) — only `display_name`
      // (Odoo's name_get, which appends "(Attribute: Value)") carries that. Confirming before
      // touching odoo-sync.ts's skuByProductId build.
      const q = url.searchParams.get('q') ?? '';
      if (!q) return NextResponse.json({ error: 'Missing ?q= (name search or exact sku)' }, { status: 400 });
      const rows = await odooExecuteWrite<any[]>('product.product', 'search_read', [
        ['|', ['name', 'ilike', q], ['default_code', '=', q]],
      ], { fields: ['default_code', 'name', 'display_name', 'product_template_attribute_value_ids'], limit: 20 });
      return NextResponse.json({ rows });
    }
    if (action === 'stock') {
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      if (!loc || !product) return NextResponse.json({ error: 'shop or sku not resolved', loc, product });
      // qty_available scoped to the shop's OWN location — this is what action_validate's
      // insufficient-quantity check actually reads (company-wide qty_available would look fine
      // even when the shop's own location has 0).
      const rows = await odooExecuteWrite<any[]>('product.product', 'read', [[product.id]], {
        fields: ['qty_available', 'virtual_available'], context: { location: loc.locationId },
      });
      return NextResponse.json({ shopLocation: loc, product, qtyAtShopLocation: rows[0] });
    }
    if (action === 'testvalidate') {
      // Creates a real (tiny) scrap the same way createShopScrap() does, then calls
      // action_validate and returns its RAW result untouched — this is the only way to see the
      // actual wizard payload Odoo returns for insufficient qty, instead of guessing model/field
      // names. Cleans itself up (unlink) if it's still draft afterward.
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      const scrapLocationId = await resolveDefaultScrapLocationId();
      if (!loc || !product || !scrapLocationId) return NextResponse.json({ error: 'setup not resolved', loc, product, scrapLocationId });
      const scrapId = await odooExecuteWrite<number>('stock.scrap', 'create', [{
        product_id: product.id, product_uom_id: product.uom_id, scrap_qty: 1,
        location_id: loc.locationId, scrap_location_id: scrapLocationId,
        origin: 'DEBUG_TEST_DELETE_ME',
      }]);
      const validateResult = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[scrapId]]);
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[scrapId]], { fields: ['state'] });
      let cleaned = false;
      if (after[0]?.state !== 'done') {
        try { await odooExecuteWrite('stock.scrap', 'unlink', [[scrapId]]); cleaned = true; } catch {}
      }
      return NextResponse.json({ scrapId, validateResult, stateAfter: after[0]?.state ?? null, cleaned });
    }
    if (action === 'testwizard') {
      // End-to-end test of the actual fix now in odoo-scrap.ts's createShopScrap(): create a
      // real tiny scrap, hit the insufficient-qty wizard, confirm it via action_done, and report
      // the final state. NOT cleaned up automatically if it ends up 'done' (a done stock.scrap
      // can't be safely unlinked) — caller is expected to compensate manually if this was purely
      // a test, same as any other real scrap.
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      const scrapLocationId = await resolveDefaultScrapLocationId();
      if (!loc || !product || !scrapLocationId) return NextResponse.json({ error: 'setup not resolved', loc, product, scrapLocationId });
      const scrapId = await odooExecuteWrite<number>('stock.scrap', 'create', [{
        product_id: product.id, product_uom_id: product.uom_id, scrap_qty: 1,
        location_id: loc.locationId, scrap_location_id: scrapLocationId,
        origin: 'DEBUG_TESTWIZARD_DELETE_ME',
      }]);
      const validateResult = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[scrapId]]);
      let wizardResult: any = null;
      if (validateResult?.res_model === 'stock.warn.insufficient.qty.scrap') {
        const ctx = validateResult.context ?? {};
        const wizardId = await odooExecuteWrite<number>('stock.warn.insufficient.qty.scrap', 'create', [{
          product_id: ctx.default_product_id, location_id: ctx.default_location_id,
          scrap_id: ctx.default_scrap_id, quantity: ctx.default_quantity,
          product_uom_name: ctx.default_product_uom_name,
        }]);
        wizardResult = await odooExecuteWrite<any>('stock.warn.insufficient.qty.scrap', 'action_done', [[wizardId]]);
      }
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[scrapId]], { fields: ['state'] });
      return NextResponse.json({ scrapId, validateResult, wizardResult, stateAfter: after[0]?.state ?? null });
    }
    if (action === 'recent') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'search_read', [[]], {
        fields: ['state', 'product_id', 'scrap_qty', 'location_id', 'origin', 'create_date'],
        order: 'id desc', limit: 10,
      });
      return NextResponse.json({ rows });
    }
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
