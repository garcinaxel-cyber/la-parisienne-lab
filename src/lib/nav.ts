// Navigation of the lab app (Axel, 2026-11-07 — "re-travailler l'organisation des onglets").
// ONE source for the desktop sidebar, the phone bottom bar + "More" sheet and the tab strip
// shown at the top of a section. Only the menu moved: every page keeps its URL, its own role
// check and its own content, so old links and bookmarks still work.
//
// Who sees what is unchanged from the previous Sidebar (same role lists), regrouped by moment
// of the day instead of by module:
//   Today          → Control board (what is still open, everything green at end of day)
//   Daily flow     → Production · Delivery check · Special orders · Stock reception
//   Stock & buying → Inventory · Purchasing · OEM orders
//   Shops          → one hub (shop screens, stations QR, managers, events, online sales)
//   Admin          → Reports · Recipes & products · Users & access
import type { UserRole } from '@/lib/types';

export type BadgeKey = 'today' | 'delivery' | 'special' | 'specialRed' | 'reception' | 'purchasing' | 'oem' | 'check';
export type Badges = Partial<Record<BadgeKey, number>>;

export type NavTab = {
  href: string;
  vi: string;
  en: string;
  roles?: UserRole[];
  badge?: BadgeKey;
  /** opens outside the admin layout (own interface) */
  external?: boolean;
  newTab?: boolean;
};

export type NavItem = {
  id: string;
  href: string;
  vi: string;
  en: string;
  icon: string; // lucide icon name, resolved in the client components
  family: FamilyId;
  roles: UserRole[];
  /** extra check on the profile (purchasing for assistants with can_purchase) */
  allow?: (p: NavProfile) => boolean;
  badge?: BadgeKey;
  /** path prefixes that make this entry active */
  match: string[];
  tabs?: NavTab[];
};

export type FamilyId = 'today' | 'flow' | 'stock' | 'shops' | 'admin';
export type NavProfile = { role: UserRole; can_purchase?: boolean };

export const FAMILIES: { id: FamilyId; vi: string; en: string }[] = [
  { id: 'today', vi: 'Hôm nay', en: 'Today' },
  { id: 'flow',  vi: 'Luồng trong ngày', en: 'Daily flow' },
  { id: 'stock', vi: 'Kho & mua hàng', en: 'Stock & purchasing' },
  { id: 'shops', vi: 'Cửa hàng', en: 'Shops' },
  { id: 'admin', vi: 'Quản trị', en: 'Admin' },
];

const LAB: UserRole[] = ['admin', 'lab_manager', 'assistant'];
const MGR: UserRole[] = ['admin', 'lab_manager'];
const ADM: UserRole[] = ['admin'];

export const NAV: NavItem[] = [
  { id: 'today', href: '/today', vi: 'Việc hôm nay', en: 'Control board', icon: 'ListChecks', family: 'today',
    roles: LAB, badge: 'today', match: ['/today'] },

  { id: 'production', href: '/dashboard', vi: 'Sản xuất', en: 'Production', icon: 'ChefHat', family: 'flow',
    roles: LAB, match: ['/dashboard', '/orders', '/lab-scrap', '/import'],
    tabs: [
      { href: '/dashboard', vi: 'Bảng sản xuất', en: 'Board' },
      { href: '/orders', vi: 'Lệnh sản xuất', en: 'Orders', roles: MGR },
      { href: '/lab-scrap', vi: 'Hao hụt Lab', en: 'Lab scrap' },
      { href: '/import', vi: 'Nhập đơn Odoo', en: 'Import', roles: ADM },
    ] },
  { id: 'delivery', href: '/delivery-check', vi: 'Kiểm tra giao hàng', en: 'Delivery check', icon: 'ClipboardCheck', family: 'flow',
    roles: LAB, badge: 'delivery', match: ['/delivery-check'],
    tabs: [
      { href: '/delivery-check', vi: 'Đơn hàng', en: 'Orders' },
      { href: '/delivery-check/category', vi: 'Theo nhóm', en: 'By category' },
      { href: '/delivery-check/by-shop', vi: 'Theo cửa hàng', en: 'By shop' },
      { href: '/delivery-check/gaps', vi: 'Chênh lệch', en: 'Gaps', badge: 'delivery' },
      { href: '/delivery-check/unreconciled', vi: 'Odoo chưa khớp', en: 'Odoo sync' },
      { href: '/delivery-check/history', vi: 'Lịch sử', en: 'History' },
    ] },
  { id: 'special', href: '/exceptional-orders', vi: 'Đơn đặc biệt', en: 'Special orders', icon: 'Zap', family: 'flow',
    roles: LAB, badge: 'special', match: ['/exceptional-orders', '/birthday-cakes'] },
  { id: 'reception', href: '/reception', vi: 'Nhập kho', en: 'Stock reception', icon: 'PackageCheck', family: 'flow',
    roles: LAB, badge: 'reception', match: ['/reception'] },

  { id: 'inventory', href: '/inventory', vi: 'Kiểm kê', en: 'Inventory', icon: 'Boxes', family: 'stock',
    roles: LAB, match: ['/inventory'],
    tabs: [
      { href: '/inventory', vi: 'Thành phẩm Lab', en: 'Finished goods' },
      { href: '/inventory/rooms', vi: 'Kho các team', en: 'Team rooms', roles: ADM },
    ] },
  { id: 'purchasing', href: '/purchasing', vi: 'Mua hàng', en: 'Purchasing', icon: 'Truck', family: 'stock',
    roles: ['admin', 'purchasing'], allow: p => !!p.can_purchase, badge: 'purchasing', match: ['/purchasing'] },
  { id: 'oem', href: '/oem-orders', vi: 'Đơn hàng OEM', en: 'OEM orders', icon: 'Factory', family: 'stock',
    roles: ['admin', 'lab_manager', 'assistant', 'purchasing'], badge: 'oem', match: ['/oem-orders'] },

  { id: 'shops', href: '/admin/shop-access', vi: 'Cửa hàng', en: 'Shops', icon: 'Store', family: 'shops',
    roles: LAB, match: ['/admin/shop-access', '/admin/qr-codes', '/admin/shop-managers', '/admin/events'],
    tabs: [
      { href: '/admin/shop-access', vi: 'Màn hình cửa hàng', en: 'Shop screens' },
      { href: '/admin/qr-codes', vi: 'QR trạm', en: 'Stations QR' },
      { href: '/admin/events', vi: 'Sự kiện', en: 'Events', roles: MGR },
      { href: '/admin/shop-managers', vi: 'Quản lý', en: 'Managers', roles: ADM },
      { href: '/shop-manager', vi: 'Giao diện quản lý', en: 'Manager view', roles: ADM, external: true, newTab: true },
      { href: '/online-orders', vi: 'Bán online', en: 'Online sales', roles: ADM, external: true },
    ] },

  { id: 'reports', href: '/analytics', vi: 'Báo cáo', en: 'Reports', icon: 'TrendingUp', family: 'admin',
    roles: ADM, badge: 'check', match: ['/analytics', '/admin/raw-report', '/admin/reconciliation', '/admin/archives'],
    tabs: [
      { href: '/analytics', vi: 'Phân tích', en: 'Analytics' },
      { href: '/admin/raw-report', vi: 'Nguyên liệu', en: 'Raw materials' },
      { href: '/admin/reconciliation', vi: 'Kiểm tra', en: 'Checks', badge: 'check' },
      { href: '/admin/archives', vi: 'Lưu trữ', en: 'Archives' },
    ] },
  { id: 'recipes', href: '/admin/fiches', vi: 'Công thức & sản phẩm', en: 'Recipes & products', icon: 'BookOpen', family: 'admin',
    roles: MGR, match: ['/admin/fiches', '/admin/excluded', '/admin/lab-products'],
    tabs: [
      { href: '/admin/fiches', vi: 'Công thức', en: 'Recipes' },
      { href: '/admin/excluded', vi: 'Ngoài sản xuất', en: 'Non-production' },
    ] },
  { id: 'users', href: '/admin/users', vi: 'Người dùng', en: 'Users & access', icon: 'Users', family: 'admin',
    roles: ADM, match: ['/admin/users', '/admin/settings'],
    tabs: [
      { href: '/admin/users', vi: 'Người dùng', en: 'Users' },
      { href: '/admin/settings', vi: 'Cài đặt', en: 'Settings' },
    ] },
];

/** Phone bottom bar: 4 entries per role, the rest goes to "More". */
const PRIMARY: Partial<Record<UserRole, string[]>> = {
  admin:       ['today', 'delivery', 'purchasing', 'shops'],
  lab_manager: ['today', 'production', 'delivery', 'inventory'],
  assistant:   ['today', 'delivery', 'special', 'reception'],
  purchasing:  ['purchasing', 'oem'],
};

export function visibleNav(p: NavProfile | null): NavItem[] {
  if (!p) return [];
  return NAV.filter(it => it.roles.includes(p.role) || (it.allow?.(p) ?? false));
}

export function visibleTabs(it: NavItem, p: NavProfile | null): NavTab[] {
  if (!p || !it.tabs) return [];
  return it.tabs.filter(t => !t.roles || t.roles.includes(p.role));
}

export function splitPrimary(items: NavItem[], role: UserRole | undefined) {
  const ids = (role && PRIMARY[role]) || items.slice(0, 4).map(i => i.id);
  const primary = ids.map(id => items.find(i => i.id === id)).filter(Boolean) as NavItem[];
  const more = items.filter(i => !primary.includes(i));
  return { primary, more };
}

function prefixLen(path: string, prefix: string) {
  return path === prefix || path.startsWith(prefix + '/') ? prefix.length : -1;
}

/** Entry whose match prefix is the longest for this path. */
export function activeItem(items: NavItem[], path: string): NavItem | null {
  let best: NavItem | null = null; let len = -1;
  for (const it of items) for (const m of it.match) {
    const l = prefixLen(path, m);
    if (l > len) { len = l; best = it; }
  }
  return best;
}

export function activeTab(tabs: NavTab[], path: string): NavTab | null {
  let best: NavTab | null = null; let len = -1;
  for (const t of tabs) {
    if (t.external) continue;
    const l = prefixLen(path, t.href);
    if (l > len) { len = l; best = t; }
  }
  return best;
}

export function badgeOf(b: Badges, key?: BadgeKey): number {
  if (!key) return 0;
  if (key === 'special') return (b.special ?? 0) + (b.specialRed ?? 0);
  return b[key] ?? 0;
}

/** Red = something to do now; gold = waiting / informative. */
export function badgeIsRed(b: Badges, key?: BadgeKey): boolean {
  if (key === 'special') return (b.specialRed ?? 0) > 0;
  return key === 'delivery' || key === 'purchasing' || key === 'oem' || key === 'today';
}
