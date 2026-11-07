import { redirect } from 'next/navigation';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { loadRawCounts, badgesForRole } from '@/lib/nav-badges';
import { visibleNav } from '@/lib/nav';
import TodayView, { type TodayRow } from './TodayView';

export const dynamic = 'force-dynamic';

// Control board (Axel, 2026-10-24 + redesign 2026-11-07): one list of everything still open
// for the lab today — "tout doit être vert en fin de journée". Reads the same cached counts as
// the menu badges (20 s), so opening it costs no extra query.
export default async function TodayPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('full_name, role, can_purchase').eq('id', session.user.id).single();
  if (!profile || !['admin', 'lab_manager', 'assistant'].includes(profile.role)) redirect('/dashboard');

  const b = badgesForRole(await loadRawCounts(), profile as any);
  const can = new Set(visibleNav(profile as any).map(i => i.id));
  const rows: TodayRow[] = [];
  const add = (r: TodayRow, visible: boolean) => { if (visible) rows.push(r); };

  add({ id: 'delivery', count: b.delivery ?? 0, urgent: true, href: '/delivery-check/gaps',
    vi: 'Chênh lệch giao hàng cần xử lý', en: 'Delivery gaps to settle',
    hintVi: 'Sản xuất → giao hàng → cửa hàng nhận', hintEn: 'Production → delivery → shop receipt' }, can.has('delivery'));
  add({ id: 'reception', count: b.reception ?? 0, urgent: false, href: '/reception',
    vi: 'Phiếu chuyển & hao hụt cần nhận', en: 'Transfers & losses to receive',
    hintVi: 'Nhập kho sản xuất, chuyển từ cửa hàng', hintEn: 'Production to stock, shop returns' }, can.has('reception'));
  add({ id: 'cakes', count: b.specialRed ?? 0, urgent: true, href: '/exceptional-orders?tab=cakes',
    vi: 'Bánh sinh nhật chưa có lời chúc', en: 'Birthday cakes without a message',
    hintVi: 'Đơn đặc biệt › Bánh sinh nhật', hintEn: 'Special orders › Birthday cakes' }, can.has('special'));
  add({ id: 'manual', count: b.special ?? 0, urgent: false, href: '/exceptional-orders',
    vi: 'Đơn đặc biệt chưa có trên Odoo', en: 'Special orders not yet in Odoo',
    hintVi: 'Cần khớp với đơn Odoo', hintEn: 'To match with an Odoo order' }, can.has('special'));
  add({ id: 'purchasing', count: b.purchasing ?? 0, urgent: true, href: '/purchasing',
    vi: 'Yêu cầu mua & phiếu xuất cần xử lý', en: 'Purchase requests & slips to handle',
    hintVi: 'Mua hàng', hintEn: 'Purchasing' }, can.has('purchasing'));
  add({ id: 'oem', count: b.oem ?? 0, urgent: true, href: '/oem-orders',
    vi: 'Mẻ OEM cần nhận', en: 'OEM batches to receive',
    hintVi: 'Maison Mooncake, Tianhe', hintEn: 'Maison Mooncake, Tianhe' }, can.has('oem'));
  add({ id: 'check', count: b.check ?? 0, urgent: false, href: '/admin/reconciliation',
    vi: 'Điểm kiểm tra Odoo', en: 'Odoo check issues',
    hintVi: 'Kiểm tra tự động mỗi đêm', hintEn: 'Nightly automatic checks' }, profile.role === 'admin');

  return <TodayView rows={rows} name={profile.full_name ?? ''} />;
}
