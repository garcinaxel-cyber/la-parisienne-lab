import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import ShopView from './ShopView';

export const dynamic = 'force-dynamic';

// Shop-facing home — real shared account per shop (role='shop', lab_v45), one login shared by
// that shop's staff. Own top-level route (sibling to /station, not under (app)) since shop
// accounts must never see the admin Sidebar/dashboard.
export default async function ShopHomePage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('full_name, role').eq('id', session.user.id).single();
  if (profile?.role !== 'shop') redirect('/dashboard');

  const { data: labProfile } = await supabase.from('lab_profiles').select('shop_name').eq('id', session.user.id).maybeSingle();
  const shopName = labProfile?.shop_name ?? null;
  if (!shopName) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: '1px solid #E0D49A' }}>
          <div className="text-3xl mb-2">⚠️</div>
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Tài khoản chưa được thiết lập</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>Liên hệ Lab để hoàn tất cấu hình.</p>
        </div>
      </div>
    );
  }

  return <ShopView shopName={shopName} />;
}
