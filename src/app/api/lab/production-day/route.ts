import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { fetchDoneForProdDate } from '@/lib/production-days';

export const dynamic = 'force-dynamic';

// Detail of one production day: per-product breakdown of what was physically produced that day
// (grouped by produced_at). Used by the click-to-expand on the production-history page.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const date = new URL(req.url).searchParams.get('date');
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

  const cards = await fetchDoneForProdDate(supabase, date);

  // SKU per variant (for display)
  const vids = Array.from(new Set(cards.map(c => c.variant_id).filter(Boolean))) as string[];
  const { data: variants } = vids.length
    ? await supabase.from('lab_fiche_variants').select('id, sku').in('id', vids)
    : { data: [] as any[] };
  const skuByV: Record<string, string> = {};
  for (const v of variants ?? []) if (v.sku) skuByV[v.id] = v.sku;

  // Aggregate per product (name + variant + team), summing produced qty
  const map = new Map<string, any>();
  for (const c of cards) {
    const sku = c.variant_id ? skuByV[c.variant_id] ?? null : null;
    const key = `${c.team}||${c.variant_label}||${c.product_name_vi}`;
    const qty = (c.qty_produced && c.qty_produced > 0) ? c.qty_produced : (c.total_qty ?? 0);
    const cur = map.get(key) ?? {
      product: c.product_name_vi, variant: c.variant_label, team: c.team, sku,
      qty: 0, is_extra: false, produced_ahead: false, delivery_date: c.lab_imports?.delivery_date ?? null,
    };
    cur.qty += qty;
    if (c.is_extra) cur.is_extra = true;
    if (c.produced_ahead) cur.produced_ahead = true;
    map.set(key, cur);
  }
  const items = Array.from(map.values()).sort((a, b) =>
    (a.team ?? '').localeCompare(b.team ?? '') || a.product.localeCompare(b.product));

  return NextResponse.json({
    date,
    total_pieces: items.reduce((s, i) => s + i.qty, 0),
    products: items.length,
    items,
  });
}
