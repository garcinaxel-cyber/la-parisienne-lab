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

  // Try to load from products table (product-linked fiche)
  const { data: product } = await supabase
    .from('products')
    .select('id, name_vi, name_en, main_image_url, sku, subcategory, weight_grams, categories(name_vi, name_en)')
    .eq('id', params.productId)
    .maybeSingle();

  // Get fiche meta — by product_id if product exists, by fiche id if standalone
  const { data: metaRaw } = product
    ? await supabase.from('lab_fiche_meta').select('*').eq('product_id', params.productId).maybeSingle()
    : await supabase.from('lab_fiche_meta').select('*').eq('id', params.productId).maybeSingle();

  if (!product && !metaRaw) redirect(backUrl);

  // Steps and variants are keyed by fiche_id (not product_id)
  const ficheId = metaRaw?.id ?? null;

  const [stepsResult, variantsResult] = await Promise.all([
    ficheId
      ? supabase
          .from('lab_fiche_steps')
          .select('step_type, step_number, description_vi, description_en, duration_minutes, temperature_celsius, quantity_grams, percentage')
          .eq('fiche_id', ficheId)
          .order('step_number')
      : Promise.resolve({ data: [] }),
    ficheId
      ? supabase
          .from('lab_fiche_variants')
          .select('label, sku, weight_g, is_default')
          .eq('fiche_id', ficheId)
          .order('sort_order')
      : Promise.resolve({ data: [] }),
  ]);

  // If product exists, use it; otherwise synthesise from fiche meta
  const productData = product ?? {
    id: metaRaw!.id,
    name_vi: metaRaw!.name_vi,
    name_en: metaRaw!.name_en ?? null,
    main_image_url: metaRaw!.image_url ?? null,
    sku: null,
    subcategory: null,
    weight_grams: metaRaw!.weight_grams ?? null,
    categories: null,
  };

  // Normalize categories join (Supabase returns array)
  const normalised = {
    ...productData,
    categories: Array.isArray((productData as any).categories)
      ? (productData as any).categories[0] ?? null
      : (productData as any).categories ?? null,
  };

  return (
    <FicheView
      product={normalised}
      steps={(stepsResult.data ?? []) as any[]}
      meta={metaRaw ?? null}
      variants={(variantsResult.data ?? []) as any[]}
      backUrl={backUrl}
    />
  );
}
