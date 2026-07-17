import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// TEMP admin route. Two data fixes:
//  1. Charlotte Passion fiche variant SKUs — align to the REAL Odoo SKUs per size.
//  2. Publish the order lines of the 4 orders stuck at published=false on ?date (default today).
// Dry-run by default (shows Odoo reality + planned changes); ?commit=1 writes. Delete after use.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}
const sizeOf = (s: string) => (s.match(/D\d+/i)?.[0] ?? '').toUpperCase();

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

  // 1a. Odoo Charlotte Passion products (real SKUs per size)
  const odooProds = await tmo(odooExecute<any[]>('product.product', 'search_read',
    [[['name', 'ilike', 'Charlotte Passion']]], { fields: ['default_code', 'name'], limit: 200 }), 20000, 'odoo');
  const odooBySize: Record<string, string[]> = {};
  for (const p of odooProds) {
    if (!p.default_code) continue;
    const sz = sizeOf(p.name) || sizeOf(p.default_code);
    (odooBySize[sz] ??= []).push(p.default_code);
  }

  // 1b. Fiche variants (the birthday-cake Charlotte Passion fiche)
  const CP_FICHE = '6b5d9f78-d7c2-4de0-b709-cf9d33737e55';
  const { data: variants } = await supabase.from('lab_fiche_variants')
    .select('id, label, sku').eq('fiche_id', CP_FICHE).order('sort_order');
  const skuPlan: any[] = [];
  for (const v of variants ?? []) {
    const sz = sizeOf(v.label) || sizeOf(v.sku ?? '');
    const odooSkus = odooBySize[sz] ?? [];
    const correct = odooSkus.length === 1 ? odooSkus[0] : null; // only auto-fix when unambiguous
    skuPlan.push({
      variantId: v.id, label: v.label, currentSku: v.sku, size: sz,
      odooSkusForSize: odooSkus, willSet: correct && correct !== v.sku ? correct : null,
      ambiguous: odooSkus.length > 1,
    });
  }

  // 2. The stuck orders on `date`: lines where published is not true
  const { data: stuckLines } = await supabase.from('lab_order_lines')
    .select('id, order_ref, published').eq('delivery_date', date).neq('published', true);
  // include null (neq true also excludes null? in PG neq true keeps false but drops null) → fetch null too
  const { data: nullLines } = await supabase.from('lab_order_lines')
    .select('id, order_ref, published').eq('delivery_date', date).is('published', null);
  const allStuck = [...(stuckLines ?? []), ...(nullLines ?? [])];
  const stuckRefs = Array.from(new Set(allStuck.map((l: any) => l.order_ref)));

  if (!commit) {
    return NextResponse.json({
      dryRun: true, date,
      charlottePassion: { odooBySize, skuPlan },
      stuck: { refs: stuckRefs, lineCount: allStuck.length },
    });
  }

  // COMMIT
  const done: any = { skuFixed: [], published: 0 };
  for (const p of skuPlan) {
    if (p.willSet) {
      const { error } = await supabase.from('lab_fiche_variants').update({ sku: p.willSet }).eq('id', p.variantId);
      if (!error) done.skuFixed.push({ label: p.label, from: p.currentSku, to: p.willSet });
    }
  }
  if (allStuck.length) {
    const ids = allStuck.map((l: any) => l.id);
    const { error, count } = await supabase.from('lab_order_lines')
      .update({ published: true, published_at: new Date().toISOString(), published_by: session.user.id }, { count: 'exact' })
      .in('id', ids);
    if (!error) done.published = count ?? ids.length;
  }
  return NextResponse.json({ committed: true, date, done, stuckRefs });
}
