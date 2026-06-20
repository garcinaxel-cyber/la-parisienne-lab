import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import FicheEditor from './FicheEditor';

export const revalidate = 0;

export default async function FicheDetailPage({ params }: { params: { productId: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: product } = await supabase
    .from('products')
    .select('id, name_vi, name_en, image_url, sku')
    .eq('id', params.productId)
    .single();

  if (!product) redirect('/admin/fiches');

  const { data: steps } = await supabase
    .from('lab_fiche_steps')
    .select('id, step_number, description_vi, description_en, duration_minutes, temperature_celsius, image_url')
    .eq('product_id', params.productId)
    .order('step_number');

  return <FicheEditor product={product} steps={steps ?? []} />;
}
