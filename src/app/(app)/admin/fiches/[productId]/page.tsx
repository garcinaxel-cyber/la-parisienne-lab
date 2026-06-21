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

  const { data: product } = await supabase
    .from('products')
    .select('id, name_vi, name_en, main_image_url, sku')
    .eq('id', params.productId)
    .single();

  if (!product) redirect('/admin/fiches');

  // Fetch steps: separate ingredients from assembly steps
  const { data: allSteps } = await supabase
    .from('lab_fiche_steps')
    .select('id, step_type, step_number, description_vi, description_en, duration_minutes, temperature_celsius, quantity_grams, percentage')
    .eq('product_id', params.productId)
    .order('step_number');

  const steps = allSteps ?? [];
  const ingredients = steps.filter((s: any) => s.step_type === 'ingredient');
  const assemblySteps = steps.filter((s: any) => s.step_type === 'step' || !s.step_type);

  // Fetch fiche metadata
  const { data: ficheMetaRaw } = await supabase
    .from('lab_fiche_meta')
    .select('*')
    .eq('product_id', params.productId)
    .single();

  const meta = ficheMetaRaw ? {
    doc_code:      ficheMetaRaw.doc_code      ?? '',
    weight_grams:  ficheMetaRaw.weight_grams?.toString()  ?? '',
    tolerance_pct: ficheMetaRaw.tolerance_pct?.toString() ?? '3',
    sensory_vi:    ficheMetaRaw.sensory_vi    ?? '',
    sensory_en:    ficheMetaRaw.sensory_en    ?? '',
    warning_vi:    ficheMetaRaw.warning_vi    ?? '',
    warning_en:    ficheMetaRaw.warning_en    ?? '',
  } : null;

  const productForEditor = {
    ...product,
    image_url: (product as any).main_image_url ?? null,
  };

  return (
    <FicheEditor
      product={productForEditor}
      ingredients={ingredients}
      assemblySteps={assemblySteps}
      meta={meta}
    />
  );
}
