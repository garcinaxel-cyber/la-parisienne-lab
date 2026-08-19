import { createClient as createServiceClient } from '@supabase/supabase-js';
import ShopPortalView from './ShopPortalView';

export const revalidate = 0;
export const metadata = { title: 'Giao hàng — La Parisienne Lab', robots: { index: false, follow: false } };
export const viewport = { width: 'device-width', initialScale: 1 };

// Public shop delivery/cakes portal — no login. The token in the URL is the access key,
// one per shop (lab_v44). Same shape as /order/[token]/page.tsx.
export default async function ShopPortalPage({ params }: { params: { token: string } }) {
  let shopName: string | null = null;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && params.token && params.token.length >= 8) {
    const supabase = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
    const { data } = await supabase.from('lab_shop_portal_links')
      .select('shop_name').eq('token', params.token).eq('active', true).maybeSingle();
    shopName = data?.shop_name ?? null;
  }

  if (!shopName) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: '1px solid #E0D49A' }}>
          <div className="text-3xl mb-2">🔒</div>
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Liên kết không hợp lệ</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>
            Link đã thay đổi hoặc không đúng. Vui lòng liên hệ Lab để nhận link mới.
          </p>
          <p className="text-xs mt-3" style={{ color: '#9CA3AF' }}>
            Invalid or outdated link — contact the lab for the new one.
          </p>
        </div>
      </div>
    );
  }

  return <ShopPortalView token={params.token} shopName={shopName} />;
}
