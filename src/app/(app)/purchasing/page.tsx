import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import PurchasingView from './PurchasingView';

export const dynamic = 'force-dynamic';

// Purchasing space (Axel, 2026-10-08): purchase requests, today's storage withdrawals, history,
// raw material catalogue. Role 'purchasing' and admin only — the assistant and lab manager roles do
// not see it.
export default async function PurchasingPage({ searchParams }: { searchParams: { tab?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role, full_name, can_purchase').eq('id', session.user.id).single();
  if (!['purchasing', 'admin'].includes(profile?.role ?? '') && !(profile as any)?.can_purchase) redirect('/dashboard');
  const tab = ['requests', 'storage', 'history', 'catalogue'].includes(searchParams?.tab ?? '') ? searchParams.tab! : 'requests';
  return <PurchasingView initialTab={tab as any} userName={profile?.full_name ?? ''} />;
}
