import { createClient, getSafeSession } from '@/lib/supabase-server';
import InventoryIndexView from './InventoryIndexView';
import { stockKindsFor, canCountFinished } from '@/lib/inventory-access';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // Odoo scope / send can take a while

export default async function InventoryPage() {
  const supabase = createClient();
  const { data: sessions } = await supabase
    .from('lab_inventory_sessions')
    .select('id, inventory_date, status, created_by_name, submitted_by_name, submitted_at, odoo_push_status, odoo_push_error')
    .order('inventory_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(30);

  const { data: { session } } = await getSafeSession(supabase);
  const { data: profile } = session ? await supabase.from('profiles').select('role, can_purchase').eq('id', session.user.id).maybeSingle() : { data: null };
  const role = (profile as any)?.role as string | undefined;
  const finished = canCountFinished(role);
  return <InventoryIndexView sessions={finished ? sessions ?? [] : []} kinds={stockKindsFor(role, !!(profile as any)?.can_purchase)} finished={finished} />;
}
