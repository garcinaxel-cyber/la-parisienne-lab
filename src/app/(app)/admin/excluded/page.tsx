import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import ExcludedView from './ExcludedView';

export const revalidate = 0;

export default async function ExcludedPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) redirect('/dashboard');

  const { data: rows } = await supabase
    .from('lab_excluded_skus').select('sku, product_name, reason, created_at').order('created_at', { ascending: false });

  return <ExcludedView rows={rows ?? []} />;
}
