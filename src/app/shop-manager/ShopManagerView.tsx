'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronDown, Package2, Store, ShoppingBag, Users, Truck, ClipboardList, Trash2,
  ArrowLeftRight, Plus, Pencil, X, Check, LogOut, Loader2, PackageCheck, Box,
} from 'lucide-react';
import * as actions from './actions';
import type { ManagerShopStatus } from './actions';
import { getShopStaffNamesAction, addShopStaffNameAction, renameShopStaffNameAction, removeShopStaffNameAction, getShopManagersForShopAction, type ShopStaffName, type ShopManagerListEntry } from '@/app/shop/actions';

// Shop Manager cockpit (Axel, 2026-09-10) — single client component, internal tab state, same
// posture as ShopView.tsx/OnlineOrdersView.tsx (one route, one bundle) rather than several
// separate pages/serverless routes, per Axel's "optimise ... pour que l usage supabase/vercel
// soit reduit". "Order" and "Store interface" deliberately do NOT get their own screens here —
// both jump straight into the real, already-built ShopView (src/app/shop/ShopView.tsx) via
// /shop-manager/store, which now also carries the live-inventory panel these managers asked for
// (2026-09-10, added directly to ShopView's own Order tab so every shop benefits, not just
// managers). "Online sales" jumps to the existing /online-orders app, read-only for this role.

const NAVY = '#1A4731';
const GOLD = '#C9A84C';
const CREAM = '#FFF4CC';
const CREAM_DARK = '#F5E89A';
const INK = '#1A2C24';
const INK_LIGHT = '#6B7280';
const BORDER = '#E0D49A';
const TABBAR = '#163D29';
const GREEN = '#15803D';
const AMBER = '#B45309';
const RED = '#B42318';

function fmtVnd(v: number): string {
  return `${Math.round(v).toLocaleString('vi-VN')} ₫`;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' });
}

type Tab = 'today' | 'shops' | 'team';

export default function ShopManagerView({ managerName, color, shops }: { managerName: string; color: string; shops: string[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('today');
  const [activeShop, setActiveShop] = useState(shops[0] ?? '');
  const [shopPicker, setShopPicker] = useState(false);

  async function logout() {
    const { createClient } = await import('@/lib/supabase-browser');
    await createClient().auth.signOut();
    router.push('/login');
  }

  function openStore(initialTab: 'deliveries' | 'order') {
    router.push(`/shop-manager/store?shop=${encodeURIComponent(activeShop)}&tab=${initialTab}`);
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: CREAM }}>
      <div style={{ backgroundColor: NAVY }} className="px-4 pt-4 pb-3">
        <div className="max-w-xl mx-auto flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: GOLD }}>
            <Store size={17} style={{ color: NAVY }} />
          </div>
          <div className="flex-1 min-w-0">
            <button onClick={() => setShopPicker(v => !v)} className="flex items-center gap-1 min-w-0">
              <h1 className="font-serif text-base font-bold truncate" style={{ color: '#FFFAEE' }}>{activeShop || '—'}</h1>
              <ChevronDown size={14} style={{ color: GOLD }} className="shrink-0" />
            </button>
            <div className="text-[11px]" style={{ color: '#F0D98A' }}>
              {managerName} · {shops.length} boutique{shops.length > 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={logout} className="p-2 rounded-lg shrink-0" style={{ color: 'rgba(255,250,238,0.6)' }} aria-label="Đăng xuất">
            <LogOut size={17} />
          </button>
        </div>
        {shopPicker && (
          <div className="max-w-xl mx-auto mt-2.5 rounded-xl overflow-hidden" style={{ backgroundColor: '#fff' }}>
            {shops.map(s => (
              <button key={s} onClick={() => { setActiveShop(s); setShopPicker(false); }}
                className="w-full text-left px-3.5 py-2.5 text-sm font-semibold flex items-center justify-between"
                style={{ color: INK, borderTop: s === shops[0] ? 'none' : `1px solid ${BORDER}`, backgroundColor: s === activeShop ? CREAM : '#fff' }}>
                {s}
                {s === activeShop && <Check size={15} style={{ color: GREEN }} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="max-w-xl mx-auto px-4 py-4 pb-24">
        {tab === 'today' && <TodayTab activeShop={activeShop} onOpenStore={openStore} onOnlineSales={() => router.push('/online-orders')} onTeam={() => setTab('team')} />}
        {tab === 'shops' && <ShopsTab shops={shops} activeShop={activeShop} onPick={s => { setActiveShop(s); setTab('today'); }} />}
        {tab === 'team' && <TeamTab activeShop={activeShop} />}
      </div>

      <div style={{ backgroundColor: TABBAR }} className="flex fixed bottom-0 left-0 right-0 z-10">
        {([
          ['today', PackageCheck, 'Hôm nay'],
          ['order', ShoppingBag, 'Đặt hàng'],
          ['shops', Box, 'Boutiques'],
          ['team', Users, 'Đội ngũ'],
        ] as const).map(([key, Icon, label]) => {
          const active = tab === key;
          return (
            <button key={key}
              onClick={() => key === 'order' ? openStore('order') : setTab(key as Tab)}
              className="flex-1 text-center py-2.5"
              style={{ color: active ? GOLD : '#8FAE9E', fontWeight: active ? 700 : 500, fontSize: 11.5, borderTop: `2px solid ${active ? GOLD : 'transparent'}` }}>
              <Icon size={17} className="mx-auto" />
              <div className="mt-0.5">{label}</div>
            </button>
          );
        })}
      </div>
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

function RecapCard({ icon: Icon, label, value, flag }: { icon: any; label: string; value: string; flag?: { color: string; text: string } }) {
  return (
    <div className="rounded-2xl p-3.5" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon size={14} style={{ color: INK_LIGHT }} />
        <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{label}</div>
      </div>
      <div className="text-sm font-bold" style={{ color: INK }}>{value}</div>
      {flag && <div className="text-[10.5px] font-bold mt-1" style={{ color: flag.color }}>{flag.text}</div>}
    </div>
  );
}

function TodayTab({ activeShop, onOpenStore, onOnlineSales, onTeam }: {
  activeShop: string; onOpenStore: (tab: 'deliveries' | 'order') => void; onOnlineSales: () => void; onTeam: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof actions.getManagerTodayRecapAction>> | null>(null);

  const load = useCallback(async () => {
    if (!activeShop) return;
    setData(null);
    const res = await actions.getManagerTodayRecapAction(activeShop);
    setData(res);
  }, [activeShop]);
  useEffect(() => { load(); }, [load]);

  const recap = data?.recap;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <QuickAction icon={ShoppingBag} label="Đặt hàng" onClick={() => onOpenStore('order')} />
        <QuickAction icon={Store} label="Giao diện shop" onClick={() => onOpenStore('deliveries')} />
        <QuickAction icon={Package2} label="Bán hàng online" onClick={onOnlineSales} />
        <QuickAction icon={Users} label="Đội ngũ" onClick={onTeam} />
      </div>

      {!data ? (
        <div className="text-center py-10"><Loader2 className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <RecapCard icon={Truck} label="Nhập hàng"
            value={recap?.reception ? `${recap.reception.confirmedLines}/${recap.reception.totalLines} dòng` : 'Chưa có'}
            flag={recap?.reception && recap.reception.discrepancies.length ? { color: RED, text: `${recap.reception.discrepancies.length} lệch số lượng` } : undefined} />
          <RecapCard icon={ClipboardList} label="Kiểm kho"
            value={recap?.count ? `${recap.count.skuCount} SKU · ${fmtVnd(recap.count.valuation)}` : 'Chưa kiểm'}
            flag={recap?.count ? { color: GREEN, text: `Xong lúc ${fmtTime(recap.count.finishedAt)}` } : undefined} />
          <RecapCard icon={ShoppingBag} label="Đặt hàng"
            value={recap ? `${recap.orders.length} đơn` : '0 đơn'}
            flag={recap && recap.orders.some(o => o.odooDirect) ? { color: AMBER, text: 'Có đơn đặt trực tiếp trên Odoo' } : undefined} />
          <RecapCard icon={Trash2} label="Hao hụt" value={recap ? `${recap.losses.totalQty} sản phẩm` : '0'} />
          <RecapCard icon={ArrowLeftRight} label="Chuyển kho"
            value={recap ? `${recap.transfers.length} phiếu` : '0'}
            flag={recap && recap.transfers.some(t => t.status === 'sent') ? { color: AMBER, text: 'Đang chờ nhận' } : undefined} />
          <RecapCard icon={Package2} label="Bán hàng online"
            value={data.online ? `${data.online.count} đơn · ${fmtVnd(data.online.total)}` : '0 đơn'} />
        </div>
      )}
    </div>
  );
}

function ShopsTab({ shops, activeShop, onPick }: { shops: string[]; activeShop: string; onPick: (s: string) => void }) {
  const [statuses, setStatuses] = useState<ManagerShopStatus[] | null>(null);
  useEffect(() => {
    (async () => {
      const res = await actions.getManagerShopsStatusAction();
      setStatuses(res.shops ?? []);
    })();
  }, []);

  return (
    <div className="space-y-2.5">
      <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>{shops.length} boutique{shops.length > 1 ? 's' : ''} · chạm để mở</div>
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
                <Pill ok={st.receptionTotal > 0 && st.receptionConfirmed >= st.receptionTotal} label={st.receptionTotal ? `Nhập ${st.receptionConfirmed}/${st.receptionTotal}` : 'Không có nhập hàng'} />
                <Pill ok={st.countDone} label={st.countDone ? 'Đã kiểm kho' : 'Chưa kiểm kho'} />
                <Pill ok={st.ordersOdooDirect === 0} label={`${st.ordersCount} đơn đặt hàng${st.ordersOdooDirect ? ` · ${st.ordersOdooDirect} qua Odoo` : ''}`} warn={st.ordersOdooDirect > 0} />
                {st.transfersPending > 0 && <Pill ok={false} warn label={`${st.transfersPending} chuyển kho chờ nhận`} />}
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
          <div className="text-xs font-bold uppercase tracking-wide" style={{ color: INK_LIGHT }}>Nhân viên — {activeShop}</div>
          <div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>Ai cũng sửa được</div>
        </div>
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
          {!staff ? (
            <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
          ) : !staff.length ? (
            <div className="py-4 px-3.5 text-xs" style={{ color: '#9CA3AF' }}>Chưa có nhân viên nào</div>
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
              placeholder="Tên nhân viên…" className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm" style={{ border: `1px solid ${BORDER}` }} />
            <button onClick={submitAdd} className="px-3 py-2 rounded-xl text-sm font-bold text-white" style={{ backgroundColor: NAVY }}>Lưu</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="w-full flex items-center justify-center gap-1.5 mt-2 rounded-xl px-3 py-2 text-xs font-semibold"
            style={{ border: `1px dashed ${BORDER}`, color: INK_LIGHT }}>
            <Plus size={14} /> Thêm nhân viên
          </button>
        )}
      </div>

      <div>
        <div className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: INK_LIGHT }}>Quản lý</div>
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
          {!managers ? (
            <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline" style={{ color: INK_LIGHT }} /></div>
          ) : !managers.length ? (
            <div className="py-4 px-3.5 text-xs" style={{ color: '#9CA3AF' }}>Chưa có quản lý nào</div>
          ) : managers.map((m, i) => (
            <div key={m.id} className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ borderTop: i === 0 ? 'none' : `1px solid ${CREAM_DARK}` }}>
              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
              <div className="text-sm font-bold flex-1 min-w-0" style={{ color: INK }}>{m.name}</div>
              <div className="text-[11px] shrink-0" style={{ color: '#9CA3AF' }}>{m.allFiveShops ? 'Tất cả 5 boutique' : `${m.shopsCount} boutique`}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11px]" style={{ color: '#9CA3AF' }}>Thêm/sửa quản lý: liên hệ Lab (admin).</div>
      </div>
    </div>
  );
}
