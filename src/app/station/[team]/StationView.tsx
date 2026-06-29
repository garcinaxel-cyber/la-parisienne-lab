'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2, Play, AlertCircle, Clock, FlaskConical, Minus, Plus,
  BookOpen, X, Timer, Thermometer, LogOut, Store, Package, ClipboardList,
  History, CalendarDays, Lock,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, type Team, type AssignmentStatus } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

function SearchIcon({ size = 15, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  );
}

type BreakdownItem = { shop_name: string; qty: number; order_ref?: string; delivery_time?: string | null };

type Assignment = {
  id: string;
  product_id: string | null;
  product_name_vi: string;
  product_name_en: string;
  image_url: string | null;
  variant_label: string;
  total_qty: number;
  qty_to_produce: number;
  qty_produced: number;
  status: AssignmentStatus;
  notes: string;
  sort_order: number;
  import_id: string;
  is_extra?: boolean;
  sku: string | null;
  weight_grams: number | null;
  category_name_vi: string | null;
  category_name_en: string | null;
  breakdown: BreakdownItem[];
  lab_imports: { delivery_date: string; order_number: number; type: string; status: string };
};

type SearchProduct = {
  id: string; name_vi: string; name_en: string | null;
  sku: string | null; main_image_url: string | null;
  is_lab_only: boolean; category_id: string | null; subcategory: string | null;
};

type Category = { id: string; name_vi: string; name_en: string };

type FicheStep = {
  step_number: number; description_vi: string; description_en: string;
  duration_minutes: number | null; temperature_celsius: number | null;
};

// Historical assignment (simplified, grouped by date)
type HistoryDay = {
  date: string;
  assignments: Assignment[];
};

// Upcoming day with its assignments
type UpcomingDay = {
  date: string;
  import_id: string;
  order_number: number;
  assignments: Assignment[];
};

type Tab = 'production' | 'commande' | 'termine' | 'historique' | 'upcoming';

const STATUS_FLOW: Record<string, string> = {
  pending: 'in_progress',
  in_progress: 'done',
  skip: 'pending',
};

export default function StationView({
  team, assignments: initial, today, isWorker,
}: {
  team: Team;
  teamSlug?: string;
  assignments: Assignment[];
  today: string;
  isWorker: boolean;
}) {
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const [assignments, setAssignments] = useState(initial);
  const [updating, setUpdating] = useState<string | null>(null);
  const [qtyModal, setQtyModal] = useState<Assignment | null>(null);
  const [qtyInput, setQtyInput] = useState(0);
  const [ficheModal, setFicheModal] = useState<{ productId: string; productName: string } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('production');

  // Extra production modal
  const [extraModal, setExtraModal] = useState(false);
  const [extraSearch, setExtraSearch] = useState('');
  const [extraResults, setExtraResults] = useState<SearchProduct[]>([]);
  const [extraProduct, setExtraProduct] = useState<SearchProduct | null>(null);
  const [extraQty, setExtraQty] = useState(1);
  const [extraQtyInput, setExtraQtyInput] = useState('1');
  const [savingExtra, setSavingExtra] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [extraCategories, setExtraCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');

  // History tab state
  const [history, setHistory] = useState<HistoryDay[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Upcoming tab state
  const [upcoming, setUpcoming] = useState<UpcomingDay[] | null>(null);
  const [upcomingLoading, setUpcomingLoading] = useState(false);

  const meta = TEAM_LABELS[team];
  function handlePartial(a: Assignment) { setQtyInput(a.qty_produced); setQtyModal(a); }
  function handleViewFiche(a: Assignment) { if (a.product_id) setFicheModal({ productId: a.product_id, productName: a.product_name_vi }); }
  const sharedCardProps = {
    lang, updating, isWorker,
    onAdvance: advanceStatus,
    onMarkInStock: markInStock,
    onPartial: handlePartial,
    onViewFiche: handleViewFiche,
    meta,
  };

  // Load history when tab selected
  useEffect(() => {
    if (activeTab !== 'historique' || history !== null) return;
    setHistoryLoading(true);
    const load = async () => {
      const supabase = createClient();
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const fromDate = sevenDaysAgo.toISOString().split('T')[0];

      const { data } = await supabase
        .from('lab_assignments')
        .select(`
          id, product_id, product_name_vi, product_name_en, image_url,
          variant_label, total_qty, qty_to_produce, qty_produced,
          status, is_extra, notes, sort_order, import_id,
          lab_imports!inner(delivery_date, order_number, type, status)
        `)
        .eq('team', team)
        .eq('lab_imports.status', 'published')
        .gte('lab_imports.delivery_date', fromDate)
        .lt('lab_imports.delivery_date', today)
        .order('sort_order');

      const rows = (data ?? []).map((a: any) => ({
        ...a,
        sku: null, weight_grams: null, category_name_vi: null, category_name_en: null,
        breakdown: [],
        lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
        products: undefined,
      }));

      // Group by date descending
      const byDate = new Map<string, Assignment[]>();
      for (const a of rows) {
        const d = a.lab_imports?.delivery_date ?? '';
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d)!.push(a);
      }
      const sorted = Array.from(byDate.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, assignments]) => ({ date, assignments }));

      setHistory(sorted);
      setHistoryLoading(false);
    };
    load();
  }, [activeTab, history, team, today]);

  // Load upcoming when tab selected
  useEffect(() => {
    if (activeTab !== 'upcoming' || upcoming !== null) return;
    setUpcomingLoading(true);
    const load = async () => {
      const supabase = createClient();

      const { data } = await supabase
        .from('lab_assignments')
        .select(`
          id, product_id, product_name_vi, product_name_en, image_url,
          variant_label, total_qty, qty_to_produce, qty_produced,
          status, is_extra, notes, sort_order, import_id,
          lab_imports!inner(delivery_date, order_number, type, status)
        `)
        .eq('team', team)
        .eq('lab_imports.status', 'published')
        .gt('lab_imports.delivery_date', today)
        .order('sort_order');

      const rows = (data ?? []).map((a: any) => ({
        ...a,
        sku: null, weight_grams: null, category_name_vi: null, category_name_en: null,
        breakdown: [],
        lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
        products: undefined,
      }));

      // Group by date ascending
      const byDate = new Map<string, { import_id: string; order_number: number; assignments: Assignment[] }>();
      for (const a of rows) {
        const d = a.lab_imports?.delivery_date ?? '';
        if (!byDate.has(d)) byDate.set(d, { import_id: a.import_id, order_number: a.lab_imports?.order_number ?? 0, assignments: [] });
        byDate.get(d)!.assignments.push(a);
      }
      const sorted = Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, v]) => ({ date, import_id: v.import_id, order_number: v.order_number, assignments: v.assignments }));

      setUpcoming(sorted);
      setUpcomingLoading(false);
    };
    load();
  }, [activeTab, upcoming, team, today]);

  useEffect(() => {
    if (!extraModal || extraCategories.length > 0) return;
    const supabase = createClient();
    supabase.from('categories').select('id, name_vi, name_en').order('sort_order')
      .then(({ data }) => setExtraCategories(data ?? []));
  }, [extraModal]);

  useEffect(() => {
    if (!extraModal || extraProduct) return;
    if (extraSearch.trim().length < 1 && !selectedCategory) { setExtraResults([]); return; }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const params = new URLSearchParams();
        if (extraSearch.trim()) params.set('q', extraSearch.trim());
        params.set('team', team);
        if (selectedCategory) params.set('category', selectedCategory);
        const res = await fetch(`/api/lab/products-search?${params.toString()}`);
        const data = await res.json();
        setExtraResults(Array.isArray(data) ? data : []);
      } catch { setExtraResults([]); }
      finally { setSearchLoading(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [extraSearch, extraModal, extraProduct, team, selectedCategory]);

  // Supabase Realtime for today's assignments
  useEffect(() => {
    const supabase = createClient();
    const importIds = Array.from(new Set(initial.map(a => a.import_id)));
    if (importIds.length === 0) return;
    const channel = supabase
      .channel(`station-${team}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'lab_assignments',
        filter: `import_id=in.(${importIds.join(',')})`,
      }, payload => {
        setAssignments(prev => prev.map(a =>
          a.id === payload.new.id ? { ...a, ...payload.new } : a
        ));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [team, initial]);

  async function advanceStatus(a: Assignment) {
    if (isWorker) return; // workers cannot advance status
    const next = STATUS_FLOW[a.status];
    if (!next) return;
    setUpdating(a.id);
    const supabase = createClient();
    const update: any = { status: next, updated_at: new Date().toISOString() };
    if (next === 'done') update.qty_produced = a.qty_to_produce;
    await supabase.from('lab_assignments').update(update).eq('id', a.id);
    setAssignments(prev => prev.map(x => x.id === a.id ? { ...x, ...update } : x));
    setUpdating(null);
  }

  async function markInStock(a: Assignment) {
    if (isWorker) return;
    setUpdating(a.id);
    const supabase = createClient();
    const update = { status: 'skip' as AssignmentStatus, updated_at: new Date().toISOString() };
    await supabase.from('lab_assignments').update(update).eq('id', a.id);
    setAssignments(prev => prev.map(x => x.id === a.id ? { ...x, ...update } : x));
    setUpdating(null);
  }

  async function savePartial() {
    if (!qtyModal || isWorker) return;
    const supabase = createClient();
    const update = {
      status: qtyInput >= qtyModal.qty_to_produce ? 'done' : 'partial' as AssignmentStatus,
      qty_produced: qtyInput,
      updated_at: new Date().toISOString(),
    };
    await supabase.from('lab_assignments').update(update).eq('id', qtyModal.id);
    setAssignments(prev => prev.map(x => x.id === qtyModal.id ? { ...x, ...update } : x));
    setQtyModal(null);
  }

  async function saveExtra() {
    if (!extraProduct || extraQty < 1 || isWorker) return;
    setSavingExtra(true);
    const importId = assignments[0]?.import_id;
    if (!importId) { setSavingExtra(false); return; }
    const supabase = createClient();
    const row = {
      import_id: importId, team,
      product_name_vi: extraProduct.name_vi,
      product_name_en: extraProduct.name_en ?? '',
      image_url: extraProduct.main_image_url,
      product_id: extraProduct.id,
      variant_label: 'Standard',
      total_qty: extraQty, qty_to_produce: extraQty, qty_produced: extraQty,
      status: 'done' as AssignmentStatus, sort_order: 9999, is_extra: true, breakdown: [] as BreakdownItem[],
    };
    const { data } = await supabase.from('lab_assignments').insert(row).select('id').single();
    if (data) {
      setAssignments(prev => [...prev, {
        ...row, id: data.id, notes: '', sku: extraProduct.sku ?? null, weight_grams: null,
        category_name_vi: null, category_name_en: null,
        lab_imports: prev[0]?.lab_imports ?? { delivery_date: today, order_number: 1, type: 'daily', status: 'published' },
      }]);
    }
    closeExtraModal();
    setSavingExtra(false);
  }

  function closeExtraModal() {
    setExtraModal(false); setExtraSearch(''); setExtraResults([]);
    setExtraProduct(null); setExtraQty(1); setExtraQtyInput('1'); setSelectedCategory('');
  }

  const production = assignments.filter(a => ['pending', 'in_progress', 'partial', 'blocked'].includes(a.status));
  const termine = assignments.filter(a => ['done', 'skip'].includes(a.status));

  const totalQty = assignments.filter(a => a.status !== 'skip').reduce((s, a) => s + a.qty_to_produce, 0);
  const doneQty = assignments.filter(a => a.status === 'done').reduce((s, a) => s + a.qty_produced, 0);
  const pct = totalQty ? Math.round(doneQty / totalQty * 100) : 0;

  const termineCount = termine.length;

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

  const tabs = [
    { id: 'production' as Tab, labelVi: 'Sản xuất', labelEn: 'Production', count: production.length },
    { id: 'commande' as Tab, labelVi: 'Đơn hàng', labelEn: 'Orders', count: assignments.length },
    { id: 'termine' as Tab, labelVi: 'Hoàn thành', labelEn: 'Done', count: termineCount },
    { id: 'historique' as Tab, labelVi: 'Lịch sử', labelEn: 'History' },
    { id: 'upcoming' as Tab, labelVi: 'Sắp tới', labelEn: 'Upcoming' },
  ];


  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FFF4CC' }}>
      {/* Top bar */}
      <header className="sticky top-0 z-20" style={{ backgroundColor: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(255,244,204,0.2)' }}>
              <FlaskConical size={18} className="text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-white font-bold text-sm leading-tight truncate flex items-center gap-1.5">
                {lang === 'vi' ? meta.vi : meta.en}
                {isWorker && (
                  <span className="flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                    style={{ backgroundColor: 'rgba(255,244,204,0.2)', color: '#FFF4CC' }}>
                    <Lock size={8} /> Worker
                  </span>
                )}
              </div>
              <div className="text-white/60 text-[11px]">{formatDate(today)}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="rounded-full px-3 py-1 text-xs font-bold"
              style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
              {doneQty}/{totalQty}
            </div>
            <div className="flex gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
              {(['vi', 'en'] as const).map(l => (
                <button key={l} onClick={() => setLang(l)}
                  className="px-2 py-1 rounded text-xs font-bold transition-colors"
                  style={lang === l
                    ? { backgroundColor: '#FFF4CC', color: '#1A4731' }
                    : { color: 'rgba(255,255,255,0.7)' }
                  }>{l.toUpperCase()}</button>
              ))}
            </div>
            <Link href="/station/fiches" title={lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe cards'}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
              <BookOpen size={15} />
            </Link>
            <button onClick={logout} title={lang === 'vi' ? 'Đăng xuất' : 'Log out'}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors active:scale-95"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
              <LogOut size={15} />
            </button>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-1" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
          <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: '#C9A84C' }} />
        </div>

        {/* Tab navigation */}
        <div className="flex border-t overflow-x-auto" style={{ borderColor: 'rgba(255,255,255,0.15)', backgroundColor: '#163D29' }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className="flex-1 flex items-center justify-center gap-1 py-2.5 text-[11px] font-bold transition-colors whitespace-nowrap px-1"
              style={activeTab === tab.id
                ? { color: '#C9A84C', borderBottom: '2px solid #C9A84C' }
                : { color: 'rgba(255,255,255,0.55)', borderBottom: '2px solid transparent' }
              }>
              {tab.id === 'production' ? <FlaskConical size={14} /> :
               tab.id === 'commande' ? <ClipboardList size={14} /> :
               tab.id === 'termine' ? <CheckCircle2 size={14} /> :
               tab.id === 'historique' ? <History size={14} /> :
               <CalendarDays size={14} />}
              {lang === 'vi' ? tab.labelVi : tab.labelEn}
              {tab.count != null && tab.count > 0 && (
                <span className="rounded-full px-1.5 py-0.5 text-[9px] font-black"
                  style={activeTab === tab.id
                    ? { backgroundColor: '#C9A84C', color: '#1A4731' }
                    : { backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.7)' }
                  }>{tab.count}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      {pct === 100 && assignments.length > 0 && (
        <div className="text-center py-3 text-sm font-bold" style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
          {lang === 'vi' ? '🎉 Hoàn thành tất cả!' : '🎉 All done for today!'}
        </div>
      )}

      {/* ─── PRODUCTION TAB ─── */}
      {activeTab === 'production' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-28">
          {production.length === 0 && (
            <div className="text-center py-20">
              <CheckCircle2 size={48} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
              <p className="font-semibold" style={{ color: '#1A4731' }}>
                {lang === 'vi' ? 'Không có sản phẩm cần làm' : 'Nothing left to produce'}
              </p>
              <p className="text-sm mt-1 text-gray-400">
                {lang === 'vi' ? 'Tất cả đã hoàn thành hoặc có sẵn' : 'All items are done or in stock'}
              </p>
            </div>
          )}
          {production.map(a => <ProductionCard key={a.id} a={a} {...sharedCardProps} />)}
        </div>
      )}

      {/* ─── COMMANDES TAB ─── */}
      {activeTab === 'commande' && (
        <div className="max-w-3xl mx-auto px-4 py-5 pb-10">
          {assignments.length === 0 ? (
            <div className="text-center py-20">
              <ClipboardList size={48} className="mx-auto mb-3 text-gray-300" />
              <p className="font-semibold text-gray-400">
                {lang === 'vi' ? 'Chưa có đơn hàng hôm nay' : 'No orders for today'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl px-5 py-4 flex items-center justify-between"
                style={{ backgroundColor: '#1A4731', color: 'white' }}>
                <div>
                  <div className="font-bold text-base">
                    {lang === 'vi' ? 'Tổng đơn hàng hôm nay' : "Today's order summary"}
                  </div>
                  <div className="text-white/70 text-sm mt-0.5">
                    {assignments.length} {lang === 'vi' ? 'sản phẩm' : 'products'} — {totalQty} {lang === 'vi' ? 'cái' : 'units'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-black" style={{ color: '#C9A84C' }}>{pct}%</div>
                  <div className="text-white/60 text-xs">{lang === 'vi' ? 'Hoàn thành' : 'Complete'}</div>
                </div>
              </div>
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A', backgroundColor: 'white' }}>
                <div className="px-4 py-2.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider"
                  style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderBottom: '1px solid #E0D49A' }}>
                  <span>{lang === 'vi' ? 'Sản phẩm' : 'Product'}</span>
                  <span>{lang === 'vi' ? 'Số lượng' : 'Qty'}</span>
                </div>
                {assignments.map((a, i) => {
                  const st = STATUS_META[a.status];
                  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];
                  return (
                    <div key={a.id} style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
                      <div className="flex items-center gap-3 px-4 py-3">
                        {a.image_url ? (
                          <img src={a.image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
                            style={{ border: '1px solid #E0D49A' }} />
                        ) : (
                          <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-xl"
                            style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm" style={{ color: '#1A4731' }}>
                            {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {a.sku && <span className="text-[10px] font-mono font-semibold px-1 py-0.5 rounded" style={{ backgroundColor: '#F5F5F5', color: '#555' }}>{a.sku}</span>}
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: st.color }}>
                              {lang === 'vi' ? st.labelVi : st.labelEn}
                            </span>
                          </div>
                        </div>
                        <div className="text-2xl font-black shrink-0" style={{ color: meta.color }}>×{a.qty_to_produce}</div>
                      </div>
                      {breakdown.length > 0 && (
                        <div className="pb-3">
                          {breakdown.map((b, bi) => (
                            <div key={bi} className="flex items-center justify-between px-5 py-1.5 text-sm"
                              style={{ backgroundColor: bi % 2 === 0 ? '#FFFDF0' : '#FFFAEE' }}>
                              <div className="flex items-center gap-2 text-gray-500">
                                <Store size={11} className="shrink-0" />
                                <span>{b.shop_name}</span>
                                {b.delivery_time && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                                    style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                                    ⏰ {b.delivery_time.slice(0, 5)}
                                  </span>
                                )}
                              </div>
                              <span className="font-bold text-sm" style={{ color: '#1A4731' }}>×{b.qty}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── TERMINÉ TAB ─── */}
      {activeTab === 'termine' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-10">
          {termine.length === 0 ? (
            <div className="text-center py-20">
              <Clock size={48} className="mx-auto mb-3 text-gray-300" />
              <p className="font-semibold text-gray-400">
                {lang === 'vi' ? 'Chưa có sản phẩm hoàn thành' : 'No completed items yet'}
              </p>
            </div>
          ) : (
            termine.map(a => <TermineCard key={a.id} a={a} lang={lang} meta={meta} onAdvance={advanceStatus} updating={updating} isWorker={isWorker} />)
          )}
        </div>
      )}

      {/* ─── HISTORIQUE TAB (7 jours) ─── */}
      {activeTab === 'historique' && (
        <div className="max-w-3xl mx-auto px-4 py-5 pb-10">
          {historyLoading && (
            <div className="text-center py-20 text-sm font-semibold" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? 'Đang tải lịch sử…' : 'Loading history…'}
            </div>
          )}
          {!historyLoading && history !== null && history.length === 0 && (
            <div className="text-center py-20">
              <History size={48} className="mx-auto mb-3 text-gray-300" />
              <p className="font-semibold text-gray-400">
                {lang === 'vi' ? 'Chưa có lịch sử 7 ngày qua' : 'No history in the last 7 days'}
              </p>
            </div>
          )}
          {!historyLoading && history !== null && history.map(({ date, assignments: dayAssignments }) => {
            const dayDone = dayAssignments.filter(a => a.status === 'done').reduce((s, a) => s + a.qty_produced, 0);
            const dayTotal = dayAssignments.filter(a => a.status !== 'skip').reduce((s, a) => s + a.qty_to_produce, 0);
            return (
              <section key={date} className="mb-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-px flex-1" style={{ backgroundColor: '#E0D49A' }} />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: '#1A4731' }}>
                      {formatDate(date)}
                    </span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
                      {dayDone}/{dayTotal}
                    </span>
                  </div>
                  <div className="h-px flex-1" style={{ backgroundColor: '#E0D49A' }} />
                  </div>
                <div className="space-y-2">
                  {dayAssignments.map(a => (
                    <HistoryCard key={a.id} a={a} lang={lang} meta={meta} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ─── UPCOMING TAB ─── */}
      {activeTab === 'u/ming' && (
        <div className="max-w-3xl mx-auto px-4 py-5 pb-10">
          {upcomingLoading && (
            <div className="text-center py-20 text-sm font-semibold" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? 'Đang tải đơn sắp tới…' : 'Loading upcoming orders…'}
            </div>
          )}
          {!upcomingLoading && upcoming !== null && upcoming.length === 0 && (
            <div className="text-center py-20">
              <CalendarDays size={48} className="mx-auto mb-3 text-gray-300" />
              <p className="font-semibold text-gray-400">
                {lang === 'vi' ? 'Chưa có đơn hàng sắp tới' : 'No upcoming orders'}
              </p>
            </div>
          )}
          {!upcomingLoading && upcoming !== null && upcoming.map(({ date, order_number, assignments: dayAssignments }) => {
            const totalUnits = dayAssignments.reduce((s, a) => s + a.qty_to_produce, 0);
            const daysFromNow = Math.ceil((new Date(date).getTime() - new Date(today).getTime()) / 86400000);
            return (
              <section key={date} className="mb-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-px flex-1" style={{ backgroundColor: '#E0D49A' }} />
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: '#1A4731' }}>
                      {formatDate(date)}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: daysFromNow === 1 ? '#FEF3C7' : '#F0F9F4', color: daysFromNow === 1 ? '#D97706' : '#2D6A4F' }}>
                      {daysFromNow === 1
                        ? (lang === 'vi' ? 'Ngày mai' : 'Tomo2row')
                        : `J+${daysFromNow}`}
                    </span>
                    <span className="text-[10px] text-gray-400">{totalUnits} {lang === 'vi' ? 'cái' : 'units'}</span>
                  </div>
                  <div className="h-px flex-1" style={{ backgroundColor: '#E0D49A' }} />
                </div>
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A', backgroundColor: 'white' }}>
                  {dayAssignments.map((a, i) => (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-3"
                      style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
                      {a.image_url ? (
                        <img src={a.image_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0"
                          style={{ border: '1px solid #E0D49A' }} loading="lazy" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-lg"
                          style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: '#1A4731' }}>
                          {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                        </div>
                        <div className="text-xs text-gray-400">{a.variant_label}</div>
                      </div>
                      <div className="text-xl font-black shrink-0" style={{ color: meta.color }}>
                        ×{a.qty_to_produce}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* FAB — Add extra (Production tab only, not workers) */}
      {activeTab === 'production' && assignments.length > 0 && !isWorker && (
        <div className="fixed bottom-6 inset-x-0 flex justify-center z-10 pointer-events-none">
          <button
            onClick={() => setExtraModal(true)}
            className="pointer-events-auto flex items-center gap-2 px-5 py-3 rounded-full font-bold text-sm shadow-xl active:scale-95 transition-all"
            style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
            <Plus size={16} />
            {lang === 'vi' ? 'Sản xuất thêm ngoài đơn' : 'Add extra production'}
          </button>
        </div>
      )}

      {/* Fiche modal */}
      {ficheModal && (
        <FicheModal productId={ficheModal.productId} productName={ficheModal.productName}
          lang={lang} onClose={() => setFicheModal(null)} />
      )}

      {/* Extra production modal */}
      {extraModal && !isWorker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={closeExtraModal}>
          <div className="bg-white w-full max-w-sm rounded-t-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#1A4731' }}>
                  {lang === 'vi' ? 'Sản xuất thêm ngoài đơn' : 'Extra production'}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {lang === 'vi' ? 'Chọn sản phẩm từ danh mục' : 'Select from catalogue'}
                </p>
              </div>
              <button onClick={closeExtraModal} className="p-1 text-gray-400"><X size={20} /></button>
            </div>
            <div className="px-5 pb-5 space-y-4">
              {!extraProduct && extraCategories.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  <button onClick={() => setSelectedCategory('')}
                    className="px-3 py-1 rounded-full text-xs font-bold transition-colors"
                    style={selectedCategory === '' ? { backgroundColor: '#1A4731', color: 'white' } : { backgroundColor: '#F3F4F6', color: '#6B7280' }}>
                    {lang === 'vi' ? 'Tất cả' : 'All'}
                  </button>
                  {extraCategories.map(cat => (
                    <button key={cat.id} onClick={() => setSelectedCategory(cat.id === selectedCategory ? '' : cat.id)}
                      className="px-3 py-1 rounded-full text-xs font-bold transition-colors"
                      style={selectedCategory === cat.id ? { backgroundColor: '#1A4731', color: 'white' } : { backgroundColor: '#F3F4F6', color: '#6B7280' }}>
                      {lang === 'vi' ? cat.name_vi : cat.name_en}
                    </button>
                  ))}
                </div>
              )}
              {extraProduct ? (
                <div className="flex items-center gap-3 rounded-xl p-3" style={{ backgroundColor: '#F0F9F4', border: '1.5px solid #2D6A4F' }}>
                  {extraProduct.main_image_url
                    ? <img src={extraProduct.main_image_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                    : <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-xl" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>{extraProduct.name_vi}</div>
                  </d)v>
                  <button onClick={() => { setExtraProduct(null); setExtraSearch(''); }} className="p-1 text-gray-400"><X size={16} /></button>
                </div>
              ) : (
                <div>
                  <div className="relative">
                    <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input value={extraSearch} onChange={e => setExtraSearch(e.target.value)}
                      placeholder={lang === 'vi' ? 'Tên sản phẩm hoặc SKU…' : 'Product name or SKU…'}
                      className="w-full rounded-xl border border-gray-200 pl-9 pr-3 py-2.5 text-sm outline-none focus:border-green-600" autoFocus />
                    {searchLoading && <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-green-600 border-t-transparent animate-spin" />}
                  </div>
                  {extraResults.length > 0 && (
                    <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
                      {extraResults.map((p, i) => (
                        <button key={p.id} onClick={() => setExtraProduct(p)}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-green-50"
                          style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
                          {p.main_image_url
                            ? <img src={p.main_image_url} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                            : <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                          }
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>{p.name_vi}</div>
                            {p.sku && <div className="text-[10px] font-mono text-gray-400">{p.sku}</div>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {extraProduct && (
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                    {lang === 'vi' ? 'Số lượng' : 'Quantity'}
                  </label>
                  <div className="flex items-center gap-3 mt-2">
                    <button onClick={() => { const v = Math.max(1, extraQty - 1); setExtraQty(v); setExtraQtyInput(String(v)); }}
                      className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center" style={{ color: '#1A4731' }}>
                      <Minus size={18} />
                    </button>
                    <input type="number" min={1} value={extraQtyInput}
                      onChange={e => { setExtraQtyInput(e.target.value); const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setExtraQty(v); }}
                      onBlur={() => { const v = parseInt(extraQtyInput, 10); const safe = isNaN(v) || v < 1 ? 1 : v; setExtraQty(safe); setExtraQtyInput(String(safe)); }}
                      className="text-4xl font-black text-center rounded-xl border-2 outline-none w-20 py-1"
                      style={{ color: '#1A4731', borderColor: '#1A4731' }} />
                    <button onClick={() => { const v = extraQty + 1; setExtraQty(v); setExtraQtyInput(String(v)); }}
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white"
                      style={{ back'roundColor: '#1A4731' }}>
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={closeExtraModal} className="flex-1 py-3 rounded-xl font-semibold border border-gray-200 text-gray-500">
                  {lang === 'vi' ? 'Hủy' : 'Cancel'}
                </button>
                <button onClick={saveExtra} disabled={!extraProduct || savingExtra}
                  className="flex-1 py-3 rounded-xl font-bold text-white disabled:opacity-40"
                  style={{ backgroundColor: '#1A4731' }}>
                  {savingExtra ? '…' : (lang === 'vi' ? 'Xác nhận' : 'Confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Qty modal */}
      {qtyModal && !isWorker && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white w-full max-w-sm rounded-t-2xl p-6 space-y-5">
            <div>
              <h3 className="font-bold text-base" style={{ color: '#1A4731' }}>{qtyModal.product_name_vi}</h3>
              <p className="text-sm text-gray-400 mt-0.5">
                {lang === 'vi' ? 'Cần làm' : 'Target'}: <strong>{qtyModal.qty_to_produce}</strong>
              </p>
            </div>
            <div className="flex items-center justify-cen4er gap-4">
              <button onClick={() => setQtyInput(q => Math.max(0, q - 1))}
                className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center" style={{ color: '#1A4731' }}>
                <Minus size={20} />
              </button>
              <input type="number" min={0} value={qtyInput}
                onChange={e => setQtyInput(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="text-5xl font-black text-center rounded-xl border-2 outline-none w-24 py-2"
                style={{ color: '#1A4731', borderColor: '#1A4731' }} />
              <button onClick={() => setQtyInput(q => q + 1)}
                className="w-12 h-12 rounded-full flex items-center justify-center text-7hite" style={{ backgroundColor: '#1A4731' }}>
                <Plus size={20} />
              </button>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setQtyModal(null)} className="flex-1 py-3 rounded-xl font-semibold border border-gray-200 text-gray-400">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button onClick={savePartial} className="flex-1 py-3 rounded-xl font-bold text-white" style={{ backgroundColor: '#1A4731' }}>
                {lang === 'vi' ? 'Xác nhận' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PRODUCTION CARD ──────────────────────────────────────────────────────────

function ProductionCard({ a, lang, updating, isWorker, onAdvance, onMarkInStock, onPartial, onViewFiche, meta }: {
  a: Assignment; lang: 'vi' | 'en'; updating: string | null; isWorker: boolean;
  onAdvance: (a: Assignment) => void; onMarkInStock: (a: Assignment) => void;
  onPartial: (a: Assignment) => void; onViewFiche: (a: Assignment) => void;
  meta: typeof TEAM_LABELS[Team];
}) {
  const st = STATUS_META[a.status];
  const isUpdating = updating === a.id;
  const canAdvance = !isWorker && ['pending', 'in_progress'].includes(a.status);
  const canMarkStock = !isWorker && ['pending', 'in_progress'].includes(a.status) && !a.is_extra;
  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];

  const actionLabel: Record<string, string> = {
    pending: lang === 'vi' ? 'Bắt đầu' : 'Start',
    in_progress: lang === 'vi' ? 'Xong' : 'Mark done',
  };

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ backgroundColor: 'white', border: '1px solid #E0D49A', boxShadow: '0 1px 4px rgba(26,71,49,0.07)' }}>
      {a.status === 'in_progress' && <div className="h-1" style={{ backgroundColor: '#2563EB' }} />}
      <div className="flex items-start p-4 gap-3">
        {a.image_url
          ? <img src={a.image_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} loading="lazy" />
          : <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
        }
        <div className="flex-1 min-w-0">
          {a.product_id ? (
            <Link href={`/station/fiche/${a.product_id}?back=/station/me`}
              className="font-bold text-base leading-tight block hover:underline" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </Link>
          ) : (
            <div className="font-bold text-base leading-tight" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </div>
          )}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
     0      {a.sku && <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded" style={{ backgroundColor: '#F5F5F5', color: '#555' }}>{a.sku}</span>}
            {a.weight_grams && <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ backgroundColor: '#FFF4CC', color: '#92600A' }}>{a.weight_grams}g</span>}
            {a.is_extra && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#FEF3C7', color: '#D97706' }}>{lang === 'vi' ? '+ Ngoài đơn' : '+ Extra'}</span>}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-2xl font-black" style={{ color: meta.color }}>×{a.qty_to_produce}</span>
            {a.qty_produced > 0 && a.status !== 'done' && <span className="text-sm text-gray-400">(✓ {a.qty_produced})</span>}
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: st.color }}>
              {lang === 'vi' ? st.labelVi : st.labelEn}
            </span>
          </div>
        </div>
        {!isWorker && (
          <div className="flex flex-col gap-2 shrink-0">
            {canAdvance && (
              <button onClick={() => onAdvance(a)} disabled={isUpdating}
                className="px-4 py-2.5 rounded-xl font-bold text-white text-sm active:scale-95 transition-all"
                style={{ backgroundColor: '#1A4731', opacity: isUpdating ? 0.6 : 1 }}>
                {isUpdating ? '…' : actionLabel[a.status] ?? ''}
              </button>
            )}
            {canMarkStock && (
              <button onClick={() => onMarkInStock(a)} disabled={isUpdating}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 active:scale-95"
                style={{ border: '1px solid #C4B5FD', color: '#6D28D9', backgroundColor: '#F5F3FF', opacity: isUpdating ? 0.6 : 1 }}>
                <Package size={11} /> {lang === 'vi' ? 'Có sẵn' : 'In stock'}
              </button>
            )}
            {a.status === 'in_progress' && (
              <button onClick={() => onPartial(a)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border text-center"
                style={{ borderColor: '#E0D49A', color: '#6B7280' }}>
                {lang === 'vi' ? 'Ghi số' : 'Enter qty'}
              </button>
            )}
          </div>
        )}
      </div>
      {breakdown.length > 0 && (
        <div className="border-t" style={{ borderColor: '#F5EFC8' }}>
          <div className="px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5"
            style={{ color: '#2D6A4F', backgroundColor: '#F0F9F4' }}>
            <Store size={10} /> {lang === 'vi' ? 'Chi tiết theo khách hàng' : 'Per-client breakdown'}
          </div>
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2 text-sm"
              style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined, backgroundColor: i % 2 === 0 ? 'white' : '#FFFAEE' }}>
              <span className="font-medium flex items-center gap-1.5" style={{ color: '#444' }}>
                {b.shop_name}
                {b.delivery_time && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                    ⏰ {b.delivery_time.slice(0, 5)}
                  </span>
                )}
              </span>
              <span className="font-black" style={{ color: '#1A4731' }}>×{b.qty}</span>
            </div>
          ))}
        </div>
      )}
      {(a.notes || a.product_id) && (
        <div className="px-4 pb-3 pt-2 flex items-center justify-between gap-2" style={{ borderTop: '1px solid #F5EFC8' }}>
          {a.notes ? <span className="text-xs text-gray-400 flex-1 italic">{a.notes}</span> : <span />}
          {a.product_id && (
            <button onClick={() => onViewFiche(a)}
              className="flex items-center gap-1 text-xs font-semibold transition-colors shrink-0"
              style={{ color: '#2D6A4F' }}>
              <BookOpen size={12} /> {lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe card'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TERMINÉ CARD ─────────────────────────────────────────────────────────────

function TermineCard({ a, lang, meta, onAdvance, updating, isWorker }: {
  a: Assignment; lang: 'vi' | 'en'; meta: typeof TEAM_LABELS[Team];
  onAdvance: (a: Assignment) => void; updating: string | null; isWorker: boolean;
}) {
  const isSkip = a.status === 'skip';
  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ backgroundColor: isSkip ? '#F5F3FF' : 'white', border: isSkip ? '1.5px solid #C4B5FD' : '1px solid #E0D49A', opacity: isSkip ? 1 : 0.75 }}>
      <div className="flex items-center gap-3 p-4">
        {a.image_url
          ? <img src={a.image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} />
          : <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-xl" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
        }
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm" style={{ color: '#1A4731' }}>
            {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {isSkip ? (
              <span className="text-xs font-semibold flex items-center gap-1" style={{ color: '#6D28D9' }}>
                <Package size={11} /> {lang === 'vi' ? 'Có sẵn trong kho' : 'In stock'}
              </span>
            ) : (
              <span className="text-xs font-semibold flex items-center gap-1" style={{ color: '#059669' }}>
                <CheckCircle2 size={11} /> {lang === 'vi' ? `Đã làm ×${a.qty_produced}` : `Done ×${a.qty_produced}`}
              </span>
            )}
            <span className="text-xl font-black" style={{ color: isSkip ? '#7C3AED' : meta.color }}>×{a.qty_to_produce}</span>
          </div>
        </div>
        {isSkip && !isWorker && (
          <button onClick={() => onAdvance(a)} disabled={updating === a.id}
            className="px-3 py-2 rounded-xl text-xs font-bold active:scale-95"
            style={{ backgroundColor: '#EDE9FE', color: '#6D28D9', opacity: updating === a.id ? 0.6 : 1 }}>
            {lang === 'vi' ? 'Cần làm' : 'Produce'}
          </button>
        )}
      </div>
      {!isSkip && breakdown.length > 0 && (
        <div className="border-t" style={{ borderColor: '#F5EFC8' }}>
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-1.5 text-xs text-gray-400"
              style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
              <span>{b.shop_name}</span><span className="font-bold">×{b.qty}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── HISTORY CARD ─────────────────────────────────────────────────────────────

function HistoryCard({ a, lang, meta }: { a: Assignment; lang: 'vi' | 'en'; meta: typeof TEAM_LABELS[Team] }) {
  const st = STATUS_META[a.status];
  return (
    <div className="flex items-center gap-3 bg-white rounded-2xl px-4 py-3"
      style={{ border: '1px solid #E0D49A', opacity: 0.85 }}>
      {a.image_url
        ? <img src={a.image_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} loading="lazy" />
        : <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
      }
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate" style={{ color: '#1A4731' }}>
          {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
        </div>
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold text-white mt-0.5" style={{ backgroundColor: st.color }}>
          {lang === 'vi' ? st.labelVi : st.labelEn}
        </span>
      </div>
      <div className="text-right shrink-0">
        <div className="text-lg font-black" style={{ color: meta.color }}>×{a.qty_to_produce}</div>
        {a.qty_produced > 0 && a.status === 'done' && (
          <div className="text-[10px] text-gray-400">✓ {a.qty_produced}</div>
        )}
      </div>
    </div>
  );
}

// ─── FICHE MODAL ──────────────────────────────────────────────────────────────

function FicheModal({ productId, productName, lang, onClose }: {
  productId: string; productName: string; lang: 'vi' | 'en'; onClose: () => void;
}) {
  const [steps, setSteps] = useState<FicheStep[] | null>(null);
  useEffect(() => {
    const supabase = createClient();
    supabase.from('lab_fiche_steps').select('step_number, description_vi, description_en, duration_minutes, temperature_celsius')
      .eq('fiche_id', productId).eq('step_type', 'step').order('step_number')
      .then(({ data }) => setSteps(data ?? []));
  }, [productId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: '1px solid #E0D49A' }}>
          <div className="flex items-center gap-2">
            <BookOpen size={18} style={{ color: '#1A4731' }} />
            <span className="font-bold text-base" style={{ color: '#1A4731' }}>{productName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/station/fiche/${productId}?back=/station/me`}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg"
              style={{ backgroundColor: '#FFF4CC', color: '#1A4731' }}>
              {lang === 'vi' ? 'Xem đầy đủ' : 'Full view'}
            </Link>
            <button onClick={onClose} className="p-1 text-gray-400"><X size={20} /></button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {steps === null ? (
            <p className="text-gray-400 text-sm text-center py-10">{lang === 'vi' ? 'Đang tải…' : 'Loading…'}</p>
          ) : steps.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-gray-400 text-sm">{lang === 'vi' ? 'Chưa có phiếu kỹ thuật.' : 'No recipe steps yet.'}</p>
              <Link href={`/station/fiche/${productId}?back=/station/me`} className="text-xs font-semibold mt-2 inline-block" style={{ color: '#1A4731' }}>
                {lang === 'vi' ? 'Xem trang phiếu →' : 'View fiche page →'}
              </Link>
            </div>
          ) : steps.map(step => (
            <div key={step.step_number} className="flex gap-3">
              <div className="w-7 h-7 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5" style={{ backgroundColor: '#1A4731' }}>
                {step.step_number}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-sm leading-relaxed" style={{ color: '#1A2C24' }}>
                  {lang === 'vi' ? step.description_vi : (step.description_en || step.description_vi)}
                </p>
                {(step.duration_minutes || step.temperature_celsius) && (
                  <div className="flex gap-4 text-xs text-gray-400">
                    {step.duration_minutes && <span className="flex items-center gap-1"><Timer size={11} /> {step.duration_minutes} {lang === 'vi' ? 'phút' : 'min'}</span>}
                    {step.temperature_celsius && <span className="flex items-center gap-1"><Thermometer size={11} /> {step.temperature_celsius}°C</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
