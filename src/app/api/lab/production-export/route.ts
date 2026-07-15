import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { createClient } from '@/lib/supabase-server';
import { odooConfigured, odooExecute } from '@/lib/odoo';

// End-of-day production export → Odoo "Quantity To Produce" template.
// Scope = everything in the chefs' "Done" tabs for the selected day:
//   status = 'done', not cancelled, ALL teams, INCLUDING extra production (is_extra).
// Aggregated to one row per SKU with the actually-produced quantity.
//
// The lab app's product names differ from Odoo's, so the export never relies on
// the app name: it resolves each SKU to Odoo's own product label + unit of measure
// via the read-only Odoo API, so the file imports cleanly (Odoo matches on the SKU
// embedded in its display name). READ-ONLY — this route never writes to Odoo.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const today = new Date().toISOString().split('T')[0];
  const date = (req.nextUrl.searchParams.get('date') || today).slice(0, 10);

  // 1) Done cards for the day (published imports only). Includes extra production.
  const { data: asg, error: asgErr } = await supabase
    .from('lab_assignments')
    .select('variant_id, product_name_vi, total_qty, qty_produced, status, cancelled, is_extra, lab_imports!inner(delivery_date,status)')
    .eq('lab_imports.status', 'published')
    .eq('lab_imports.delivery_date', date)
    .eq('status', 'done')
    .limit(2000);
  if (asgErr) return NextResponse.json({ error: asgErr.message }, { status: 500 });

  const done = (asg ?? []).filter((a: any) => !a.cancelled);

  // 2) Resolve variant_id → SKU
  const variantIds = Array.from(new Set(done.map((a: any) => a.variant_id).filter(Boolean))) as string[];
  const { data: variants } = variantIds.length
    ? await supabase.from('lab_fiche_variants').select('id, sku').in('id', variantIds)
    : { data: [] as any[] };
  const skuByVariant: Record<string, string> = {};
  for (const v of variants ?? []) if (v.sku) skuByVariant[v.id] = v.sku;

  // 3) Aggregate produced quantity per SKU (fallback name for cards with no SKU)
  const agg = new Map<string, { sku: string | null; appName: string; qty: number }>();
  for (const a of done) {
    const sku = a.variant_id ? skuByVariant[a.variant_id] ?? null : null;
    const key = sku ?? `__noSku__${a.product_name_vi}`;
    const qty = (a.qty_produced && a.qty_produced > 0) ? a.qty_produced : (a.total_qty ?? 0);
    const cur = agg.get(key);
    if (cur) cur.qty += qty;
    else agg.set(key, { sku, appName: a.product_name_vi ?? '', qty });
  }

  // 4) Real Odoo product NAME, matched by SKU (default_code). Read-only.
  // Odoo's import matches the product on its plain name, WITHOUT the [SKU] prefix,
  // so we take the `name` field (not display_name). The SKU is used only to look up
  // the right Odoo name — it never appears in the file.
  const skus = Array.from(agg.values()).map(r => r.sku).filter(Boolean) as string[];
  const nameBySku: Record<string, string> = {};
  if (skus.length && odooConfigured()) {
    try {
      const products: any[] = await odooExecute(
        'product.product', 'search_read',
        [[['default_code', 'in', skus]]],
        { fields: ['default_code', 'name'] },
      );
      for (const p of products ?? []) {
        if (p.default_code && p.name) nameBySku[p.default_code] = p.name;
      }
    } catch {
      // Odoo unreachable → fall back to the app name below; file still usable.
    }
  }

  // 5) Build rows: Product = Odoo product name (no SKU). Fallback = app name.
  const rows = Array.from(agg.values())
    .map(r => {
      const label = (r.sku && nameBySku[r.sku]) ? nameBySku[r.sku] : r.appName;
      return { label, qty: r.qty };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // 6) Excel with the exact Odoo import headers (Product matched by SKU, quantity produced)
  const aoa: (string | number)[][] = [
    ['Product', 'Quantity To Produce'],
    ...rows.map(r => [r.label, r.qty]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 48 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Production');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Production_${date}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
