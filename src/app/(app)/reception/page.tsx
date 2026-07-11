import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ReceptionView from './ReceptionView';

export const revalidate = 0;

export default async function ReceptionPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
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
      .eq('status', 'received').order('received_at', { ascending: false }).limit(40),
  ]);

  const allTransfers = [...(pending ?? []), ...(history ?? [])];
  const ids = allTransfers.map(t => t.id);
  const { data: lines } = ids.length
    ? await supabase.from('lab_stock_transfer_lines')
        .select('id, transfer_id, product_name_vi, product_name_en, sku, variant_label, image_url, qty_sent, qty_received, discrepancy_reason, discrepancy_note')
        .in('transfer_id', ids)
    : { data: [] as any[] };

  const linesByTransfer: Record<string, any[]> = {};
  for (const l of lines ?? []) (linesByTransfer[l.transfer_id] ??= []).push(l);

  const withLines = (t: any) => ({ ...t, lines: linesByTransfer[t.id] ?? [] });

  return <ReceptionView bons={(pending ?? []).map(withLines)} history={(history ?? []).map(withLines)} />;
}
