import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ExcludedView from './ExcludedView';

export const revalidate = 0;

export default async function ExcludedPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: rows } = await supabase
    .from('lab_excluded_skus').select('sku, product_name, reason, image_url, shop_visible, created_at').order('created_at', { ascending: false });
  // Fallback photo: the item's Odoo photo copied into the app (lab_item_photos), as on the shop screens.
  const skus = (rows ?? []).filter((r: any) => !r.image_url).map((r: any) => r.sku);
  const { data: photos } = skus.length ? await supabase.from('lab_item_photos').select('sku, image_url').in('sku', skus) : { data: [] as any[] };
  const photoBySku = new Map((photos ?? []).map((p: any) => [p.sku, p.image_url]));
  const list = (rows ?? []).map((r: any) => ({ ...r, image_url: r.image_url || photoBySku.get(r.sku) || null, shop_visible: r.shop_visible !== false }));

  return <ExcludedView rows={list} />;
}
