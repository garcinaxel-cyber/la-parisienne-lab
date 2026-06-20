import { createClient } from '@/lib/supabase-server';
import OrdersListView from './OrdersListView';

export const revalidate = 30;

export default async function OrdersPage() {
  const supabase = createClient();

  const { data: imports } = await supabase
    .from('lab_imports')
    .select(`
      id, delivery_date, order_number, type, status,
      shipped_from_lab, notes, imported_at, published_at,
      profiles!lab_imports_imported_by_fkey(full_name)
    `)
    .order('delivery_date', { ascending: false })
    .order('order_number', { ascending: false })
    .limit(60);

  return <OrdersListView imports={imports ?? []} />;
}
