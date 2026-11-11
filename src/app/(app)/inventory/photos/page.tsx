import { createClient, getSafeSession } from '@/lib/supabase-server';
import PhotosView from './PhotosView';
import { stockKindsFor } from '@/lib/inventory-access';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;   // Odoo scope / send can take a while

export default async function InventoryPhotosPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  const { data: profile } = session ? await supabase.from('profiles').select('role, can_purchase').eq('id', session.user.id).maybeSingle() : { data: null };
  return <PhotosView kinds={stockKindsFor((profile as any)?.role, !!(profile as any)?.can_purchase)} />;
}
