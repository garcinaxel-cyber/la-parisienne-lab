import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ReceptionView from './ReceptionView';

export const revalidate = 0;

export default async function ReceptionPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  // Pending notes (to receive) + recently received ones (history)
  const [{ data: pending }, { data: history }] = await Promise.all([
    supabase.from('lab_stock_transfers')
      .select('id, team, created_by_name, created_at, status')
      .eq('status', 'pending').order('created_at', { ascending: false }).limit(100),
    supabase.from('lab_stock_transfers')
      .select('id, team, created_by_name, created_at, status, received_by_name, received_at')
      .eq('status', 'received').order('received_at', { ascending: false }).limit(200),
  ]);

  const allTransfers = [...(pending ?? []), ...(history ?? [])];
  const ids = allTransfers.map(t => t.id);
  // Read by chunks of 50 notes, page by page (Supabase caps a request at 1000 rows).
  const lines: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    for (let f = 0; ; f += 1000) {
      const { data } = await supabase.from('lab_stock_transfer_lines')
        .select('id, transfer_id, assignment_id, product_name_vi, product_name_en, sku, variant_label, image_url, qty_sent, qty_received, discrepancy_reason, discrepancy_note')
        .in('transfer_id', ids.slice(i, i + 50)).order('id').range(f, f + 999);
      lines.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }

  const linesByTransfer: Record<string, any[]> = {};
  for (const l of lines ?? []) (linesByTransfer[l.transfer_id] ??= []).push(l);

  // Only EXTRA production is received here (Axel, 2026-10-24) — list and history. Made-to-order
  // products are received automatically when the chef sends them (station stock-actions.ts).
  const aids = Array.from(new Set((lines ?? []).map((l: any) => l.assignment_id).filter(Boolean)));
  const extraIds = new Set<string>();
  for (let i = 0; i < aids.length; i += 300) {
    const { data } = await supabase.from('lab_assignments').select('id').in('id', aids.slice(i, i + 300)).eq('is_extra', true);
    for (const a of data ?? []) extraIds.add(a.id);
  }
  const hasExtra = (t: any) => (linesByTransfer[t.id] ?? []).some((l: any) => extraIds.has(l.assignment_id));
  const withLines = (t: any) => ({ ...t, lines: (linesByTransfer[t.id] ?? []).filter((l: any) => extraIds.has(l.assignment_id)) });

  return <ReceptionView bons={(pending ?? []).filter(hasExtra).map(withLines)} history={(history ?? []).filter(hasExtra).map(withLines)} />;
}
