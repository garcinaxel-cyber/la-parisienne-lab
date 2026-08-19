import { notFound } from 'next/navigation';
import ShopView from '@/app/shop/ShopView';
import { SHOP_NAMES } from '../page';

export const dynamic = 'force-dynamic';

// Staff preview of a shop's own portal (Axel, 2026-08-19: "je veux pouvoir accéder à leur
// interface, tout comme les assistantes et la lab manager via le dashboard"). Role gate
// (admin/lab_manager/assistant) already happens one level up via (app)/layout.tsx — this page
// just needs to exist inside that route group. Read-only: never lets staff confirm a receipt
// pretending to be the shop.
export default function ShopAccessPreviewPage({ params }: { params: { shopName: string } }) {
  const shopName = decodeURIComponent(params.shopName);
  if (!SHOP_NAMES.includes(shopName)) notFound();
  return <ShopView shopName={shopName} readOnly />;
}
