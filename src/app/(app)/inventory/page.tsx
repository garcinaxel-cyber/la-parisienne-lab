import { createClient } from '@/lib/supabase-server';
import InventoryIndexView from './InventoryIndexView';

export const dynamic = 'force-dynamic';

export default async function InventoryPage() {
  const supabase = createClient();
  const { data: sessions } = await supabase
    .from('lab_inventory_sessions')
    .select('id, inventory_date, status, created_by_name, submitted_by_name, submitted_at, odoo_push_status, odoo_push_error')
    .order('inventory_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(30);

  return <InventoryIndexView sessions={sessions ?? []} />;
}
