import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import LabProductsView from './LabProductsView';

export const revalidate = 0;

export default async function LabProductsPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('lab_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !['admin', 'lab_manager'].includes(profile.role)) {
    redirect('/dashboard');
  }

  // Fetch lab-only products (not in public catalogue)
  const { data: products } = await supabase
    .from('products')
    .select('id, name_vi, name_en, sku, main_image_url, is_lab_only, is_active, subcategory')
    .eq('is_lab_only', true)
    .order('name_vi');

  // Fetch categories for the create form
  const { data: categories } = await supabase
    .from('categories')
    .select('id, name_vi, name_en')
    .order('sort_order');

  return <LabProductsView products={products ?? []} categories={categories ?? []} />;
}
