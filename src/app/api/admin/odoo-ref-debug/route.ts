import { NextResponse } from 'next/server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Diagnostic READ-ONLY route (2026-09-03) — pour trancher un désaccord entre le cross-check
// doneOnOdoo de l'app (crossCheckOdooDone, checks.ts) et une lecture manuelle d'Axel sur Odoo
// (REP/2026/01284 : app dit "fait", Axel dit "pas fait"). Détaille chaque picking lié à la
// référence (état + quantités demandées/faites par move) au lieu du seul état agrégé. Même
// secret que les crons (CRON_SECRET), aucune écriture.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const ref = url.searchParams.get('ref');
  if (!ref) return NextResponse.json({ error: 'missing ?ref=' }, { status: 400 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });

  try {
    let pickingIds: number[] = [];
    let source: any = null;
    if (ref.startsWith('REP')) {
      const reps = await odooExecute<any[]>('stock.replenishment.request', 'search_read',
        [[['name', '=', ref]]], { fields: ['id', 'name', 'state', 'delivery_picking_ids'] });
      source = reps[0] ?? null;
      pickingIds = source?.delivery_picking_ids ?? [];
    } else {
      const sos = await odooExecute<any[]>('sale.order', 'search_read',
        [[['name', '=', ref]]], { fields: ['id', 'name', 'state', 'picking_ids', 'invoice_status'] });
      source = sos[0] ?? null;
      pickingIds = source?.picking_ids ?? [];
    }
    if (!source) return NextResponse.json({ error: 'ref not found on Odoo', ref });

    const pickings = pickingIds.length
      ? await odooExecute<any[]>('stock.picking', 'read', [pickingIds],
          { fields: ['id', 'name', 'state', 'scheduled_date', 'date_done', 'origin', 'backorder_id'] })
      : [];
    // Champ "quantité livrée" pas garanti stable d'une version Odoo à l'autre (quantity_done vs
    // quantity) — sûr en base (déjà utilisé ailleurs dans le repo) + best-effort en plus.
    const moveIds = pickings.length
      ? await odooExecute<any[]>('stock.move', 'search_read',
          [[['picking_id', 'in', pickingIds]]],
          { fields: ['id', 'picking_id', 'product_id', 'product_uom_qty', 'state'] })
      : [];
    let moveQtyFields: Record<number, any> = {};
    if (moveIds.length) {
      for (const candidate of ['quantity_done', 'quantity']) {
        try {
          const extra = await odooExecute<any[]>('stock.move', 'read',
            [moveIds.map((m: any) => m.id)], { fields: [candidate] });
          for (const e of extra) (moveQtyFields[e.id] ??= {})[candidate] = e[candidate];
        } catch { /* champ absent sur cette version — ignoré */ }
      }
    }
    const moves = moveIds.map((m: any) => ({ ...m, ...moveQtyFields[m.id] }));

    return NextResponse.json({ ref, source, pickings, moves });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
