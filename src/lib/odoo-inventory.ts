// Server-only: finished-goods inventory count → Odoo's structured "Inventory Adjustment"
// workflow (stock.inventory + lpr.stock.inventory.line — a custom La Parisienne module, NOT
// standard Odoo/OCA), replacing the old direct stock.quant.inventory_quantity overwrite this
// file used before 2026-09-22.
//
// Why this changed (Axel, 2026-09-22): a "kiểm kê" session in the app can stay open for hours
// (staff count progressively, category by category, then submit once at the end). The old
// mechanism read Odoo's CURRENT on-hand only at the final "Gửi lên Odoo" click and overwrote it
// with the counted number — so any real stock move that happened on that SKU between when it was
// physically counted and when the session was finally submitted (a shop transfer, a fresh
// production batch, a scrap) got silently erased.
//
// The new Odoo module fixes exactly this, via a frozen cut-off + delta reconciliation:
//   1. `stock.inventory.action_state_to_in_progress()` freezes `theoretical_qty` on a
//      `lpr.stock.inventory.line` the INSTANT it's called — this is the "Count Cut-off" moment,
//      captured once and never recomputed.
//   2. Later, whenever the count is actually entered (`counted_qty` written on the line) and the
//      whole `stock.inventory` is applied (`action_state_to_done()`), Odoo computes
//      `diff_qty = counted_qty - theoretical_qty` (the TRUE physical gap at cut-off time) and
//      writes `target_qty = current_on_hand_NOW + diff_qty` into the quant's own
//      `inventory_quantity`, then applies it — i.e. it replays the counted DELTA on top of
//      whatever happened since, instead of overwriting with a stale absolute number.
//
// This module mirrors that: one small `stock.inventory` per SKU, opened (and its cut-off frozen)
// the moment that SKU is first entered in an app count session — not at final submit — so the
// cut-off matches when the product actually entered the count, exactly like clicking "Begin
// Adjustments" on that one product right away. Nothing is written to real stock until the
// session is submitted (`applyInventoryLines`, called from confirmSubmitAction).
//
// NOTE: this module was implemented against `lpr.stock.inventory.line`'s own field help text
// (confirmed live via read-only + a zero-diff dry-run) and the state machine was verified live
// (draft → in_progress → counted → done), but a REAL non-zero diff was deliberately never fired
// during that research — doing so would have changed real LAB stock. Axel: test once on a real,
// low-stakes product after deploy, watching the resulting stock.quant directly, before trusting
// this for the daily count.
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from './odoo';

const NO_MAIL_CONTEXT = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true };

let cachedLabLocationId: number | null = null;

async function getLabStockLocationId(): Promise<number> {
  if (cachedLabLocationId) return cachedLabLocationId;
  const whs = await odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', 'LAB']]], { fields: ['lot_stock_id'], limit: 1 });
  const wh = whs[0];
  if (!wh?.lot_stock_id) throw new Error('Entrepôt LAB introuvable sur Odoo (code "LAB")');
  cachedLabLocationId = Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : wh.lot_stock_id;
  return cachedLabLocationId!;
}

/** Resolve product.product ids by default_code (SKU), batched — same pattern as odoo-mo-sync.ts. */
async function resolveProductsBySku(skus: string[]): Promise<Record<string, { id: number; name: string }>> {
  if (!skus.length) return {};
  const prods = await odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code'], limit: 2000 });
  const map: Record<string, { id: number; name: string }> = {};
  for (const p of prods) if (p.default_code) map[p.default_code] = { id: p.id, name: p.name };
  return map;
}

export interface InventoryCountInput { sku: string; qtyCounted: number; }

export interface InventoryLineResult {
  sku: string;
  found: boolean;            // product exists on Odoo (default_code match)
  qtySystem: number | null;  // theoretical qty frozen at cut-off (when the SKU was first counted)
  qtyCounted: number;
  diff: number | null;       // qtyCounted - qtySystem (the true physical gap at cut-off)
  ok: boolean;
  error?: string;
}

// ── Step 1: open (or reuse) the cut-off the instant a SKU is first entered in a count ──
export interface StartLineResult {
  ok: boolean;
  odooInventoryId?: number;
  odooCountLineId?: number;
  qtyTheoretical?: number;
  error?: string;
}

/**
 * Ensures a `stock.inventory` "Inventory Adjustment" is open (in_progress) for this one SKU at
 * LAB/Stock, freezing its theoretical_qty cut-off NOW if it isn't open already. Reuses an
 * existing in_progress adjustment for the same product if Odoo already has one — both because
 * Odoo itself refuses to open a second one for the same product ("There are active adjustments
 * for the requested products"), and because reusing is the correct behavior: whichever cut-off
 * was frozen FIRST is the one that matters (e.g. re-entering a line that was deleted and re-added
 * in the same session, or a stray adjustment left open by an earlier session for this SKU).
 * Called once per SKU per session — on the FIRST save of that line, never on a later correction
 * (correcting a typo in the counted number must never move the cut-off).
 */
// The lpr module only generates count lines for products that have a NON-ZERO quant at the
// location (verified live 2026-09-30: BQMVH had no quant, BQMVMD a 0-qty quant — neither got a
// line, so the count could not be saved). For those, add the line ourselves: make sure a quant
// exists (a plain empty stock.quant — quantity 0, harmless) and create the count line on it. Its
// theoretical_qty is then 0, which is the true system quantity.
async function addMissingCountLines(invId: number, locationId: number, productIds: number[]): Promise<void> {
  if (!productIds.length) return;
  const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read',
    [[['product_id', 'in', productIds], ['location_id', '=', locationId]]], { fields: ['id', 'product_id'] });
  const quantByProduct: Record<number, number> = {};
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    if (!quantByProduct[pid]) quantByProduct[pid] = q.id;
  }
  // batched: one create call for all missing quants, one for all lines (a shop can have dozens)
  const noQuant = productIds.filter(pid => !quantByProduct[pid]);
  if (noQuant.length) {
    try {
      const ids = await odooExecuteWrite<number[] | number>('stock.quant', 'create',
        [noQuant.map(pid => ({ product_id: pid, location_id: locationId }))], { context: NO_MAIL_CONTEXT });
      const arr = Array.isArray(ids) ? ids : [ids];
      noQuant.forEach((pid, i) => { if (arr[i]) quantByProduct[pid] = arr[i]; });
    } catch { /* lines can still exist without a quant */ }
  }
  await odooExecuteWrite<number[] | number>('lpr.stock.inventory.line', 'create', [productIds.map(pid => ({
    inventory_id: invId, product_id: pid, location_id: locationId, ...(quantByProduct[pid] ? { quant_id: quantByProduct[pid] } : {}),
  }))], { context: NO_MAIL_CONTEXT });
}

export async function ensureInventoryLineStarted(sku: string): Promise<StartLineResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  // stock.inventory / lpr.stock.inventory.line are read through the WRITE account (2026-09-30):
  // the read-only account was never exercised on these custom-module models in production, and
  // the first real LAB count of 30/09 saved nothing (every line failed here, silently).
  try {
    const locationId = await getLabStockLocationId();
    const productBySku = await resolveProductsBySku([sku]);
    const prod = productBySku[sku];
    if (!prod) return { ok: false, error: 'SKU introuvable sur Odoo (default_code)' };

    // Filtered by location_ids too (not just product_ids) — 2026-09-22, found while designing the
    // shops' official-inventory feature: without this, two different locations counting the same
    // SKU the same day would collide (the second one would silently reuse the first location's
    // still-open cut-off and its diff would land on the WRONG location's stock). Never triggered
    // for LAB until now since LAB is the only caller of this per-SKU path.
    const openInv = await odooExecuteWrite<any[]>('stock.inventory', 'search_read',
      [[['state', '=', 'in_progress'], ['product_ids', 'in', [prod.id]], ['location_ids', 'in', [locationId]]]],
      { fields: ['id'], limit: 1 });

    let invId: number;
    if (openInv.length) {
      invId = openInv[0].id;
    } else {
      invId = await odooExecuteWrite<number>('stock.inventory', 'create', [{
        name: `Kiểm kê LAB — ${sku} — ${new Date().toISOString().slice(0, 10)}`,
        product_selection: 'manual',
        product_ids: [[6, 0, [prod.id]]],
        location_ids: [[6, 0, [locationId]]],
      }], { context: NO_MAIL_CONTEXT });
      try {
        await odooExecuteWrite('stock.inventory', 'action_state_to_in_progress', [[invId]], { context: NO_MAIL_CONTEXT });
      } catch (e: any) {
        // Creation went through but the freeze didn't — never leave an empty draft adjustment
        // behind with no count line and no way for the app to find it again.
        try { await odooExecuteWrite('stock.inventory', 'unlink', [[invId]], {}); } catch { /* best-effort */ }
        throw e;
      }
    }

    const lineFor = async () => {
      const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'search_read',
        [[['id', '=', invId]]], { fields: ['count_line_ids'] });
      const lineIds: number[] = inv?.count_line_ids ?? [];
      if (!lineIds.length) return null;
      const rows = await odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'search_read',
        [[['id', 'in', lineIds], ['product_id', '=', prod.id]]], { fields: ['id', 'theoretical_qty'], limit: 1 });
      return rows[0] ?? null;
    };
    let line = await lineFor();
    if (!line) {
      // product at 0 / never stocked at LAB — add its line ourselves (see addMissingCountLines)
      await addMissingCountLines(invId, locationId, [prod.id]);
      line = await lineFor();
    }
    if (!line) return { ok: false, error: 'Ligne de comptage introuvable pour ce produit sur Odoo' };

    return { ok: true, odooInventoryId: invId, odooCountLineId: line.id, qtyTheoretical: Number(line.theoretical_qty ?? 0) };
  } catch (e: any) {
    console.error('[inventory] ensureInventoryLineStarted failed', { sku, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Best-effort: cancel the Odoo adjustment behind a line the shop deletes from an in-progress app
 * session BEFORE it was ever submitted. Never blocks the app-side delete on this — Odoo's cancel
 * button has its own gating (state, assignment) this module doesn't fully control, so a failure
 * here just leaves a harmless, never-applied draft/in_progress adjustment in Odoo for a human to
 * clean up later, rather than erroring the delete.
 */
export async function tryCancelInventoryLine(odooInventoryId: number): Promise<void> {
  if (!odooWriteConfigured()) return;
  // Odoo refuses to cancel an in_progress adjustment directly ("You can't cancel this inventory"),
  // verified live 2026-09-30 on Timecity's orphaned cut-off: it must go back to draft first
  // (which releases the frozen quants), then cancel.
  try {
    await odooExecuteWrite('stock.inventory', 'action_state_to_draft', [[odooInventoryId]], { context: NO_MAIL_CONTEXT });
  } catch { /* already draft, or not resettable — the cancel below will say */ }
  try {
    await odooExecuteWrite('stock.inventory', 'action_state_to_cancel', [[odooInventoryId]], { context: NO_MAIL_CONTEXT });
  } catch (e: any) {
    console.error('[inventory] could not cancel Odoo adjustment', { odooInventoryId, error: String(e?.message ?? e) });
  }
}

// ── Step 2: at final submit, write the counted numbers and apply the delta on top of current stock ──
export interface ApplyLineInput { odooCountLineId: number; qtyCounted: number; }

export interface ApplyPushResult {
  ok: boolean;
  lines: (InventoryLineResult & { odooCountLineId: number })[];
  error?: string;
}

/**
 * Writes `counted_qty` on each already-frozen count line, then, per `stock.inventory` involved:
 *   1. `action_apply_count_lines()` ("Apply Count Sheet") — THE step that writes
 *      `target_qty = current_on_hand_now + (counted − theoretical)` onto the real stock.quant,
 *      replaying the counted delta on top of whatever happened since the cut-off;
 *   2. `action_state_to_done()` ("Set to Done") — only closes the inventory.
 * FIX 2026-09-30: step 1 was missing — `action_state_to_done` alone closes the inventory WITHOUT
 * applying anything (Thăng Long's official inventory ended "done" with 0 stock moves). Step 1 is
 * only available while the inventory is in_progress, so it must run before step 2. Both methods
 * are singletons in this module, hence one call per inventory. After applying, every line with a
 * non-zero diff is checked for `applied_qty`, so a silent no-op can never be reported as success.
 */
export async function applyInventoryLines(
  entries: ApplyLineInput[],
  // applyToStock=false (shops' official inventory, 2026-09-30): write the counted quantities on the
  // Odoo count sheet ONLY and leave the inventory in_progress — management applies it the next
  // morning ("Apply Count Sheet" then "Set to Done") once the day's sales are entered in Odoo,
  // otherwise the day's sales, already gone from the shelves at count time, get deducted twice.
  opts: { applyToStock?: boolean } = {},
): Promise<ApplyPushResult> {
  const applyToStock = opts.applyToStock !== false;
  if (!entries.length) return { ok: false, lines: [], error: 'Aucune ligne comptée' };
  if (!odooWriteConfigured()) return { ok: false, lines: [], error: 'Compte Odoo en écriture non configuré' };

  const lineIds = entries.map(e => e.odooCountLineId);
  const results: (InventoryLineResult & { odooCountLineId: number })[] = [];

  try {
    // Write the counted quantity on every line first (per-id: qty differs per line).
    for (const e of entries) {
      try {
        await odooExecuteWrite('lpr.stock.inventory.line', 'write',
          [[e.odooCountLineId], { counted_qty: e.qtyCounted, counted_set: true }], { context: NO_MAIL_CONTEXT });
      } catch (err: any) {
        results.push({
          odooCountLineId: e.odooCountLineId, sku: '', found: true, qtySystem: null,
          qtyCounted: e.qtyCounted, diff: null, ok: false, error: String(err?.message ?? err),
        });
      }
    }
    const writtenIds = lineIds.filter(id => !results.some(r => r.odooCountLineId === id && !r.ok));
    if (!writtenIds.length) return { ok: true, lines: results };

    const preRows = await odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'read', [writtenIds],
      { fields: ['id', 'inventory_id', 'product_id'] });
    const invIds = Array.from(new Set(preRows.map(r => Array.isArray(r.inventory_id) ? r.inventory_id[0] : r.inventory_id)));
    const skuByLineId: Record<number, string> = {};
    for (const r of preRows) skuByLineId[r.id] = r.product_id?.[1] ?? '';

    if (invIds.length && applyToStock) {
      try {
        for (const invId of invIds) {
          await odooExecuteWrite('stock.inventory', 'action_apply_count_lines', [[invId]], { context: NO_MAIL_CONTEXT });
          await odooExecuteWrite('stock.inventory', 'action_state_to_done', [[invId]], { context: NO_MAIL_CONTEXT });
        }
      } catch (e: any) {
        const msg = `Écrit mais non appliqué sur Odoo : ${String(e?.message ?? e)}`;
        for (const id of writtenIds) {
          results.push({ odooCountLineId: id, sku: skuByLineId[id] ?? '', found: true, qtySystem: null, qtyCounted: 0, diff: null, ok: false, error: msg });
        }
        return { ok: true, lines: results };
      }
    }

    const finalRows = await odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'read', [writtenIds],
      { fields: ['id', 'theoretical_qty', 'counted_qty', 'diff_qty', 'target_qty', 'applied_qty', 'state', 'product_id'] });
    for (const r of finalRows) {
      const diff = Number(r.diff_qty ?? 0);
      const applied = Number(r.applied_qty ?? 0);
      // a line with a real difference that Odoo did not apply = NOT a success
      const notApplied = applyToStock && Math.abs(diff) > 1e-9 && Math.abs(applied) < 1e-9;
      results.push({
        odooCountLineId: r.id,
        sku: r.product_id?.[1] ?? '',
        found: true,
        qtySystem: Number(r.theoretical_qty ?? 0),
        qtyCounted: Number(r.counted_qty ?? 0),
        diff,
        ok: !notApplied,
        ...(notApplied ? { error: `Écart ${diff} non appliqué sur Odoo (appliqué : ${applied})` } : {}),
      });
    }
    return { ok: true, lines: results };
  } catch (e: any) {
    return { ok: false, lines: [], error: String(e?.message ?? e) };
  }
}

export interface LabStockQuant { sku: string; name: string; qty: number }

// Read-only WIDE snapshot: every product carrying a default_code (SKU) present in stock.quant at
// a given location, in 2 Odoo calls total (all quants at the location, then one product read for
// the codes). `includeArchived` reads with `active_test: false` so a product discontinued in
// Odoo's catalogue but still physically in stock somewhere (shop official inventory, 2026-09-22 —
// Axel: "si un produit est archivé sur odoo mais en stock au magasin on fait comment ?") still
// shows up instead of silently vanishing from the count list.
export async function getAllStockQuantsAtLocation(locationId: number, includeArchived = false): Promise<LabStockQuant[]> {
  const quants = await odooExecute<any[]>('stock.quant', 'search_read',
    [[['location_id', '=', locationId]]], { fields: ['product_id', 'quantity'], limit: 5000 });
  const qtyByProductId: Record<number, number> = {};
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    if (pid) qtyByProductId[pid] = (qtyByProductId[pid] ?? 0) + Number(q.quantity ?? 0);
  }
  const ids = Object.keys(qtyByProductId).map(Number);
  const prods = ids.length ? await odooExecute<any[]>('product.product', 'read', [ids],
    { fields: ['default_code', 'name'], context: includeArchived ? { active_test: false } : {} }) : [];
  return prods
    .filter(pr => pr.default_code)
    .map(pr => ({ sku: pr.default_code as string, name: pr.name as string, qty: qtyByProductId[pr.id] ?? 0 }));
}

// Powers the stock checks and the /analytics stock views (2026-09-02) — one shared read per Check
// run instead of one per consumer (Axel: "il faut que ce soit optimisé").
// limit 5000: ~1210 quants today; the cap only exists so a runaway location can't blow the
// payload — revisit if LAB/Stock ever legitimately approaches it.
export async function getLabStockAllQuants(): Promise<LabStockQuant[]> {
  const locationId = await getLabStockLocationId();
  return getAllStockQuantsAtLocation(locationId);
}

// ── Shop official (monthly) inventory: ONE grouped cut-off covering every SKU at once ──────────
//
// The lab's per-SKU cut-off (ensureInventoryLineStarted above) opens one small Odoo record per
// SKU, lazily, the moment that SKU is first typed — fine for a free-entry session. The shops'
// monthly official inventory is different on purpose (Axel, 2026-09-22): "si ils comptent pas
// [un produit], c'est que c'est 0" — every active SKU of the shop's warehouse must be in the count
// from the start, uncounted ones defaulting to 0 and genuinely pushed as 0 to Odoo. That means the
// theoretical cut-off has to be frozen for the WHOLE catalogue at once, right when the session
// starts — so this opens a single `stock.inventory` covering every SKU in one Odoo call, instead
// of looping ensureInventoryLineStarted per SKU (which would be N Odoo round-trips for one click).
export interface GroupedCutoffLine { sku: string; odooCountLineId: number; qtyTheoretical: number; }
export interface GroupedCutoffResult { ok: boolean; odooInventoryId?: number; lines?: GroupedCutoffLine[]; error?: string; }

/**
 * Opens ONE `stock.inventory` covering `productIds` (already resolved) at `locationId`, freezes
 * every product's theoretical_qty in a single `action_state_to_in_progress` call, and returns each
 * SKU's fresh count-line id + theoretical qty. Never reuses an existing Odoo record — the caller
 * (the shop's own `lab_shop_official_inventory_sessions` row) is the sole source of truth for
 * "is this month's session already open", so there is no Odoo-side search to get wrong across
 * shops/months the way the LAB per-SKU path has to guard against.
 */
export async function startGroupedInventoryCutoff(
  locationId: number,
  products: { sku: string; id: number }[],
  label: string,
): Promise<GroupedCutoffResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  if (!products.length) return { ok: false, error: 'Aucun produit à geler' };

  // 2026-09-30 fix (first real run, Timecity): a failure AFTER the Odoo freeze left an orphaned
  // in_progress stock.inventory with no app session, and every retry was then refused by Odoo
  // ("There are active adjustments for the requested products"). Two guards now:
  //  1. ADOPT: if an in_progress adjustment with this exact label already exists on this location
  //     (an earlier attempt that died before the app saved its session), reuse it instead of
  //     creating a second one — same frozen T0, no duplicate cut-off.
  //  2. ROLLBACK: if anything fails after THIS call created the adjustment, cancel it so the next
  //     attempt starts clean.
  // All reads go through the write account (the one that created the record) — the read-only
  // account was never exercised against stock.inventory / lpr.stock.inventory.line in production.
  let invId: number | null = null;
  let createdHere = false;
  try {
    const existing = await odooExecuteWrite<any[]>('stock.inventory', 'search_read',
      [[['state', '=', 'in_progress'], ['name', '=', label], ['location_ids', 'in', [locationId]]]],
      { fields: ['id'], limit: 1, order: 'id desc' });
    if (existing.length) {
      invId = existing[0].id as number;
    } else {
      invId = await odooExecuteWrite<number>('stock.inventory', 'create', [{
        name: label,
        product_selection: 'manual',
        product_ids: [[6, 0, products.map(p => p.id)]],
        location_ids: [[6, 0, [locationId]]],
      }], { context: NO_MAIL_CONTEXT });
      createdHere = true;
      try {
        await odooExecuteWrite('stock.inventory', 'action_state_to_in_progress', [[invId]], { context: NO_MAIL_CONTEXT });
      } catch (e: any) {
        try { await odooExecuteWrite('stock.inventory', 'unlink', [[invId]], {}); } catch { /* best-effort */ }
        invId = null;
        throw e;
      }
    }

    const readRows = async () => {
      const [inv] = await odooExecuteWrite<any[]>('stock.inventory', 'search_read',
        [[['id', '=', invId]]], { fields: ['count_line_ids'] });
      const lineIds: number[] = inv?.count_line_ids ?? [];
      if (!lineIds.length) return [] as any[];
      return odooExecuteWrite<any[]>('lpr.stock.inventory.line', 'search_read',
        [[['id', 'in', lineIds]]], { fields: ['id', 'product_id', 'theoretical_qty'], limit: lineIds.length });
    };
    let rows = await readRows();
    // products whose quant is 0 got no line from the module — add them (a shop's uncounted product
    // must still be on the list and pushed as counted)
    const withLine = new Set(rows.map(r => (Array.isArray(r.product_id) ? r.product_id[0] : r.product_id) as number));
    const missing = products.map(p => p.id).filter(id => !withLine.has(id));
    if (missing.length) {
      await addMissingCountLines(invId as number, locationId, missing);
      rows = await readRows();
    }
    if (!rows.length) throw new Error('Aucune ligne de comptage générée sur Odoo (cut-off)');
    const skuByProductId: Record<number, string> = {};
    for (const p of products) skuByProductId[p.id] = p.sku;
    const lines: GroupedCutoffLine[] = rows.map(r => {
      const pid = Array.isArray(r.product_id) ? r.product_id[0] : r.product_id;
      return { sku: skuByProductId[pid] ?? '', odooCountLineId: r.id, qtyTheoretical: Number(r.theoretical_qty ?? 0) };
    }).filter(l => l.sku);
    if (!lines.length) throw new Error('Aucune ligne de comptage reconnue (SKU) sur Odoo (cut-off)');
    return { ok: true, odooInventoryId: invId as number, lines };
  } catch (e: any) {
    console.error('[official-inventory] startGroupedInventoryCutoff failed', { locationId, label, invId, createdHere, error: String(e?.message ?? e) });
    if (createdHere && invId) await tryCancelInventoryLine(invId);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Resolve product.product ids by default_code, including archived products (same reasoning as
 *  getAllStockQuantsAtLocation's includeArchived — a shop's catalogue list must never silently
 *  drop a product just because it was discontinued in Odoo while stock remains in the shop). */
export async function resolveProductsBySkuIncludingArchived(skus: string[]): Promise<Record<string, { id: number; name: string }>> {
  if (!skus.length) return {};
  const prods = await odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code'], limit: 2000, context: { active_test: false } });
  const map: Record<string, { id: number; name: string }> = {};
  for (const p of prods) if (p.default_code) map[p.default_code] = { id: p.id, name: p.name };
  return map;
}

export interface LabStockLevel { sku: string; name: string; qty: number; found: boolean; }

// Read-only current on-hand at LAB/Stock for a list of SKUs — same lookup as before, just without
// the write/diff half. Used by the station analytics tab (2026-08-21) to show a chef their team's
// finished-goods stock at a glance. Never writes anything to Odoo.
export async function getLabStockLevels(skus: string[]): Promise<LabStockLevel[]> {
  if (!skus.length) return [];
  const locationId = await getLabStockLocationId();
  const productBySku = await resolveProductsBySku(skus);
  const foundIds = Object.values(productBySku).map(p => p.id);

  const quants = foundIds.length ? await odooExecute<any[]>('stock.quant', 'search_read',
    [[['product_id', 'in', foundIds], ['location_id', '=', locationId]]],
    { fields: ['product_id', 'quantity'] }) : [];
  const qtyByProductId: Record<number, number> = {};
  for (const q of quants) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    qtyByProductId[pid] = (qtyByProductId[pid] ?? 0) + Number(q.quantity ?? 0);
  }

  return skus.map(sku => {
    const prod = productBySku[sku];
    if (!prod) return { sku, name: sku, qty: 0, found: false };
    return { sku, name: prod.name, qty: qtyByProductId[prod.id] ?? 0, found: true };
  });
}
