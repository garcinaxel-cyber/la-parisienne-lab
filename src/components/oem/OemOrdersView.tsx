'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Factory, Package, Truck, Boxes, Settings2, Loader2, RefreshCw, History, AlertTriangle, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';
import { byClient, derive, dmy, fmt, itemKg, localToday, mondayOf, GREEN, GOLD, FAINT, MUTED, LINE, type Item, type ProdLog, type PackLog, type Hist, type Delivery, type FgCount, type Ingredient, type Usage, type RmCount } from './model';
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
// Redesign (Axel, 2026-09-25): client switch on top, a short "to do" strip, 4 tabs —
//   Today (packaging entry) · Progress · Deliveries (+ ready stock) · Inventory (finished / raw)
//   + for admin/lab_manager: Production (kg) log and Settings.

type Tab = 'today' | 'progress' | 'deliveries' | 'inventory' | 'production' | 'settings';
const STAFF = ['admin', 'lab_manager', 'assistant'];
const MANAGERS = ['admin', 'lab_manager'];

export default function OemOrdersView({ role, userId, userName }: { role: string; userId: string | null; userName: string | null }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = useCallback((v: string, e: string) => (vi ? v : e), [vi]);
  const supabase = useMemo(() => createClient(), []);
  const canManage = MANAGERS.includes(role);
  const canPack = STAFF.includes(role);
  // Production (kg) log + Settings (Odoo switch, order quantities): admin only (Axel, 2026-09-25).
  // lab_manager keeps the right to correct any packaging line (canManage) inside the normal tabs.
  const isAdmin = role === 'admin';

  const [tab, setTab] = useState<Tab>('today');
  const [clientName, setClientName] = useState<string | null>(null);
  const [inv, setInv] = useState<'fg' | 'rm'>('fg');
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
      supabase.from('lab_mm_production_log').select('id, prod_date, group_key, sku, weight_kg, note, created_at, created_by_name, status, received_kg, received_at, received_by_name, receive_note').order('prod_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
      supabase.from('lab_mm_packaging_log').select('*').order('pack_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000),
      supabase.from('lab_mm_order_item_history').select('id, sku, qty_before, qty_after, changed_at, changed_by_name').order('changed_at', { ascending: false }).limit(50),
      supabase.rpc('lab_mm_deliveries'),
      supabase.from('lab_mm_fg_counts').select('id, count_date, sku, qty_counted, qty_theoretical, gap, status, created_at, created_by_name, decided_by_name').order('count_date', { ascending: false }).limit(2000),
      supabase.from('lab_mm_ingredients').select('code, name, unit, sort_order').order('sort_order'),
      supabase.from('lab_mm_ingredient_usage').select('group_key, ingredient_code, qty_per_kg'),
      supabase.from('lab_mm_rm_inventory').select('id, week_start, ingredient_code, qty, created_at, created_by_name').order('week_start', { ascending: false }).limit(2000),
      supabase.from('lab_mm_settings').select('key, value'),
    ]);
    const e = [it, pl, pk, hs, dl, fc, ing, us, rc, st].find(r => r.error)?.error;
    if (e) setErr(e.message);
    setItems((it.data ?? []).map((r: any) => ({ ...r, unit_weight_g: Number(r.unit_weight_g), qty_ordered: Number(r.qty_ordered) })));
    setProd((pl.data ?? []).map((r: any) => ({ ...r, weight_kg: Number(r.weight_kg), received_kg: r.received_kg == null ? null : Number(r.received_kg) })));
    setPack((pk.data ?? []).map((r: any) => ({ ...r, qty: Number(r.qty) })));
    setHist((hs.data ?? []) as Hist[]);
    setDeliveries((dl.data ?? []) as Delivery[]);
    setFg((fc.data ?? []).map((r: any) => ({ ...r, qty_counted: Number(r.qty_counted), qty_theoretical: r.qty_theoretical == null ? null : Number(r.qty_theoretical), gap: r.gap == null ? null : Number(r.gap) })));
    setIngredients((ing.data ?? []) as Ingredient[]);
    setUsage((us.data ?? []).map((r: any) => ({ ...r, qty_per_kg: Number(r.qty_per_kg) })));
    setRm((rc.data ?? []).map((r: any) => ({ ...r, qty: Number(r.qty) })));
    setSettings(Object.fromEntries((st.data ?? []).map((r: any) => [r.key, r.value])));
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const clients = useMemo(() => byClient(items), [items]);
  const client = clients.find(c => c.name === clientName) ?? clients[0];
  const cItems = useMemo(() => (client ? client.groups.flatMap(g => g.items) : []), [client]);
  const cSkus = useMemo(() => new Set(cItems.map(i => i.sku)), [cItems]);
  const cGroups = useMemo(() => new Set(cItems.map(i => i.group_key)), [cItems]);
  const d = useMemo(() => derive(items, prod, pack, deliveries), [items, prod, pack, deliveries]);
  const groupName = useCallback((k: string) => items.find(i => i.group_key === k)?.group_name ?? k, [items]);
  const odooOn = settings.odoo_mo_enabled === 'true';

  // ── "to do" strip (max 4) ──
  const todos = useMemo(() => {
    if (!client) return [] as { text: string; tab: Tab; tone: 'gold' | 'red' | 'grey' }[];
    const out: { text: string; tab: Tab; tone: 'gold' | 'red' | 'grey' }[] = [];
    const toReceive = prod.filter(p => p.status === 'pending' && cGroups.has(p.group_key));
    if (toReceive.length) out.push({ tone: 'red', tab: 'today', text: L(`${toReceive.length} mẻ của Hưng cần nhận (${fmt(toReceive.reduce((s, p) => s + Number(p.weight_kg), 0), 1)} kg)`, `${toReceive.length} batch(es) from Hưng to receive (${fmt(toReceive.reduce((s, p) => s + Number(p.weight_kg), 0), 1)} kg)`) });
    const gapsPending = fg.filter(c => c.status === 'pending_admin' && cSkus.has(c.sku)).length;
    if (gapsPending) out.push({ tone: 'red', tab: 'inventory', text: L(`${gapsPending} chênh lệch kiểm kê chờ admin duyệt`, `${gapsPending} inventory gap(s) waiting for admin`) });
    const toPack = client.groups.map(g => ({ g, kg: Math.max(0, d.bulkAvail[g.key] ?? 0) })).filter(x => x.kg > 0.5).sort((a, b) => b.kg - a.kg);
    if (toPack.length) out.push({ tone: 'gold', tab: 'today', text: toPack.length === 1
      ? L(`${fmt(toPack[0].kg, 1)} kg ${toPack[0].g.title} đã nướng, chờ gói`, `${fmt(toPack[0].kg, 1)} kg of ${toPack[0].g.title} baked, waiting to be packed`)
      : L(`${fmt(toPack.reduce((s, x) => s + x.kg, 0), 1)} kg bán TP chờ gói (${toPack.length} sản phẩm)`, `${fmt(toPack.reduce((s, x) => s + x.kg, 0), 1)} kg baked, waiting to be packed (${toPack.length} products)`) });
    // next delivery not covered by the ready stock
    const today = localToday();
    const upcoming = deliveries.filter(x => cSkus.has(x.sku) && x.delivery_date >= today && x.order_status !== 'validated' && !x.not_delivered);
    if (upcoming.length) {
      const first = upcoming.reduce((a, b) => (a.delivery_date <= b.delivery_date ? a : b));
      const lines = upcoming.filter(x => x.order_ref === first.order_ref && x.delivery_date === first.delivery_date);
      const missing = lines.reduce((s, x) => s + Math.max(0, Number(x.qty_planned ?? x.qty_expected ?? 0) - Math.max(0, d.fgTheo[x.sku] ?? 0)), 0);
      if (missing > 0.0005) out.push({ tone: 'red', tab: 'deliveries', text: L(`Giao ${dmy(first.delivery_date)} (${first.order_ref}): thiếu ${fmt(missing, 0)}`, `Delivery ${dmy(first.delivery_date)} (${first.order_ref}): ${fmt(missing, 0)} missing`) });
    }
    const monday = mondayOf(today);
    const packedAny = cItems.some(i => (d.packedQty[i.sku] ?? 0) > 0);
    if (packedAny && !fg.some(c => cSkus.has(c.sku) && c.count_date >= monday)) out.push({ tone: 'grey', tab: 'inventory', text: L('Chưa kiểm kê thành phẩm tuần này', 'Finished-goods count not done this week') });
    if (!rm.some(c => c.week_start >= monday)) out.push({ tone: 'grey', tab: 'inventory', text: L('Chưa kiểm kê nguyên liệu tuần này', 'Raw-material count not done this week') });
    const errs = pack.filter(p => p.odoo_status === 'error' && cSkus.has(p.sku)).length;
    if (errs) out.push({ tone: 'red', tab: 'today', text: L(`${errs} dòng lỗi Odoo`, `${errs} Odoo error(s)`) });
    return out.slice(0, 4);
  }, [client, d, deliveries, cSkus, cGroups, cItems, fg, rm, pack, prod, L]);

  const TABS: { key: Tab; icon: any; label: string; manage?: boolean }[] = [
    { key: 'today', icon: Package, label: L('Hôm nay', 'Today') },
    { key: 'progress', icon: Factory, label: L('Tiến độ', 'Progress') },
    { key: 'inventory', icon: Boxes, label: L('Kiểm kê', 'Inventory') },
    { key: 'deliveries', icon: Truck, label: L('Giao hàng', 'Deliveries') },
    { key: 'production', icon: History, label: L('Sản xuất (kg)', 'Production (kg)'), manage: true },
    { key: 'settings', icon: Settings2, label: L('Cài đặt', 'Settings'), manage: true },
  ];
  const toneStyle = { gold: { backgroundColor: '#FFF7E6', color: '#8A6A2F', border: '1px solid #F3E3C0' }, red: { backgroundColor: '#FEF2F2', color: '#B91C1C', border: '1px solid #FBD5D5' }, grey: { backgroundColor: '#fff', color: '#4B5563', border: `1px solid ${LINE}` } };

  const cPack = useMemo(() => pack.filter(p => cSkus.has(p.sku) || cGroups.has(p.group_key)), [pack, cSkus, cGroups]);
  const cProd = useMemo(() => prod.filter(p => cGroups.has(p.group_key)), [prod, cGroups]);
  const cDeliv = useMemo(() => deliveries.filter(x => cSkus.has(x.sku)), [deliveries, cSkus]);
  const cFg = useMemo(() => fg.filter(x => cSkus.has(x.sku)), [fg, cSkus]);

  if (loading && !items.length) return <div className="flex justify-center py-10"><Loader2 className="animate-spin" style={{ color: GREEN }} /></div>;

  return (
    <div className="space-y-4">
      {/* client switch */}
      <div className="flex items-center gap-2">
        <div className="flex flex-1 min-w-0 rounded-2xl p-1 gap-1" style={{ backgroundColor: '#EFE9DC' }}>
          {clients.map(c => {
            const on = c.name === client?.name;
            const its = c.groups.flatMap(g => g.items);
            const kg = its.reduce((s, i) => s + itemKg(i, i.qty_ordered), 0);
            return (
              <button key={c.name} onClick={() => setClientName(c.name)} className="flex-1 min-w-0 rounded-xl px-3 py-2 text-left transition"
                style={on ? { backgroundColor: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.06)' } : {}}>
                <div className="text-sm font-bold truncate" style={{ color: on ? GREEN : MUTED }}>{c.name.replace('CÔNG TY CỔ PHẦN ', '')}</div>
                <div className="text-[11px] tabular-nums truncate" style={{ color: FAINT }}>{fmt(kg, 0)} kg{settings.deadline ? ` · ${L('hạn', 'due')} ${dmy(settings.deadline)}` : ''}</div>
              </button>
            );
          })}
        </div>
        <button onClick={load} className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center" style={{ border: `1px solid ${LINE}`, backgroundColor: '#fff', color: MUTED }} aria-label="refresh">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>{err}</div>}

      {todos.length > 0 && (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {todos.map((t, k) => (
            <button key={k} onClick={() => { setTab(t.tab); if (t.text.includes(L('nguyên liệu', 'Raw-material'))) setInv('rm'); else if (t.tab === 'inventory') setInv('fg'); }}
              className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-semibold" style={toneStyle[t.tone]}>
              {t.tone === 'red' ? <AlertTriangle size={14} className="shrink-0" /> : <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: t.tone === 'gold' ? GOLD : FAINT }} />}
              <span className="flex-1">{t.text}</span><ChevronRight size={14} className="shrink-0 opacity-50" />
            </button>
          ))}
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-0.5" style={{ borderBottom: `1px solid ${LINE}` }}>
        {TABS.filter(t => !t.manage || isAdmin).map(t => {
          const Icon = t.icon; const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold"
              style={{ color: on ? GREEN : MUTED, borderBottom: `2px solid ${on ? GOLD : 'transparent'}`, marginBottom: -1 }}>
              <Icon size={15} />{t.label}
            </button>
          );
        })}
      </div>

      {!client ? null : tab === 'today' ? (
        <Packaging client={client} items={cItems} d={d} pack={cPack} prod={cProd} canPack={canPack} canManage={canManage} odooOn={odooOn} userId={userId} reload={load} L={L} />
      ) : tab === 'progress' ? (
        <Overview client={client} d={d} prod={cProd} pack={cPack} L={L} />
      ) : tab === 'deliveries' ? (
        <Deliveries deliveries={cDeliv} items={cItems} d={d} showCheckLink={canPack} L={L} />
      ) : tab === 'inventory' ? (
        <div className="space-y-3">
          <div className="inline-flex rounded-xl p-1 gap-1" style={{ backgroundColor: '#EFE9DC' }}>
            {([['fg', L('Thành phẩm', 'Finished goods')], ['rm', L('Nguyên liệu', 'Raw materials')]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setInv(k)} className="rounded-lg px-3 py-1.5 text-sm font-semibold" style={inv === k ? { backgroundColor: '#fff', color: GREEN } : { color: MUTED }}>{l}</button>
            ))}
          </div>
          {inv === 'fg'
            ? <FinishedGoods client={client} items={cItems} d={d} counts={cFg} canCount={canPack} isAdmin={isAdmin} reload={load} L={L} />
            : <RawMaterials items={items} d={d} ingredients={ingredients} usage={usage} counts={rm} prod={prod} canCount={canPack} userId={userId} userName={userName} reload={load} L={L} />}
        </div>
      ) : tab === 'production' && isAdmin ? (
        <ProductionLog logs={cProd} items={cItems} groupName={groupName} canManage={canManage} userId={userId} userName={userName} reload={load} L={L} />
      ) : tab === 'settings' && isAdmin ? (
        <OrderSettings items={items} hist={hist} odooOn={odooOn} userId={userId} userName={userName} reload={load} L={L} />
      ) : null}
    </div>
  );
}
