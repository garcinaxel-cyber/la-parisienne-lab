import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import FicheEditor from './FicheEditor';

export const revalidate = 0;

export default async function FicheDetailPage({ params }: { params: { productId: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: fiche } = await supabase
    .from('lab_fiche_meta')
    .select('*')
    .eq('id', params.productId)
    .single();

  if (!fiche) redirect('/admin/fiches');

  const [{ data: allSteps }, { data: variants }] = await Promise.all([
    supabase
      .from('lab_fiche_steps')
      .select('id, step_type, step_number, description_vi, description_en, duration_minutes, temperature_celsius, quantity_grams, percentage')
      .eq('fiche_id', params.productId)
      .order('step_number'),
    supabase
      .from('lab_fiche_variants')
      .select('id, label, sku, weight_g, is_default, sort_order')
      .eq('fiche_id', params.productId)
      .order('sort_order'),
  ]);

  const steps = allSteps ?? [];
  const ingredients = steps.filter((s: any) => s.step_type === 'ingredient');
  const assemblySteps = steps.filter((s: any) => s.step_type === 'step' || !s.step_type);

  // Load per-variant quantities for ingredient steps
  const ingredientStepIds = ingredients.map((s: any) => s.id).filter(Boolean);
  const { data: variantQtyData } = ingredientStepIds.length > 0
    ? await supabase
        .from('lab_fiche_variant_quantities')
        .select('step_id, variant_id, quantity_grams')
        .in('step_id', ingredientStepIds)
    : { data: [] as { step_id: string; variant_id: string; quantity_grams: number | null }[] };

  // Map step_id → step_number for conversion
  const stepNumById: Record<string, number> = {};
  for (const s of ingredients) {
    stepNumById[(s as any).id] = (s as any).step_number;
  }
  const initVariantQty = (variantQtyData ?? []).map((vq: any) => ({
    step_number: stepNumById[vq.step_id],
    variant_id: vq.variant_id,
    quantity_grams: vq.quantity_grams,
  })).filter((vq: any) => vq.step_number != null);

  return (
    <FicheEditor
      ficheId={fiche.id}
      identity={{
        name_vi: fiche.name_vi ?? '',
        name_en: fiche.name_en ?? '',
        category: fiche.category ?? '',
        teams: fiche.teams ?? [],
        image_url: fiche.image_url ?? '',
      }}
      technique={{
        doc_code: fiche.doc_code ?? '',
        weight_grams: fiche.weight_grams?.toString() ?? '',
        tolerance_pct: fiche.tolerance_pct?.toString() ?? '3',
        sensory_vi: fiche.sensory_vi ?? '',
        sensory_en: fiche.sensory_en ?? '',
        warning_vi: fiche.warning_vi ?? '',
        warning_en: fiche.warning_en ?? '',
      }}
      variants={(variants ?? []).map((v: any) => ({
        id: v.id,
        label: v.label ?? '',
        sku: v.sku ?? '',
        weight_g: v.weight_g?.toString() ?? '',
        is_default: v.is_default ?? false,
        sort_order: v.sort_order ?? 0,
      }))}
      ingredients={ingredients}
      assemblySteps={assemblySteps}
      initVariantQty={initVariantQty}
    />
  );
}
