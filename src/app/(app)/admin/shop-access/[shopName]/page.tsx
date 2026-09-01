import { notFound } from 'next/navigation';
import ShopView from '@/app/shop/ShopView';
import { PORTAL_SHOP_NAMES as SHOP_NAMES } from '@/lib/shops';

export const dynamic = 'force-dynamic';

// Staff access to a shop's own portal (Axel, 2026-08-19: "je veux pouvoir accéder à leur
// interface, tout comme les assistantes et la lab manager via le dashboard"; then 2026-08-25:
// "je veux exactement comme les QR code des chefs" — one click into the real, interactive
// interface for testing, no shop login needed). Role gate (admin/lab_manager/assistant) already
// happens one level up via (app)/layout.tsx AND again server-side on every write action
// (requireShopOrStaffSession in shop/actions.ts) — this page just needs to exist inside that
// route group. `readOnly` here doesn't mean read-only anymore (see ShopView.tsx's doc comment):
// it flags "acting as this shop via staff session" and ShopView shows a banner for it.
export default function ShopAccessPreviewPage({ params }: { params: { shopName: string } }) {
  const shopName = decodeURIComponent(params.shopName);
  if (!SHOP_NAMES.includes(shopName)) notFound();
  return <ShopView shopName={shopName} readOnly />;
}
