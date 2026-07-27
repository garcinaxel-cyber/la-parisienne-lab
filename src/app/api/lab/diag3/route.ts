import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// TEMP diag — inspect a product's production cards + stock transfers across recent days, to
// explain why an already-produced/stocked item reappears as "to produce". ?q=matcha&team=hung
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || 'matcha';
  const team = url.searchParams.get('team') || 'hung';

  const { data: asg } = await supabase.from('lab_assignments')
    .select('id, product_name_vi, variant_label, team, total_qty, qty_produced, status, cancelled, is_extra, produced_ahead, produced_by_name, produced_at, transferred, breakdown, import_id, lab_imports!inner(delivery_date, status, type, order_number)')
    .eq('team', team).ilike('product_name_vi', `%${q}%`)
    .order('id', { ascending: false }).limit(60);

  const cards = (asg ?? []).map((a: any) => ({
    product: a.product_name_vi, variant: a.variant_label,
    delivery_date: a.lab_imports?.delivery_date, import: `${a.lab_imports?.type} #${a.lab_imports?.order_number} (${a.lab_imports?.status})`,
    total_qty: a.total_qty, qty_produced: a.qty_produced, status: a.status,
    cancelled: a.cancelled, is_extra: a.is_extra, produced_ahead: a.produced_ahead,
    produced_by: a.produced_by_name, produced_at: a.produced_at, transferred: a.transferred,
    refs: (Array.isArray(a.breakdown) ? a.breakdown : []).map((b: any) => `${b.order_ref}:${b.qty}`),
  }));

  // Stock transfers of this product (recent)
  const { data: tlines } = await supabase.from('lab_stock_transfer_lines')
    .select('sku, product_name_vi, qty_sent, qty_received, transfer_id, lab_stock_transfers!inner(team, created_at, status, created_by_name)')
    .ilike('product_name_vi', `%${q}%`).limit(60);
  const transfers = (tlines ?? [])
    .filter((l: any) => l.lab_stock_transfers?.team === team)
    .map((l: any) => ({ product: l.product_name_vi, sku: l.sku, qty_sent: l.qty_sent, qty_received: l.qty_received, at: l.lab_stock_transfers?.created_at, by: l.lab_stock_transfers?.created_by_name, status: l.lab_stock_transfers?.status }));

  return NextResponse.json({ q, team, cards_count: cards.length, cards, transfers_count: transfers.length, transfers });
}
