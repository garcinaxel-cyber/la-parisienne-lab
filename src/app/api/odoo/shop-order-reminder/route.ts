import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { tomorrowLabDate } from '@/lib/odoo-manager-order';
import { sendShopPush } from '@/lib/push-notify';
import { SHOP_CONFIG } from '@/lib/shops';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// 13h00 reminder for shops that haven't confirmed tomorrow's Đặt hàng yet (Axel, 2026-09-05:
// "une notification pour les interfaces de shops quand c'est bientôt l'heure de faire la
// commande" — 1h before the 14h00 cutoff). Scoped strictly to the shop's own push channel
// (sendShopPush) — never the chefs, never a lab-wide broadcast (Axel: "je veux seulement la
// boutique qui a la notif pas tout le lab, et surtout pas les chefs"). Called once daily by
// pg_cron at 13h00 VN with ?secret=CRON_SECRET, same pattern as lock-orders/auto-submit-manager-orders.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const tomorrow = tomorrowLabDate();

  // Only the La Paris shops actually use the Đặt hàng replenishment flow — Moon Flower/Lab are
  // quotation-type external partners with no manager-order tab.
  const shopNames = Object.entries(SHOP_CONFIG)
    .filter(([, cfg]) => cfg.docType === 'replenishment')
    .map(([name]) => name);

  const { data: drafts } = await supabase
    .from('lab_shop_manager_order_drafts')
    .select('shop_name, status')
    .eq('delivery_date', tomorrow)
    .in('shop_name', shopNames);
  const statusByShop = new Map<string, string>();
  for (const d of drafts ?? []) statusByShop.set(d.shop_name, d.status);

  const reminded: string[] = [];
  for (const shopName of shopNames) {
    if (statusByShop.get(shopName) === 'submitted') continue; // already confirmed — leave them alone
    await sendShopPush(supabase, shopName, {
      title: shopName,
      body: '⏰ Còn 1 tiếng để xác nhận đơn đặt hàng cho ngày mai (hạn 14h00)',
      url: '/shop',
    });
    reminded.push(shopName);
  }

  return NextResponse.json({ date: tomorrow, reminded });
}
