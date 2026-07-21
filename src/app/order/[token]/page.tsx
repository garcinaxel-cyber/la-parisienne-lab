import { createClient as createServiceClient } from '@supabase/supabase-js';
import ShopOrderForm from './ShopOrderForm';

export const revalidate = 0;
export const metadata = { title: 'Đặt hàng gấp — La Parisienne Lab', robots: { index: false, follow: false } };
// Explicit viewport — the form must render at device width on the shops' phones
export const viewport = { width: 'device-width', initialScale: 1 };

// Public shop order page — no login. The token in the URL is the access key.
export default async function ShopOrderPage({ params }: { params: { token: string } }) {
  let valid = false;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY && params.token && params.token.length >= 8) {
    const supabase = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    );
    const { data } = await supabase.from('lab_shop_link')
      .select('id').eq('token', params.token).eq('active', true).maybeSingle();
    valid = !!data;
  }

  if (!valid) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ backgroundColor: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: '1px solid #E0D49A' }}>
          <div className="text-3xl mb-2">🔒</div>
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Liên kết không hợp lệ</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>
            Link đặt hàng đã thay đổi hoặc không đúng. Vui lòng liên hệ Lab để nhận link mới.
          </p>
          <p className="text-xs mt-3" style={{ color: '#9CA3AF' }}>
            Invalid or outdated order link — contact the lab for the new one.
          </p>
        </div>
      </div>
    );
  }

  const today = new Date().toISOString().split('T')[0];
  return <ShopOrderForm token={params.token} today={today} />;
}
