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

  // The URL param is the lab fiche id — the B2C catalogue is never read.
  const { data: metaRaw } = await supabase
    .from('lab_fiche_meta')
    .select('*')
    .eq('id', params.productId)
    .maybeSingle();

  if (!metaRaw) redirect(backUrl);

  const ficheId = metaRaw!.id as string;

  const [stepsResult, variantsResult] = await Promise.all([
    ficheId
      ? supabase
          .from('lab_fiche_steps')
          .select('id, step_type, step_number, description_vi, description_en, duration_minutes, temperature_celsius, quantity_grams, percentage')
          .eq('fiche_id', ficheId)
          .order('step_number')
      : Promise.resolve({ data: [] }),
    ficheId
      ? supabase
          .from('lab_fiche_variants')
          .select('id, label, sku, weight_g, is_default, image_url')
          .eq('fiche_id', ficheId)
          .order('sort_order')
      : Promise.resolve({ data: [] }),
  ]);

  // Fetch per-variant quantities for ingredient steps
  const ingredientStepIds = (stepsResult.data ?? [])
    .filter((s: any) => s.step_type === 'ingredient')
    .map((s: any) => s.id)
    .filter(Boolean);

  const { data: variantQtyData } = ingredientStepIds.length > 0
    ? await supabase
        .from('lab_fiche_variant_quantities')
        .select('step_id, variant_id, quantity_grams')
        .in('step_id', ingredientStepIds)
    : { data: [] as { step_id: string; variant_id: string; quantity_grams: number | null }[] };

  // Build product data from the fiche + its default variant (sku)
  const variants = (variantsResult.data ?? []) as any[];
  const defaultVariant = variants.find((v: any) => v.is_default) ?? variants[0] ?? null;

  const normalised = {
    id: metaRaw!.id,
    name_vi: metaRaw!.name_vi,
    name_en: metaRaw!.name_en ?? null,
    main_image_url: metaRaw!.image_url ?? null,
    sku: defaultVariant?.sku ?? null,
    subcategory: metaRaw!.category ?? null,
    weight_grams: metaRaw!.weight_grams ?? null,
    categories: metaRaw!.category
      ? { name_vi: metaRaw!.category, name_en: metaRaw!.category }
      : null,
  };

  return (
    <FicheView
      product={normalised}
      steps={(stepsResult.data ?? []) as any[]}
      meta={metaRaw ?? null}
      variants={variants}
      variantQuantities={(variantQtyData ?? []) as any[]}
      backUrl={backUrl}
    />
  );
}
