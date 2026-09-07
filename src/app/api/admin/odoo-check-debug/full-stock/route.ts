import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { collectLabStockSnapshot, collectMtoExplanations, STOCK_CATEGORIES } from '@/lib/checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const snapshot = await collectLabStockSnapshot(supabase as any);
  if (snapshot.error) return NextResponse.json({ error: snapshot.error });

  // A. Every finished-good (app-tracked, fiche-backed) SKU currently negative, any category.
  const negative = snapshot.items.filter(i => i.qty < 0).sort((a, b) => a.qty - b.qty);

  // B. MTO (order-to-make) items: should sit at 0, or be explained by a recent stock-send
  // (<48h) or genuine upcoming demand (today/tomorrow's published orders).
  const mtoItems = snapshot.items.filter(i => !(i.category && STOCK_CATEGORIES.includes(i.category)) && i.qty !== 0);
  const { sent, upcoming } = await collectMtoExplanations(supabase as any, mtoItems.map(i => i.sku));
  const mto = mtoItems.map(i => {
    const s = sent[i.sku] ?? 0, u = upcoming[i.sku] ?? 0;
    const explained = i.qty === u || (i.qty > 0 && (s > 0 || u > 0)) || (i.qty < 0 && s > 0);
    return { sku: i.sku, name: i.name, category: i.category, qty: i.qty, sent48h: s, upcomingTomorrow: u, explained };
  }).sort((a, b) => (a.explained === b.explained ? 0 : a.explained ? 1 : -1) || Math.abs(b.qty) - Math.abs(a.qty));

  return NextResponse.json({ at: snapshot.at, negativeCount: negative.length, negative, mtoCount: mto.length, mtoUnexplained: mto.filter(m => !m.explained), mtoExplained: mto.filter(m => m.explained) });
}
