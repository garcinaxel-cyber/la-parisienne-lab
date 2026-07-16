import { createClient } from '@/lib/supabase-server';
import OrdersListView from './OrdersListView';

export const revalidate = 0; // always fresh — new imports must appear immediately

export default async function OrdersPage() {
  const supabase = createClient();

  const { data: imports } = await supabase
    .from('lab_imports')
    .select(`
      id, delivery_date, order_number, type, status,
      shipped_from_lab, notes, imported_at, published_at,
      profiles!lab_imports_imported_by_fkey(full_name)
    `)
    .neq('notes', '__manual_cakes__') // internal container for manual birthday cakes — not a real import
    .order('delivery_date', { ascending: false })
    .order('order_number', { ascending: false })
    .limit(60);

  return <OrdersListView imports={imports ?? []} />;
}
