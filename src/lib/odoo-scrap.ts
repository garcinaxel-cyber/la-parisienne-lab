// Server-only: shop-side daily product-loss recording -> Odoo stock.scrap.
// Axel, 2026-08-21: chaque boutique doit pouvoir enregistrer ses pertes quotidiennes avec une
// raison. Point critique explicite: le lieu de destruction est le SHOP, jamais le LAB — ce
// module ne touche donc JAMAIS LAB/Stock, uniquement l'entrepôt Odoo propre à la boutique
// (résolu dynamiquement via son warehouseCode, jamais un id en dur).
//
// Only the 4 La Paris-owned shops (Tây Hồ, Long Biên, Bà Triệu, Timecity) have their own Odoo
// warehouse (SHOP_ODOO_MAP.warehouseCode) — Moon Flower is an external client (sale.order
// partner, not a La Paris warehouse) and has none, so it's deliberately NOT eligible for this
// feature. resolveShopWarehouseLocation() returns null for any shop without a warehouseCode,
// and callers must treat that as "not available for this shop", never fall back to LAB.
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from './odoo';
import { SHOP_ODOO_MAP } from './odoo-shop-order-sync';

function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export interface ShopWarehouseLocation { locationId: number; warehouseName: string; }

const shopLocationCache = new Map<string, ShopWarehouseLocation | null>();

/** Resolve a shop's OWN stock location (never LAB/Stock) via its Odoo warehouse code. */
export async function resolveShopWarehouseLocation(shopName: string): Promise<ShopWarehouseLocation | null> {
  if (shopLocationCache.has(shopName)) return shopLocationCache.get(shopName)!;
  const code = SHOP_ODOO_MAP[shopName]?.warehouseCode;
  if (!code) { shopLocationCache.set(shopName, null); return null; }
  const whs = await tmo(odooExecute<any[]>('stock.warehouse', 'search_read',
    [[['code', '=', code]]], { fields: ['lot_stock_id', 'name'], limit: 1 }), 15000, 'shop warehouse');
  const wh = whs[0];
  if (!wh?.lot_stock_id) { shopLocationCache.set(shopName, null); return null; }
  const result: ShopWarehouseLocation = {
    locationId: Array.isArray(wh.lot_stock_id) ? wh.lot_stock_id[0] : wh.lot_stock_id,
    warehouseName: wh.name,
  };
  shopLocationCache.set(shopName, result);
  return result;
}

// scrap_location_id is REQUIRED on stock.scrap but has no default_get value (confirmed
// 2026-08-21 via the debug route). Odoo scrap locations are virtual (usage='inventory',
// scrap_location=true) — this instance has exactly ONE, company-wide, not per-warehouse
// (id 16, "Virtual Locations/Scrap"). This is just the write-off/destination sink, same one
// LAB's own scrap (if any) would use — it does NOT compromise the "source must be the shop's
// own warehouse, never LAB" rule, which is enforced by location_id (source), not this field.
let cachedDefaultScrapLocationId: number | null = null;

export async function resolveDefaultScrapLocationId(): Promise<number | null> {
  if (cachedDefaultScrapLocationId !== null) return cachedDefaultScrapLocationId;
  const rows = await tmo(odooExecute<any[]>('stock.location', 'search_read',
    [[['scrap_location', '=', true]]], { fields: ['id'], limit: 1 }), 15000, 'default scrap location');
  const id = rows[0]?.id ?? null;
  cachedDefaultScrapLocationId = id;
  return id;
}

export interface ScrapReasonTag { id: number; name: string; }
let cachedReasonTags: ScrapReasonTag[] | null = null;

/** Read-only list of stock.scrap.reason.tag records for the shop's reason picker. */
export async function getScrapReasonTags(): Promise<ScrapReasonTag[]> {
  if (cachedReasonTags) return cachedReasonTags;
  const rows = await tmo(odooExecute<any[]>('stock.scrap.reason.tag', 'search_read',
    [[]], { fields: ['id', 'name'], limit: 200 }), 15000, 'scrap reason tags');
  cachedReasonTags = rows.map((r: any) => ({ id: r.id, name: r.name }));
  return cachedReasonTags;
}

/** Read-only diagnostic — introspects stock.scrap's real fields before we rely on any of them. */
export async function inspectScrapFields(): Promise<{ fields: Record<string, any>; sampleDefaults: any }> {
  const fields = await tmo(odooExecute<Record<string, any>>('stock.scrap', 'fields_get',
    [], { attributes: ['string', 'type', 'required', 'relation'] }), 15000, 'scrap fields_get');
  const sampleDefaults = await tmo(odooExecute<any>('stock.scrap', 'default_get',
    [Object.keys(fields)]), 15000, 'scrap default_get');
  return { fields, sampleDefaults };
}

/** Read-only diagnostic — scrap_location_id is required on stock.scrap but has no default_get
 * value (confirmed 2026-08-21). Odoo scrap locations are virtual (usage='inventory') and
 * typically ONE per company (not per warehouse) unless a custom setup added more — listing every
 * such location so the right one(s) can be identified before createShopScrap() sets it. */
export async function inspectScrapLocations(): Promise<any[]> {
  return tmo(odooExecute<any[]>('stock.location', 'search_read',
    [[['scrap_location', '=', true]]], { fields: ['id', 'name', 'complete_name', 'usage', 'warehouse_id', 'company_id'], limit: 200 }),
    15000, 'scrap locations');
}

/** Batch-resolve product.product ids by SKU (default_code) — same pattern as odoo-inventory.ts. */
export async function resolveProductsBySku(skus: string[]): Promise<Record<string, { id: number; name: string; uom_id: number }>> {
  if (!skus.length) return {};
  const rows = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['default_code', 'in', skus]]], { fields: ['id', 'name', 'default_code', 'uom_id'], limit: 2000 }), 20000, 'scrap products');
  const out: Record<string, { id: number; name: string; uom_id: number }> = {};
  for (const p of rows) if (p.default_code) out[p.default_code] = { id: p.id, name: p.name, uom_id: Array.isArray(p.uom_id) ? p.uom_id[0] : p.uom_id };
  return out;
}

export interface CreateShopScrapInput {
  shopName: string;
  productId: number;
  uomId: number;
  qty: number;
  reasonTagIds: number[];
  origin: string;
}

export interface CreateShopScrapResult {
  ok: boolean;
  scrapId?: number;
  error?: string;
}

/** Creates AND validates a stock.scrap at the shop's own warehouse — never LAB. */
export async function createShopScrap(input: CreateShopScrapInput): Promise<CreateShopScrapResult> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Compte Odoo en écriture non configuré' };
  const loc = await resolveShopWarehouseLocation(input.shopName);
  if (!loc) return { ok: false, error: `Aucun entrepôt Odoo configuré pour "${input.shopName}" — perte non enregistrée sur Odoo` };
  const scrapLocationId = await resolveDefaultScrapLocationId();
  if (!scrapLocationId) return { ok: false, error: 'Aucun emplacement de rebut (scrap) trouvé sur Odoo' };

  try {
    const scrapId = await odooExecuteWrite<number>('stock.scrap', 'create', [{
      product_id: input.productId,
      product_uom_id: input.uomId,
      scrap_qty: input.qty,
      location_id: loc.locationId,
      scrap_location_id: scrapLocationId,
      scrap_reason_tag_ids: [[6, 0, input.reasonTagIds]],
      origin: input.origin,
    }]);
    await odooExecuteWrite('stock.scrap', 'action_validate', [[scrapId]]);
    return { ok: true, scrapId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
