import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import FicheView from './FicheView';

export const revalidate = 0;

export default async function FichePage({
  params,
  searchParams,
}: {
  params: { productId: string };
  searchParams: { back?: string };
}) {
  const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) redirect('/login');

  const backUrl = searchParams.back ?? '/station/fiches';

  const { data: product } = await supabase
    .from('products')
    .select('id, name_vi, name_en, main_image_url, sku, subcategory, weight_grams, categories(name_vi, name_en)')
    .eq('id', params.productId)
    .single();

  if (!product) redirect(backUrl);

  const { data: allSteps } = await supabase
    .from('lab_fiche_steps')
    .select('step_type, step_number, description_vi, description_en, duration_minutes, temperature_celsius, quantity_grams, percentage')
    .eq('product_id', params.productId)
    .order('step_number');

  const { data: metaRaw } = await supabase
    .from('lab_fiche_meta')
    .select('*')
    .eq('product_id', params.productId)
    .single();

  const meta = metaRaw ?? null;

  // Normalize categories join (Supabase returns array)
  const normalised = {
    ...product,
    categories: Array.isArray((product as any).categories)
      ? (product as any).categories[0] ?? null
      : (product as any).categories ?? null,
  };

  return (
    <FicheView
      product={normalised}
      steps={(allSteps ?? []) as any[]}
      meta={meta}
      backUrl={backUrl}
    />
  );
}
