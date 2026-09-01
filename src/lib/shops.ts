// SINGLE SOURCE OF TRUTH for the group's own shops as this app names them (2026-09-01).
//
// Before this file the same list lived in 4 places, each a hand-typed copy with a "keep in
// sync" comment: SHOP_ODOO_MAP (odoo-shop-order-sync.ts), SHOPS (order/[token]/ShopOrderForm),
// DELIVERERS (exceptional-orders/ExceptionalOrdersView) and SHOP_NAMES (admin/shop-access).
// Adding a shop meant editing all four and hoping none was missed. Now: add ONE entry here.
//
// !! This file must stay PURE DATA with ZERO imports: it is imported by client components
// (ShopOrderForm, ExceptionalOrdersView). Any server import here (Odoo client, Supabase
// server, next/headers) would be pulled into the browser bundle and break those pages.
//
// Names: the KEY is the app-side display name -- it must match byte-for-byte what is stored
// in lab_profiles.shop_name (portal accounts) and lab_manual_cakes.shop_name (verified live
// 2026-09-01). partnerName / warehouseCode are the ODOO-side identifiers used to create
// documents (sale.order partner display name, stock.warehouse code) -- copy them exactly from
// Odoo, never "tidy" them (Axel, 2026-09-01: "fais attention à bien correspondre au nom Odoo").
//
// docType: quotation (sale.order) for external partners (Moon Flower, Lab itself);
// replenishment (stock.replenishment.request) for the La Paris shops (own warehouses).
// portalAccount: whether admin/shop-access may provision a shared login for this shop --
// deliberately an allowlist (Axel, 2026-08-19), NOT "every shop_name ever seen in an order".
export type ShopConfig = {
  docType: 'quotation' | 'replenishment';
  partnerName?: string;
  warehouseCode?: string;
  portalAccount: boolean;
};

export const SHOP_CONFIG: Record<string, ShopConfig> = {
  'Moon Flower':        { docType: 'quotation',     partnerName: 'MOON FLOWER', portalAccount: true },
  'Lab':                { docType: 'quotation',     partnerName: 'LAB',         portalAccount: false },
  'La Paris Tây Hồ':    { docType: 'replenishment', warehouseCode: 'LP',        portalAccount: true },
  'La Paris Long Biên': { docType: 'replenishment', warehouseCode: 'PARIS',     portalAccount: true },
  'La Paris Bà Triệu':  { docType: 'replenishment', warehouseCode: 'LPBT',      portalAccount: true },
  'La Paris Timecity':  { docType: 'replenishment', warehouseCode: 'LPTC',      portalAccount: true },
};

// Every shop the order form / exceptional orders can address (Moon Flower first, then Lab,
// then the La Paris shops -- the historical dropdown order).
export const SHOP_NAMES_ALL: string[] = Object.keys(SHOP_CONFIG);

// Shops that may get a shared portal login (admin/shop-access): everything except Lab itself.
export const PORTAL_SHOP_NAMES: string[] = SHOP_NAMES_ALL.filter(s => SHOP_CONFIG[s].portalAccount);
