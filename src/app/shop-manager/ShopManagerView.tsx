'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown, Package2, Store, ShoppingBag, Users, Truck, ClipboardList, Trash2,
  ArrowLeftRight, Plus, Pencil, X, Check, LogOut, Loader2, PackageCheck, Box, FileText,
} from 'lucide-react';
import { useI18n, type Lang } from '@/lib/i18n';
import * as actions from './actions';
import type { ManagerShopStatus } from './actions';
import { getShopStaffNamesAction, addShopStaffNameAction, renameShopStaffNameAction, removeShopStaffNameAction, getShopManagersForShopAction, type ShopStaffName, type ShopManagerListEntry } from '@/app/shop/actions';
import OrderTab from './OrderTab';
import ReportTab from './ReportTab';

// Shop Manager cockpit (Axel, 2026-09-10) — single client component, internal tab state, same
// posture as ShopView.tsx/OnlineOrdersView.tsx (one route, one bundle) rather than several
// separate pages/serverless routes, per Axel's "optimise ... pour que l usage supabase/vercel
// soit reduit". "Order" deliberately does NOT get its own screen here — it jumps straight into
// the real, already-built ShopView (src/app/shop/ShopView.tsx) via /shop-manager/store, which
// carries the live-inventory panel these managers asked for. "Online sales" jumps to the
// existing /online-orders app, read-only for this role.
//
// Landing flow (Axel, 2026-09-10 follow-up: "la premiere page soit la page shop directement"):
// the FIRST screen after login is always the Shops list (`stage === 'shops'`) — not Today.
// Picking a shop moves to `stage === 'shop'`, which is a Today/Order/Team-tabbed cockpit for
// that one shop; Shops is no longer a persistent 4th bottom-tab, it's reached again from the
// header's shop-switcher (an explicit "all shops" row at the top of that dropdown).
//
// Bilingual (Axel, 2026-09-10: "met l'app aussi en anglais") — same localStorage-backed
// useI18n() toggle as OnlineOrdersView, default VI. NOT extended into ShopView itself (the
// reused Order/Store-interface screens stay Vietnamese-only for now — that's the much bigger,
// separate file real shop-PIN logins also depend on).

// Exported — OrderTab.tsx (the manager's own dedicated Order screen, 2026-09-10) shares this
// exact palette so it visually matches Today/Team instead of redefining its own colors.
export const NAVY = '#1A4731';
export const GOLD = '#C9A84C';
export const CREAM = '#FFF4CC';
const CREAM_DARK = '#F5E89A';
export const INK = '#1A2C24';
export const INK_LIGHT = '#6B7280';
export const BORDER = '#E0D49A';
const TABBAR = '#163D29';
export const GREEN = '#15803D';
export const AMBER = '#B45309';
export const RED = '#B42318';

const L = {
  vi: {
    logout: 'Đăng xuất',
    navToday: 'Hôm nay', navOrder: 'Đặt hàng', navShops: 'Boutiques', navTeam: 'Đội ngũ', navReport: 'Báo cáo',
    allShops: 'Tất cả boutique',
    qaOrder: 'Đặt hàng', qaStore: 'Giao diện shop', qaOnline: 'Bán hàng online', qaTeam: 'Đội ngũ',
    recapReception: 'Nhập hàng', recapReceptionNone: 'Chưa có', recapReceptionNotDone: 'Chưa nhận hàng',
    recapCount: 'Kiểm kho', recapCountNone: 'Chưa kiểm',
    recapOrders: 'Đặt hàng', recapLosses: 'Hao hụt', recapTransfers: 'Chuyển kho', recapOnline: 'Bán hàng online',
    ordersToday: 'Hôm nay', ordersTomorrow: 'Ngày mai', pillNoOrders: 'Chưa có đơn',
    flagOdooDirect: 'Có đơn đặt trực tiếp trên Odoo', flagTransferPending: 'Đang chờ nhận',
    shopsTapHint: 'chạm để mở',
    pillNoDelivery: 'Không có nhập hàng', pillCounted: 'Đã kiểm kho', pillNotCounted: 'Chưa kiểm kho',
    teamAnyoneEdits: 'Ai cũng sửa được', teamNoStaff: 'Chưa có nhân viên nào',
    staffNamePh: 'Tên nhân viên…', save: 'Lưu', addStaff: 'Thêm nhân viên',
    teamManagersTitle: 'Quản lý', teamNoManagers: 'Chưa có quản lý nào',
    allFiveShops: 'Tất cả 5 boutique',
    managersFooterNote: 'Thêm/sửa quản lý: liên hệ Lab (admin).',
  },
  en: {
    logout: 'Log out',
    navToday: 'Today', navOrder: 'Order', navShops: 'Shops', navTeam: 'Team', navReport: 'Report',
    allShops: 'All shops',
    qaOrder: 'Order', qaStore: 'Store interface', qaOnline: 'Online sales', qaTeam: 'Team',
    recapReception: 'Reception', recapReceptionNone: 'None yet', recapReceptionNotDone: 'Reception not done',
    recapCount: 'Stock count', recapCountNone: 'Not counted yet',
    recapOrders: 'Orders', recapLosses: 'Losses', recapTransfers: 'Transfers', recapOnline: 'Online sales',
    ordersToday: 'Today', ordersTomorrow: 'Tomorrow', pillNoOrders: 'No orders yet',
    flagOdooDirect: 'An order was placed directly on Odoo', flagTransferPending: 'Awaiting receipt',
    shopsTapHint: 'tap to open',
    pillNoDelivery: 'No delivery', pillCounted: 'Stock counted', pillNotCounted: 'Not counted',
    teamAnyoneEdits: 'Anyone can edit', teamNoStaff: 'No staff yet',
    staffNamePh: 'Staff name…', save: 'Save', addStaff: 'Add staff',
    teamManagersTitle: 'Managers', teamNoManagers: 'No managers yet',
    allFiveShops: 'All 5 shops',
    managersFooterNote: 'To add or remove a manager, contact the Lab (admin).',
  },
} as const;
type LKey = keyof typeof L.vi;
function useL() {
  const { lang, setLang } = useI18n();
  const d = (lang === 'en' ? L.en : L.vi) as Record<LKey, string>;
  return { tr: (k: LKey) => d[k], lang, setLang };
}

// Small dynamic (interpolated/pluralized) strings — kept as functions of (value, lang) next to
// the static L dict above rather than folded into it, since they're never a plain lookup.
function fmtShopsCount(n: number, lang: Lang) {
  return lang === 'en' ? `${n} shop${n > 1 ? 's' : ''}` : `${n} boutique${n > 1 ? 's' : ''}`;
}
function fmtReceptionValue(confirmed: number, total: number, lang: Lang) {
  return lang === 'en' ? `${confirmed}/${total} lines` : `${confirmed}/${total} dòng`;
}
function fmtDiscrepancy(n: number, lang: Lang) {
  return lang === 'en' ? `${n} quantity mismatch${n > 1 ? 'es' : ''}` : `${n} lệch số lượng`;
}
function fmtCountValue(skuCount: number, valuationStr: string, lang: Lang) {
  return `${skuCount} SKU · ${valuationStr}`;
}
function fmtDoneAt(timeStr: string, lang: Lang) {
  return lang === 'en' ? `Done at ${timeStr}` : `Xong lúc ${timeStr}`;
}
// Order refs are shown right alongside the count now (Axel, 2026-09-10: "dans les orders tu
// mets la ref de la commande") — there's realistically 0-2 orders/shop/day, so listing every
// ref inline never gets unwieldy; the card just wraps to a second line if it ever does.
// One group's line — "Hôm nay: 2 đơn · REF1, REF2" — never a lumped total across both delivery
// dates (Axel, 2026-09-12: an order already placed for tomorrow must read as separate from
// today's own order, "sinon on comprend pas").
function fmtOrdersGroup(orders: { ref: string }[], lang: Lang) {
  const n = orders.length;
  const countStr = lang === 'en' ? `${n} order${n !== 1 ? 's' : ''}` : `${n} đơn`;
  return n ? `${countStr} · ${orders.map(o => o.ref).join(', ')}` : countStr;
}
function fmtLossesValue(n: number, lang: Lang) {
  return lang === 'en' ? `${n} item${n !== 1 ? 's' : ''}` : `${n} sản phẩm`;
}
function fmtTransfersValue(n: number, lang: Lang) {
  return lang === 'en' ? `${n} transfer${n !== 1 ? 's' : ''}` : `${n} phiếu`;
}
function fmtOnlineValue(n: number, amountStr: string, lang: Lang) {
  return lang === 'en' ? `${n} order${n !== 1 ? 's' : ''} · ${amountStr}` : `${n} đơn · ${amountStr}`;
}
function fmtReceivedPill(confirmed: number, total: number, lang: Lang) {
  return lang === 'en' ? `Received ${confirmed}/${total}` : `Nhập ${confirmed}/${total}`;
}
function fmtOrdersPill(groupLabel: string, count: number, odooDirect: number, lang: Lang) {
  const base = lang === 'en' ? `${count} order${count !== 1 ? 's' : ''}${odooDirect ? ` · ${odooDirect} via Odoo` : ''}`
    : `${count} đơn${odooDirect ? ` · ${odooDirect} qua Odoo` : ''}`;
  return `${groupLabel}: ${base}`;
}
function fmtTransfersPending(n: number, lang: Lang) {
  return lang === 'en' ? `${n} transfer${n !== 1 ? 's' : ''} awaiting receipt` : `${n} chuyển kho chờ nhận`;
}
function fmtStaffTitle(shop: string, lang: Lang) {
  return lang === 'en' ? `Staff — ${shop}` : `Nhân viên — ${shop}`;
}
function fmtManagerShops(count: number, lang: Lang) {
  return lang === 'en' ? `${count} shop${count !== 1 ? 's' : ''}` : `${count} boutique`;
}

function fmtVnd(v: number): string {
  return `${Math.round(v).toLocaleString('vi-VN')} ₫`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}

// Order is now a real in-place tab (Axel, 2026-09-10 follow-up: it was routing out to the full
// staff ShopView, which read as "the staff's interface", not the manager's own) — OrderTab.tsx
// is a dedicated, cockpit-styled screen calling the exact same server actions ShopView's order
// tab already used. "Store interface" (the OTHER quick action, Giao diện shop) is untouched — it
// still deliberately reuses the real ShopView via /shop-manager/store, that one was never in
// question.
type Tab = 'today' | 'order' | 'team' | 'report';
type Stage = 'shops' | 'shop';

export default function ShopManagerView({ managerName, color, shops }: { managerName: string; color: string; shops: string[] }) {
  const router = useRouter();
  const { tr, lang, setLang } = useL();
  const [stage, setStage] = useState<Stage>('shops');
  const [tab, setTab] = useState<Tab>('today');
  const [activeShop, setActiveShop] = useState('');
  const [shopPicker, setShopPicker] = useState(false);

  async function logout() {
    const { createClient } = await import('@/lib/supabase-browser');
    await createClient().auth.signOut();
    router.push('/login');
  }

  function openStoreInterface() {
    router.push(`/shop-manager/store?shop=${encodeURIComponent(activeShop)}&tab=deliveries`);
  }

  function enterShop(s: string) {
    setActiveShop(s);
    setTab('today');
    setStage('shop');
    setShopPicker(false);
  }

  function backToShops() {
    setStage('shops');
    setShopPicker(false);
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: CREAM }}>
      <div style={{ backgroundColor: NAVY }} className="px-4 pt-4 pb-3">
        <div className="max-w-xl mx-auto flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: GOLD }}>
            <Store size={17} style={{ color: NAVY }} />
          </div>
          <div className="flex-1 min-w-0">
            {stage === 'shop' ? (
              <button onClick={() => setShopPicker(v => !v)} className="flex items-center gap-1 min-w-0">
                <h1 className="font-serif text-base font-bold truncate" style={{ color: '#FFFAEE' }}>{activeShop || '—'}</h1>
                <ChevronDown size={14} style={{ color: GOLD }} className="shrink-0" />
              </button>
            ) : (
              <h1 className="font-serif text-base font-bold truncate" style={{ color: '#FFFAEE' }}>{tr('navShops')}</h1>
            )}
            <div className="text-[11px]" style={{ color: '#F0D98A' }}>
              {managerName} · {fmtShopsCount(shops.length, lang)}
            </div>
          </div>
          <div className="flex rounded-md overflow-hidden shrink-0" style={{ border: '1px solid rgba(255,255,255,0.25)' }} aria-label="Language">
            {(['vi', 'en'] as const).map(lg => (
              <button key={lg} onClick={() => setLang(lg)} style={{
                fontSize: 10.5, fontWeight: 700, padding: '3px 7px', letterSpacing: '.03em',
                backgroundColor: lang === lg ? GOLD : 'transparent', color: lang === lg ? NAVY : 'rgba(255,255,255,0.7)',
              }}>{lg.toUpperCase()}</button>
            ))}
          </div>
          <button onClick={logout} className="p-2 rounded-lg shrink-0" style={{ color: 'rgba(255,250,238,0.6)' }} aria-label={tr('logout')}>
            <LogOut size={17} />
          </button>
        </div>
        {stage === 'shop' && shopPicker && (
          <div className="max-w-xl mx-auto mt-2.5 rounded-xl overflow-hidden" style={{ backgroundColor: '#fff' }}>
            <button onClick={backToShops}
              className="w-full text-left px-3.5 py-2.5 text-sm font-bold flex items-center gap-2"
              style={{ color: NAVY, backgroundColor: CREAM }}>
              <Box size={15} /> {tr('allShops')}
            </button>
            {shops.map(s => (
              <button key={s} onClick={() => enterShop(s)}
                className="w-full text-left px-3.5 py-2.5 text-sm font-semibold flex items-center justify-between"
                style={{ color: INK, borderTop: `1px solid ${BORDER}`, backgroundColor: s === activeShop ? CREAM : '#fff' }}>
                {s}
                {s === activeShop && <Check size={15} style={{ color: GREEN }} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="max-w-xl mx-auto px-4 py-4 pb-24">
        {stage === 'shops' && <ShopsTab shops={shops} activeShop={activeShop} onPick={enterShop} />}
        {stage === 'shop' && tab === 'today' && (
          <TodayTab activeShop={activeShop} onOpenStoreInterface={openStoreInterface} onOrder={() => setTab('order')}
            onOnlineSales={() => router.push('/online-orders')} onTeam={() => setTab('team')} />
        )}
        {stage === 'shop' && tab === 'order' && <OrderTab activeShop={activeShop} managerName={managerName} />}
        {stage === 'shop' && tab === 'team' && <TeamTab activeShop={activeShop} />}
        {stage === 'shop' && tab === 'report' && <ReportTab activeShop={activeShop} />}
      </div>

      {stage === 'shop' && (
        <div style={{ backgroundColor: TABBAR }} className="flex fixed bottom-0 left-0 right-0 z-10">
          {([
            ['today', PackageCheck, tr('navToday')],
            ['order', ShoppingBag, tr('navOrder')],
            ['report', FileText, tr('navReport')],
            ['team', Users, tr('navTeam')],
          ] as const).map(([key, Icon, label]) => {
            const active = tab === key;
            return (
              <button key={key}
                onClick={() => setTab(key as Tab)}
                className="flex-1 text-center py-2.5"
                style={{ color: active ? GOLD : '#8FAE9E', fontWeight: active ? 700 : 500, fontSize: 11.5, borderTop: `2px solid ${active ? GOLD : 'transparent'}` }}>
                <Icon size={17} className="mx-auto" />
                <div className="mt-0.5">{label}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-2xl p-3.5 flex flex-col items-center gap-1.5 text-center" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
      <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ backgroundColor: CREAM }}>
        <Icon size={17} style={{ color: NAVY }} />
      </div>
      <div className="text-xs font-bold" style={{ color: INK }}>{label}</div>
    </button>
  );
}

function RecapCard({ icon: Icon, label, value, flag, full }: { icon: any; label: string; value: string; flag?: { color: string; text: string }; full?: boolean }) {
  return (
    <div className={`rounded-2xl p-3.5 ${full ? 'col-span-2' : ''}`} style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={14} style={{ color: INK_LIGHT }} />
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{label}</div>
      </div>
      <div className="text-sm font-bold" style={{ color: INK }}>{value}</div>
      {flag && <div className="text-[10.5px] font-bold mt-1" style={{ color: flag.color }}>{flag.text}</div>}
    </div>
  );
}

// Orders card is its own component, not a plain RecapCard: it needs two rows (today's delivery
// vs. tomorrow's, per Axel — see fmtOrdersGroup above) instead of one value string, and spans
// the full card width since that no longer fits half a 2-column row.
function OrdersRecapCard({ todayOrders, tomorrowOrders, tr, lang }: {
  todayOrders: { ref: string; odooDirect: boolean }[]; tomorrowOrders: { ref: string; odooDirect: boolean }[];
  tr: (k: LKey) => string; lang: Lang;
}) {
  const anyOdoo = todayOrders.some(o => o.odooDirect) || tomorrowOrders.some(o => o.odooDirect);
  return (
    <div className="rounded-2xl p-3.5 col-span-2" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <ShoppingBag size={14} style={{ color: INK_LIGHT }} />
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{tr('recapOrders')}</div>
      </div>
      <div className="space-y-1">
        <div className="text-sm">
          <span className="font-bold" style={{ color: INK }}>{tr('ordersToday')}:</span>{' '}
          <span style={{ color: todayOrders.length ? INK : INK_LIGHT }}>{fmtOrdersGroup(todayOrders, lang)}</span>
        </div>
        <div className="text-sm">
          <span className="font-bold" style={{ color: INK }}>{tr('ordersTomorrow')}:</span>{' '}
          <span style={{ color: tomorrowOrders.length ? INK : INK_LIGHT }}>{fmtOrdersGroup(tomorrowOrders, lang)}</span>
        </div>
      </div>
      {anyOdoo && <div className="text-[10.5px] font-bold mt-1" style={{ color: AMBER }}>{tr('flagOdooDirect')}</div>}
    </div>
  );
}

function TodayTab({ activeShop, onOpenStoreInterface, onOrder, onOnlineSales, onTeam }: {
  activeShop: string; onOpenStoreInterface: () => void; onOrder: () => void; onOnlineSales: () => void; onTeam: () => void;
}) {
  const { tr, lang } = useL();
  const [data, setData] = useState<Awaited<ReturnType<typeof actions.getManagerTodayRecapAction>> | null>(null);

  const load = useCallback(async () => {
    if (!activeShop) return;
    setData(null);
    const res = await actions.getManagerTodayRecapAction(activeShop);
    setData(res);
  }, [activeShop]);
  useEffect(() => { load(); }, [load]);

  const recap = data?.recap;
  const reception = recap?.reception;
  // "Chưa có/None yet" only when there's truly nothing expected today (reception === null, i.e.
  // no delivery-check lines at all for this shop+date). When something WAS expected but isn't
  // fully received yet, that's not a neutral "not yet" state any more — flag it in red instead
  // of letting it pass silently (Axel, 2026-09-10: "si tu mets not yet c'est qu'il y a vraiment
  // pas de livraison prevu ... sinon tu mets en rouge que la reception a pas ete faite").
  const receptionDone = !!reception && reception.confirmedLines >= reception.totalLines;
  const receptionFlag = reception && !receptionDone
    ? { color: RED, text: tr('recapReceptionNotDone') }
    : reception && reception.discrepancies.length
      ? { color: RED, text: fmtDiscrepancy(reception.discrepancies.length, lang) }
      : undefined;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <QuickAction icon={ShoppingBag} label={tr('qaOrder')} onClick={onOrder} />
        <QuickAction icon={Store} label={tr('qaStore')} onClick={onOpenStoreInterface} />
        <QuickAction icon={Package2} label={tr('qaOnline')} onClick={onOnlineSales} />
        <QuickAction icon={Users} label={tr('qaTeam')} onClick={onTeam} />
      </div>

      {!data ? (
        <div className="text-center py-10"><Loader2 className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <RecapCard icon={Truck} label={tr('recapReception')}
            value={reception ? fmtReceptionValue(reception.confirmedLines, reception.totalLines, lang) : tr('recapReceptionNone')}
            flag={receptionFlag} />
          <RecapCard icon={ClipboardList} label={tr('recapCount')}
            value={recap?.count ? fmtCountValue(recap.count.skuCount, fmtVnd(recap.count.valuation), lang) : tr('recapCountNone')}
            flag={recap?.count ? { color: GREEN, text: fmtDoneAt(fmtTime(recap.count.finishedAt), lang) } : undefined} />
          <OrdersRecapCard
            todayOrders={(recap?.orders ?? []).filter(o => o.deliveryDate === data.date)}
            tomorrowOrders={(recap?.orders ?? []).filter(o => o.deliveryDate !== data.date)}
            tr={tr} lang={lang} />
          <RecapCard icon={Trash2} label={tr('recapLosses')} value={recap ? fmtLossesValue(recap.losses.totalQty, lang) : fmtLossesValue(0, lang)} />
          <RecapCard icon={ArrowLeftRight} label={tr('recapTransfers')}
            value={recap ? fmtTransfersValue(recap.transfers.length, lang) : fmtTransfersValue(0, lang)}
            flag={recap && recap.transfers.some(t => t.status === 'sent') ? { color: AMBER, text: tr('flagTransferPending') } : undefined} />
          <RecapCard icon={Package2} label={tr('recapOnline')}
            value={data.online ? fmtOnlineValue(data.online.count, fmtVnd(data.online.total), lang) : fmtOnlineValue(0, fmtVnd(0), lang)} />
        </div>
      )}
    </div>
  );
}

function ShopsTab({ shops, activeShop, onPick }: { shops: string[]; activeShop: string; onPick: (s: string) => void }) {
  const { tr, lang } = useL();
  const [statuses, setStatuses] = useState<ManagerShopStatus[] | null>(null);
  useEffect(() => {
    (async () => {
      const res = await actions.getManagerShopsStatusAction();
      setStatuses(res.shops ?? []);
    })();
  }, []);

  return (
    <div className="space-y-2.5">
      <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{fmtShopsCount(shops.length, lang)} · {tr('shopsTapHint')}</div>
      {shops.map(s => {
        const st = statuses?.find(x => x.shop === s);
        return (
          <button key={s} onClick={() => onPick(s)} className="w-full text-left rounded-2xl p-3.5"
            style={{ backgroundColor: '#fff', border: `1px solid ${s === activeShop ? GOLD : BORDER}` }}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="font-serif font-bold text-sm" style={{ color: INK }}>{s}</div>
              {!statuses ? <Loader2 size={14} className="animate-spin" style={{ color: INK_LIGHT }} /> : null}
            </div>
            {st && (
              <div className="flex flex-wrap gap-1.5">
                <Pill ok={st.receptionTotal > 0 && st.receptionConfirmed >= st.receptionTotal} label={st.receptionTotal ? fmtReceivedPill(st.receptionConfirmed, st.receptionTotal, lang) : tr('pillNoDelivery')} />
                <Pill ok={st.countDone} label={st.countDone ? tr('pillCounted') : tr('pillNotCounted')} />
                {st.ordersToday === 0 && st.ordersTomorrow === 0 ? (
                  <Pill ok label={tr('pillNoOrders')} />
                ) : (
                  <>
                    {st.ordersToday > 0 && (
                      <Pill ok={st.ordersTodayOdooDirect === 0} warn={st.ordersTodayOdooDirect > 0}
                        label={fmtOrdersPill(tr('ordersToday'), st.ordersToday, st.ordersTodayOdooDirect, lang)} />
                    )}
                    {st.ordersTomorrow > 0 && (
                      <Pill ok={st.ordersTomorrowOdooDirect === 0} warn={st.ordersTomorrowOdooDirect > 0}
                        label={fmtOrdersPill(tr('ordersTomorrow'), st.ordersTomorrow, st.ordersTomorrowOdooDirect, lang)} />
                    )}
                  </>
                )}
                {st.transfersPending > 0 && <Pill ok={false} warn label={fmtTransfersPending(st.transfersPending, lang)} />}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Pill({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  const color = warn ? AMBER : ok ? GREEN : INK_LIGHT;
  const bg = warn ? '#FEF3C7' : ok ? '#EAF6EC' : '#F3F4F6';
  return <span className="text-[10.5px] font-bold rounded-full px-2 py-0.5" style={{ color, backgroundColor: bg }}>{label}</span>;
}

function TeamTab({ activeShop }: { activeShop: string }) {
  const { tr, lang } = useL();
  const [staff, setStaff] = useState<ShopStaffName[] | null>(null);
  const [managers, setManagers] = useState<ShopManagerListEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    if (!activeShop) return;
    setStaff(null); setManagers(null);
    const [staffRes, managersRes] = await Promise.all([
      getShopStaffNamesAction(activeShop),
      getShopManagersForShopAction(activeShop),
    ]);
    setStaff(staffRes.names ?? []);
    setManagers(managersRes.managers ?? []);
  }, [activeShop]);
  useEffect(() => { load(); }, [load]);

  async function submitAdd() {
    const clean = newName.trim();
    if (!clean) return;
    await addShopStaffNameAction(clean, activeShop);
    setNewName(''); setAdding(false); load();
  }
  async function submitRename(id: string) {
    const clean = editName.trim();
    if (!clean) return;
    await renameShopStaffNameAction(id, clean, activeShop);
    setEditingId(null); load();
  }
  async function remove(id: string) {
    await removeShopStaffNameAction(id, activeShop);
    load();
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{fmtStaffTitle(activeShop, lang)}</div>
          <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{tr('teamAnyoneEdits')}</div>
        </div>
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
          {!staff ? (
            <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
          ) : !staff.length ? (
            <div className="py-4 px-3.5 text-xs" style={{ color: '#9CA3AF' }}>{tr('teamNoStaff')}</div>
          ) : staff.map((s, i) => (
            <div key={s.id} className="flex items-center justify-between px-3.5 py-2.5" style={{ borderTop: i === 0 ? 'none' : `1px solid ${CREAM_DARK}` }}>
              {editingId === s.id ? (
                <input autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && submitRename(s.id)}
                  className="flex-1 min-w-0 rounded-lg px-2 py-1 text-sm mr-2" style={{ border: `1px solid ${BORDER}` }} />
              ) : (
                <div className="text-sm font-semibold" style={{ color: INK }}>{s.name}</div>
              )}
              <div className="flex items-center gap-3 shrink-0">
                {editingId === s.id ? (
                  <>
                    <button onClick={() => submitRename(s.id)}><Check size={15} style={{ color: GREEN }} /></button>
                    <button onClick={() => setEditingId(null)}><X size={15} style={{ color: '#9CA3AF' }} /></button>
                  </>
                ) : (
                  <>
                    <button onClick={() => { setEditingId(s.id); setEditName(s.name); }}><Pencil size={14} style={{ color: '#9CA3AF' }} /></button>
                    <button onClick={() => remove(s.id)}><Trash2 size={14} style={{ color: RED }} /></button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        {adding ? (
          <div className="flex items-center gap-2 mt-2">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitAdd()}
              placeholder={tr('staffNamePh')} className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm" style={{ border: `1px solid ${BORDER}` }} />
            <button onClick={submitAdd} className="px-3 py-2 rounded-xl text-sm font-bold text-white" style={{ backgroundColor: NAVY }}>{tr('save')}</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="w-full flex items-center justify-center gap-1.5 mt-2 rounded-xl px-3 py-2 text-xs font-semibold"
            style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT }}>
            <Plus size={14} /> {tr('addStaff')}
          </button>
        )}
      </div>

      <div>
        <div className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: INK_LIGHT }}>{tr('teamManagersTitle')}</div>
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
          {!managers ? (
            <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
          ) : !managers.length ? (
            <div className="py-4 px-3.5 text-xs" style={{ color: '#9CA3AF' }}>{tr('teamNoManagers')}</div>
          ) : managers.map((m, i) => (
            <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderTop: i === 0 ? 'none' : `1px solid ${CREAM_DARK}` }}>
              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
              <div className="text-sm font-bold flex-1 min-w-0" style={{ color: INK }}>{m.name}</div>
              <div className="text-[11px] shrink-0" style={{ color: '#9CA3AF' }}>{m.allFiveShops ? tr('allFiveShops') : fmtManagerShops(m.shopsCount, lang)}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11px]" style={{ color: '#9CA3AF' }}>{tr('managersFooterNote')}</div>
      </div>
    </div>
  );
}
