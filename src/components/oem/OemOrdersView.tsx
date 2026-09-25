'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Factory, Package, Truck, Boxes, Wheat, Settings2, Loader2, RefreshCw, History } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import { byClient, derive, dmy, fmt, GREEN, FAINT, MUTED, type Item, type ProdLog, type PackLog, type Hist, type Delivery, type FgCount, type Ingredient, type Usage, type RmCount } from './model';
import Overview from './Overview';
import Packaging from './Packaging';
import Deliveries from './Deliveries';
import FinishedGoods from './FinishedGoods';
import RawMaterials from './RawMaterials';
import { ProductionLog, OrderSettings } from './Admin';

// OEM Orders tracker (Axel, 2026-09-25) — Maison Mooncake biscuits (MM- SKUs) + Tianhe Food
// cashews (OEM- SKUs). Purely additive: reads/writes the lab_mm_* tables only (+ the read-only
// lab_mm_deliveries() projection of the delivery check). Shared by the office page (/oem-orders)
// and Team Hung's station (/station/oem) so both see exactly the same thing; what each person can
// enter depends on their role (chef/worker: read-only).
//   Daily operations: Overview · Production log · Packaging · Deliveries
//   Inventory (weekly count): Finished goods · Raw materials
//   Settings (admin/lab_manager): order quantities + history, Odoo sync switch

type Tab = 'overview' | 'production' | 'packaging' | 'deliveries' | 'fg' | 'rm' | 'settings';
const STAFF = ['admin', 'lab_manager', 'assistant'];
const MANAGERS = ['admin', 'lab_manager'];

export default function OemOrdersView({ role, userId, userName }: { role: string; userId: string | null; userName: string | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = useCallback((v: string, e: string) => (vi ? v : e), [vi]);
  const supabase = useMemo(() => createClient(), []);
  const canManage = MANAGERS.includes(role);
  const canPack = STAFF.includes(role);

  const [tab, setTab] = useState<Tab>('overview');
  const [items, setItems] = useState<Item[]>([]);
  const [prod, setProd] = useState<ProdLog[]>([]);
  const [pack, setPack] = useState<PackLog[]>([]);
  const [hist, setHist] = useState<Hist[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [fg, setFg] = useState<FgCount[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [rm, setRm] = useState<RmCount[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const [it, pl, pk, hs, dl, fc, ing, us, rc, st] = await Promise.all([
      supabase.from('lab_mm_order_items').select('sku, product_name, group_key, group_name, unit, unit_weight_g, qty_ordered, sort_order, is_active, client_name, updated_at, updated_by_name').eq('is_active', true).order('sort_order'),
      supabase.from('lab_mm_production_log').select('id, prod_date, group_key, sku, weight_kg, note, created_at, created_by_name').order('prod_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
      supabase.from('lab_mm_packaging_log').select('*').order('pack_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
      supabase.from('lab_mm_order_item_history').select('id, sku, qty_before, qty_after, changed_at, changed_by_name').order('changed_at', { ascending: false }).limit(50),
      supabase.rpc('lab_mm_deliveries'),
      supabase.from('lab_mm_fg_counts').select('id, count_date, sku, qty_counted, qty_theoretical, created_at, created_by_name').order('count_date', { ascending: false }).limit(2000),
      supabase.from('lab_mm_ingredients').select('code, name, unit, sort_order').order('sort_order'),
      supabase.from('lab_mm_ingredient_usage').select('group_key, ingredient_code, qty_per_kg'),
      supabase.from('lab_mm_rm_inventory').select('id, week_start, ingredient_code, qty, created_at, created_by_name').order('week_start', { ascending: false }).limit(2000),
      supabase.from('lab_mm_settings').select('key, value'),
    ]);
    const e = [it, pl, pk, hs, dl, fc, ing, us, rc, st].find(r => r.error)?.error;
    if (e) setErr(e.message);
    setItems((it.data ?? []).map((r: any) => ({ ...r, unit_weight_g: Number(r.unit_weight_g), qty_ordered: Number(r.qty_ordered) })));
    setProd((pl.data ?? []).map((r: any) => ({ ...r, weight_kg: Number(r.weight_kg) })));
    setPack((pk.data ?? []).map((r: any) => ({ ...r, qty: Number(r.qty) })));
    setHist((hs.data ?? []) as Hist[]);
    setDeliveries((dl.data ?? []) as Delivery[]);
    setFg((fc.data ?? []).map((r: any) => ({ ...r, qty_counted: Number(r.qty_counted), qty_theoretical: r.qty_theoretical == null ? null : Number(r.qty_theoretical) })));
    setIngredients((ing.data ?? []) as Ingredient[]);
    setUsage((us.data ?? []).map((r: any) => ({ ...r, qty_per_kg: Number(r.qty_per_kg) })));
    setRm((rc.data ?? []).map((r: any) => ({ ...r, qty: Number(r.qty) })));
    setSettings(Object.fromEntries((st.data ?? []).map((r: any) => [r.key, r.value])));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const clients = useMemo(() => byClient(items), [items]);
  const d = useMemo(() => derive(items, prod, pack, deliveries), [items, prod, pack, deliveries]);
  const groupName = useCallback((k: string) => items.find(i => i.group_key === k)?.group_name ?? k, [items]);
  const odooOn = settings.odoo_mo_enabled === 'true';

  const TABS: { key: Tab; icon: any; label: string; manage?: boolean; family: 'ops' | 'inv' | 'cfg' }[] = [
    { key: 'overview', icon: Factory, label: L('Tổng quan', 'Overview'), family: 'ops' },
    { key: 'production', icon: History, label: L('Sản xuất (kg)', 'Production (kg)'), family: 'ops' },
    { key: 'packaging', icon: Package, label: L('Đóng gói', 'Packaging'), family: 'ops' },
    { key: 'deliveries', icon: Truck, label: L('Giao hàng', 'Deliveries'), family: 'ops' },
    { key: 'fg', icon: Boxes, label: L('Thành phẩm', 'Finished goods'), family: 'inv' },
    { key: 'rm', icon: Wheat, label: L('Nguyên liệu', 'Raw materials'), family: 'inv' },
    { key: 'settings', icon: Settings2, label: L('Cài đặt đơn', 'Order settings'), manage: true, family: 'cfg' },
  ];
  const famLabel = { ops: L('Vận hành · hằng ngày', 'Daily operations · every day'), inv: L('Kiểm kê · hằng tuần', 'Inventory · weekly count'), cfg: L('Cài đặt', 'Settings') };

  const summary = clients.map(c => {
    const its = c.groups.flatMap(g => g.items);
    const kg = its.reduce((s, i) => s + (i.unit === 'kg' ? i.qty_ordered : (i.qty_ordered * i.unit_weight_g) / 1000), 0);
    const bags = its.filter(i => i.unit === 'bag').reduce((s, i) => s + i.qty_ordered, 0);
    return `${c.name} · ${bags ? `${fmt(bags, 0)} ${L('gói', 'bags')} · ` : ''}${fmt(kg, 0)} kg`;
  });

  return (
    <div className="space-y-4">
      {summary.length > 0 && (
        <div className="text-xs" style={{ color: MUTED }}>
          {summary.join('  |  ')}{settings.deadline ? `  |  ${L('Hạn', 'Deadline')} ${dmy(settings.deadline)}` : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 items-end">
        {(['ops', 'inv', 'cfg'] as const).map(fam => {
          const ts = TABS.filter(t => t.family === fam && (!t.manage || canManage));
          if (!ts.length) return null;
          return (
            <div key={fam}>
              <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: FAINT }}>{famLabel[fam]}</div>
              <div className="flex flex-wrap gap-1.5">
                {ts.map(t => {
                  const Icon = t.icon; const active = tab === t.key;
                  return (
                    <button key={t.key} onClick={() => setTab(t.key)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg px-2.5 py-1.5"
                      style={active ? { backgroundColor: fam === 'inv' ? '#8A6A2F' : GREEN, color: '#fff' } : { backgroundColor: '#fff', color: '#374151', border: '1px solid #E5E7EB' }}>
                      <Icon size={13} />{t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <button onClick={load} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold rounded-lg px-2.5 py-1.5" style={{ border: '1px solid #E5E7EB', color: MUTED, backgroundColor: '#fff' }}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />{L('Làm mới', 'Refresh')}
        </button>
      </div>

      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{err}</div>}

      {loading && !items.length ? (
        <div className="flex justify-center py-10"><Loader2 className="animate-spin" style={{ color: GREEN }} /></div>
      ) : tab === 'overview' ? (
        <Overview clients={clients} d={d} prod={prod} pack={pack} L={L} />
      ) : tab === 'production' ? (
        <ProductionLog logs={prod} items={items} groupName={groupName} canManage={canManage} userId={userId} userName={userName} reload={load} L={L} />
      ) : tab === 'packaging' ? (
        <Packaging clients={clients} items={items} d={d} pack={pack} canPack={canPack} canManage={canManage} odooOn={odooOn} userId={userId} reload={load} L={L} />
      ) : tab === 'deliveries' ? (
        <Deliveries deliveries={deliveries} items={items} d={d} showCheckLink={canPack} L={L} />
      ) : tab === 'fg' ? (
        <FinishedGoods clients={clients} items={items} d={d} counts={fg} canCount={canPack} userId={userId} userName={userName} reload={load} L={L} />
      ) : tab === 'rm' ? (
        <RawMaterials items={items} d={d} ingredients={ingredients} usage={usage} counts={rm} prod={prod} canCount={canPack} userId={userId} userName={userName} reload={load} L={L} />
      ) : tab === 'settings' && canManage ? (
        <OrderSettings items={items} hist={hist} odooOn={odooOn} userId={userId} userName={userName} reload={load} L={L} />
      ) : null}
    </div>
  );
}
