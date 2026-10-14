import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import OemPrintView from './OemPrintView';

export const revalidate = 0;

// Printable carton labels / delivery note for one OEM delivery note (Axel, 2026-10-14).
// Outside the (app) group so the print has no app chrome (same reason as /delivery-print).
export default async function OemPrintPage({ searchParams }: { searchParams: { id?: string; doc?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant', 'purchasing'].includes(profile?.role ?? '')) redirect('/dashboard');
  if (!searchParams.id) redirect('/oem-orders');
  const { data: note } = await supabase.from('lab_mm_delivery_notes').select('*').eq('id', searchParams.id).maybeSingle();
  if (!note) redirect('/oem-orders');
  const [{ data: cartons }, { data: items }, { data: info }] = await Promise.all([
    supabase.from('lab_mm_cartons').select('*').eq('note_id', note.id).order('line_no'),
    supabase.from('lab_mm_order_items').select('sku, product_name'),
    supabase.from('lab_mm_settings').select('value').eq('key', `client_info:${note.client_name}`).maybeSingle(),
  ]);
  let client: any = {}; try { client = JSON.parse(info?.value ?? '{}'); } catch { client = {}; }
  const names = Object.fromEntries((items ?? []).map(i => [i.sku, String(i.product_name).replace(/\s*\(kg\)\s*$/i, '')]));
  return <OemPrintView doc={searchParams.doc === 'note' ? 'note' : 'labels'} note={note} cartons={(cartons ?? []) as any[]} names={names} client={client} />;
}
