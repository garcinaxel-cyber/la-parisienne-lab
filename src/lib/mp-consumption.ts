// Recursive raw-material resolution from Odoo nomenclatures (BOM), used by the "Consommation
// matières premières" admin report (2026-09-17, Axel: par SKU de MP sur une période, sans
// dépendre de l'historique de fiabilité des MO — voir /admin/consommation-mp/actions.ts).
//
// Beaucoup de nomenclatures sont à plusieurs niveaux (ex. [BBC1] Bánh Croissant -> [1542-MH-0066]
// SM-Croissant Base -> farine/beurre/...) — on descend récursivement via mrp.bom.line.child_bom_id
// jusqu'aux matières premières réelles (lignes sans child_bom_id).
//
// Perf/coût Odoo : tout est fait en requêtes PAR LOT (jamais un appel par SKU produit), avec la
// nomenclature entière mise en cache en mémoire pour la durée du calcul — un rapport sur des
// centaines de SKU produits ne fait qu'une poignée d'appels Odoo au total (un par niveau de
// nomenclature rencontré, pas un par produit fini). Lecture seule (compte Odoo par défaut).
import { odooExecute } from './odoo';

export type RawMaterialLine = { code: string; name: string; uom: string; qtyPerUnit: number };

const MAX_BOM_DEPTH = 8; // garde-fou anti-boucle sur une nomenclature mal formée

// "[CODE] Nom du produit" -> { code, name }. Odoo renvoie ses many2one sous cette forme
// (display_name) pour product_id/product_uom_id/etc. quand le produit a un default_code.
function splitCodeName(display: string | false | undefined): { code: string | null; name: string } {
  if (!display) return { code: null, name: '' };
  const m = /^\[(.+?)\]\s*(.*)$/.exec(display);
  if (m) return { code: m[1], name: m[2] || m[1] };
  return { code: null, name: display };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function searchReadChunked<T = any>(
  model: string, domainField: string, ids: (string | number)[], fields: string[], extraDomain: any[] = [],
): Promise<T[]> {
  if (ids.length === 0) return [];
  const out: T[] = [];
  for (const part of chunk(ids, 200)) {
    const rows = await odooExecute<T[]>(model, 'search_read',
      [[...extraDomain, [domainField, 'in', part]]], { fields });
    out.push(...rows);
  }
  return out;
}

/**
 * Résout, pour une liste de SKU produits finis (default_code Odoo), la liste des matières
 * premières réelles (feuilles de nomenclature) et la quantité par unité produite — en
 * descendant récursivement dans les semi-finis. Tout par lot, jamais un appel Odoo par SKU.
 *
 * Retourne null pour un SKU sans nomenclature trouvée (produit non fabriqué / pas de BOM) —
 * le rapport appelant doit surfacer ça plutôt que le faire disparaître silencieusement.
 */
export async function resolveRawMaterialsBatch(skus: string[]): Promise<{
  bySku: Map<string, RawMaterialLine[] | null>;
}> {
  const distinctSkus = Array.from(new Set(skus.filter(Boolean)));
  const bySku = new Map<string, RawMaterialLine[] | null>();
  if (distinctSkus.length === 0) return { bySku };

  // 1) SKU -> produit Odoo (id + template, pour le fallback nomenclature au niveau modèle)
  const products = await searchReadChunked<{ id: number; default_code: string; product_tmpl_id: [number, string] }>(
    'product.product', 'default_code', distinctSkus, ['id', 'default_code', 'product_tmpl_id']);
  const productBySku = new Map(products.map(p => [p.default_code, p]));
  const productIds = products.map(p => p.id);
  const tmplIds = Array.from(new Set(products.map(p => p.product_tmpl_id?.[0]).filter(Boolean)));

  // 2) Nomenclature top-level par produit (variante), puis fallback par modèle pour les produits
  // sans BOM propre à leur variante (nomenclature définie une fois pour tout le template).
  const bomsByProduct = await searchReadChunked<{ id: number; product_id: [number, string]; product_qty: number }>(
    'mrp.bom', 'product_id', productIds, ['id', 'product_id', 'product_qty']);
  const bomIdByProductId = new Map<number, number>();
  for (const b of bomsByProduct) if (b.product_id) bomIdByProductId.set(b.product_id[0], b.id);

  const productIdsWithoutBom = productIds.filter(id => !bomIdByProductId.has(id));
  const tmplIdsToCheck = Array.from(new Set(
    products.filter(p => productIdsWithoutBom.includes(p.id)).map(p => p.product_tmpl_id?.[0]).filter(Boolean),
  ));
  if (tmplIdsToCheck.length) {
    const tmplBoms = await searchReadChunked<{ id: number; product_tmpl_id: [number, string]; product_qty: number }>(
      'mrp.bom', 'product_tmpl_id', tmplIdsToCheck, ['id', 'product_tmpl_id', 'product_qty'], [['product_id', '=', false]]);
    const bomIdByTmplId = new Map(tmplBoms.map(b => [b.product_tmpl_id[0], b.id]));
    for (const p of products) {
      if (!bomIdByProductId.has(p.id) && p.product_tmpl_id) {
        const tmplBomId = bomIdByTmplId.get(p.product_tmpl_id[0]);
        if (tmplBomId) bomIdByProductId.set(p.id, tmplBomId);
      }
    }
  }

  // 3) Parcours en largeur des lignes de nomenclature, par lot à chaque niveau, jusqu'aux feuilles.
  const bomLinesByBomId = new Map<number, any[]>();
  const bomQtyByBomId = new Map<number, number>();
  for (const b of bomsByProduct) bomQtyByBomId.set(b.id, b.product_qty || 1);

  let frontier = Array.from(new Set(bomIdByProductId.values()));
  const seen = new Set<number>();
  let depth = 0;
  while (frontier.length && depth < MAX_BOM_DEPTH) {
    const level = frontier.filter(id => !seen.has(id));
    if (!level.length) break;
    level.forEach(id => seen.add(id));

    const lines = await searchReadChunked<any>('mrp.bom.line', 'bom_id', level,
      ['bom_id', 'product_id', 'product_qty', 'product_uom_id', 'child_bom_id']);
    for (const l of lines) {
      const bomId = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id;
      if (!bomLinesByBomId.has(bomId)) bomLinesByBomId.set(bomId, []);
      bomLinesByBomId.get(bomId)!.push(l);
    }

    const childBomIds = Array.from(new Set(lines.filter(l => l.child_bom_id).map(l => l.child_bom_id[0] as number)));
    if (childBomIds.length) {
      const childBoms = await searchReadChunked<{ id: number; product_qty: number }>(
        'mrp.bom', 'id', childBomIds, ['id', 'product_qty']);
      for (const cb of childBoms) bomQtyByBomId.set(cb.id, cb.product_qty || 1);
    }
    frontier = childBomIds;
    depth++;
  }

  // 4) Aplatissement récursif en mémoire (aucun appel Odoo ici) — cache par bom_id, garde-fou
  // anti-cycle via `visiting`.
  const flatCache = new Map<number, RawMaterialLine[]>();
  function flatten(bomId: number, visiting: Set<number>): RawMaterialLine[] {
    if (flatCache.has(bomId)) return flatCache.get(bomId)!;
    if (visiting.has(bomId)) return []; // nomenclature cyclique — ne devrait pas arriver, on ignore
    visiting.add(bomId);
    const lines = bomLinesByBomId.get(bomId) ?? [];
    const batchQty = bomQtyByBomId.get(bomId) || 1;
    const acc = new Map<string, RawMaterialLine>();
    for (const line of lines) {
      const ratio = (line.product_qty || 0) / batchQty; // quantité de cette ligne pour 1 unité produite
      if (line.child_bom_id) {
        const childBomId = line.child_bom_id[0] as number;
        const sub = flatten(childBomId, visiting);
        for (const s of sub) {
          const existing = acc.get(s.code);
          const qty = s.qtyPerUnit * ratio;
          if (existing) existing.qtyPerUnit += qty;
          else acc.set(s.code, { ...s, qtyPerUnit: qty });
        }
        continue;
      }
      const { code, name } = splitCodeName(line.product_id?.[1]);
      if (!code) continue;
      const uom = splitCodeName(line.product_uom_id?.[1]).name || (line.product_uom_id?.[1] ?? '');
      const existing = acc.get(code);
      if (existing) existing.qtyPerUnit += ratio;
      else acc.set(code, { code, name, uom, qtyPerUnit: ratio });
    }
    visiting.delete(bomId);
    const result = Array.from(acc.values());
    flatCache.set(bomId, result);
    return result;
  }

  for (const sku of distinctSkus) {
    const product = productBySku.get(sku);
    const bomId = product ? bomIdByProductId.get(product.id) : undefined;
    if (!product || !bomId) { bySku.set(sku, null); continue; }
    bySku.set(sku, flatten(bomId, new Set()));
  }

  return { bySku };
}
