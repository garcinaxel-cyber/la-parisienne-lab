'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2, Play, AlertCircle, Clock, FlaskConical, Minus, Plus,
  BookOpen, X, Timer, Thermometer, LogOut, Store, Package, ClipboardList,
  ChevronRight, PenLine,
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

// Skeleton placeholder for a date-summary row (upcoming/history tabs)
function SkeletonRow() {
  return (
    <div className="w-full rounded-2xl px-5 py-4 bg-white flex items-center justify-between" style={{ border: '1px solid #E0D49A' }}>
      <div className="space-y-2 flex-1">
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-3 w-28" />
      </div>
      <div className="skeleton h-4 w-4 rounded-full" />
    </div>
  );
}

type BreakdownItem = { shop_name: string; qty: number; order_ref?: string; delivery_time?: string | null; note?: string | null };

type Assignment = {
  id: string;
  fiche_id: string | null;
  variant_id: string | null;
  product_name_vi: string;
  product_name_en: string;
  image_url: string | null;
  variant_label: string;
  total_qty: number;
  qty_to_produce: number;
  qty_produced: number;
  status: AssignmentStatus;
  notes: string;
  blocked_reason: string | null;
  sort_order: number;
  import_id: string;
  is_extra?: boolean;
  produced_ahead?: boolean;
  cancelled?: boolean;
  transferred?: boolean;
  bc_message?: string | null;
  bc_ready_time?: string | null;
  sku: string | null;
  weight_grams: number | null;
  category_name_vi: string | null;
  category_name_en: string | null;
  breakdown: BreakdownItem[];
  lab_imports: { delivery_date: string; order_number: number; type: string; status: string };
};

// Search result = a lab fiche (id is the fiche_id, variant_id its default variant)
type SearchProduct = {
  id: string;
  name_vi: string;
  name_en: string | null;
  sku: string | null;
  variant_id: string | null;
  main_image_url: string | null;
  variants?: { id: string; sku: string | null; label: string; image_url: string | null }[];
  is_lab_only: boolean;
  category_id: string | null;
  subcategory: string | null;
};
type ExtraVariant = { id: string; sku: string | null; label: string; image_url: string | null };

type Category = { id: string; name_vi: string; name_en: string };

type FicheStep = {
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
};

type Tab = 'production' | 'commande' | 'termine' | 'upcoming' | 'history';

type DateSummary = {
  delivery_date: string;
  productCount: number;
  totalQty: number;
  doneQty: number;
  import_ids: string[];
};

type OrderDetail = {
  order_ref: string;
  shop_name: string;
  items: { product_name_vi: string; variant_label: string; qty: number }[];
};

const STATUS_FLOW: Partial<Record<AssignmentStatus, AssignmentStatus>> = {
  pending: 'in_progress',
  in_progress: 'done',
  skip: 'pending',
  blocked: 'pending',
};

export default function StationView({
  team, teamSlug, assignments: initial, tomorrowAssignments = [], viewDate, today, tomorrow, isHistoryView, userRole,
}: {
  team: Team;
  teamSlug: string;
  assignments: Assignment[];
  tomorrowAssignments?: Assignment[];
  viewDate: string;
  today: string;
  tomorrow?: string;
  isHistoryView: boolean;
  userRole?: string | null;
}) {
  const { lang, setLang } = useI18n();
  const router = useRouter();
  // Production day sub-toggle: today (default) or tomorrow (pre-production)
  const [prodDay, setProdDay] = useState<'today' | 'tomorrow'>('today');
  const [showInStock, setShowInStock] = useState(false);
  const [showRecap, setShowRecap] = useState(true);
  const [todayAssignments, setTodayAssignments] = useState(initial);
  const [tomorrowAsg, setTomorrowAsg] = useState(tomorrowAssignments);
  const assignments = prodDay === 'tomorrow' ? tomorrowAsg : todayAssignments;
  const setAssignments = prodDay === 'tomorrow' ? setTomorrowAsg : setTodayAssignments;
  const [updating, setUpdating] = useState<string | null>(null);
  const [qtyModal, setQtyModal] = useState<Assignment | null>(null);
  const [qtyInput, setQtyInput] = useState(0);
  const [ficheModal, setFicheModal] = useState<{ ficheId: string; productName: string } | null>(null);
  const [blockedModal, setBlockedModal] = useState<Assignment | null>(null);
  const [blockedReason, setBlockedReason] = useState('');
  const [blockedCustom, setBlockedCustom] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('production');
  const [upcomingData, setUpcomingData] = useState<DateSummary[]>([]);
  const [historyData, setHistoryData] = useState<DateSummary[]>([]);
  const [loadingDates, setLoadingDates] = useState(false);
  const [expandedHistoryDate, setExpandedHistoryDate] = useState<string | null>(null);
  const [historyDetails, setHistoryDetails] = useState<Record<string, OrderDetail[]>>({});
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Stock transfer (send finished products to stock)
  const [stockModal, setStockModal] = useState(false);
  const [stockSel, setStockSel] = useState<Record<string, { on: boolean; qty: string }>>({});
  const [sendingStock, setSendingStock] = useState(false);

  // Extra production modal
  const [extraModal, setExtraModal] = useState(false);
  const [extraSearch, setExtraSearch] = useState('');
  const [extraResults, setExtraResults] = useState<SearchProduct[]>([]);
  const [extraProduct, setExtraProduct] = useState<SearchProduct | null>(null);
  const [extraVariant, setExtraVariant] = useState<ExtraVariant | null>(null);
  const [extraQty, setExtraQty] = useState(1);
  const [extraQtyInput, setExtraQtyInput] = useState('1');
  const [savingExtra, setSavingExtra] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [extraCategories, setExtraCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');

  const meta = TEAM_LABELS[team];

  // Fetch categories when modal opens — from lab fiches (free-text category), not the catalogue
  useEffect(() => {
    if (!extraModal || extraCategories.length > 0) return;
    const supabase = createClient();
    supabase.from('lab_fiche_meta').select('category').eq('is_active', true).not('category', 'is', null)
      .then(({ data }) => {
        const names = Array.from(new Set((data ?? []).map((r: any) => String(r.category).trim()).filter(Boolean))).sort();
        setExtraCategories(names.map(n => ({ id: n, name_vi: n, name_en: n })));
      });
  }, [extraModal]);

  // Debounced product search — filtered by team + category
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
      } catch {
        setExtraResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [extraSearch, extraModal, extraProduct, team, selectedCategory]);

  // Supabase Realtime — covers both today + tomorrow imports, updates whichever list holds the id
  useEffect(() => {
    const supabase = createClient();
    const importIds = Array.from(new Set([...initial, ...tomorrowAssignments].map(a => a.import_id)));
    if (importIds.length === 0) return;

    const channel = supabase
      .channel(`station-${team}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'lab_assignments',
        filter: `import_id=in.(${importIds.join(',')})`,
      }, payload => {
        const patch = (a: Assignment) => a.id === payload.new.id ? { ...a, ...payload.new } : a;
        setTodayAssignments(prev => prev.map(patch));
        setTomorrowAsg(prev => prev.map(patch));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [team, initial, tomorrowAssignments]);

  // Lazy-load upcoming / history dates
  useEffect(() => {
    if (activeTab !== 'upcoming' && activeTab !== 'history') return;
    const cache = activeTab === 'upcoming' ? upcomingData : historyData;
    if (cache.length > 0) return;
    setLoadingDates(true);
    const supabase = createClient();
    const isUpcoming = activeTab === 'upcoming';
    supabase
      .from('lab_imports')
      .select('id, delivery_date')
      .eq('status', 'published')
      [isUpcoming ? 'gt' : 'lt']('delivery_date', today)
      .order('delivery_date', { ascending: isUpcoming })
      .limit(20)
      .then(async ({ data: imports }) => {
        if (!imports?.length) {
          if (isUpcoming) setUpcomingData([]);
          else setHistoryData([]);
          setLoadingDates(false);
          return;
        }
        const importIds = imports.map((i: any) => i.id);
        const { data: asgns } = await supabase
          .from('lab_assignments')
          .select('import_id, qty_to_produce, status')
          .in('import_id', importIds)
          .eq('team', team);
        const byDate = new Map<string, DateSummary>();
        for (const imp of imports) {
          if (!byDate.has(imp.delivery_date))
            byDate.set(imp.delivery_date, { delivery_date: imp.delivery_date, productCount: 0, totalQty: 0, doneQty: 0, import_ids: [] });
          byDate.get(imp.delivery_date)!.import_ids.push(imp.id);
        }
        for (const a of asgns ?? []) {
          const imp = imports.find((i: any) => i.id === a.import_id);
          if (!imp) continue;
          const s = byDate.get(imp.delivery_date)!;
          s.productCount++;
          s.totalQty += a.qty_to_produce ?? 0;
          if (a.status === 'done' || a.status === 'skip') s.doneQty += a.qty_to_produce ?? 0;
        }
        const result = Array.from(byDate.values()).filter(d => d.productCount > 0);
        if (isUpcoming) setUpcomingData(result);
        else setHistoryData(result);
        setLoadingDates(false);
      });
  }, [activeTab, team, today]);

  async function loadHistoryDetails(delivery_date: string, import_ids: string[]) {
    if (historyDetails[delivery_date] !== undefined) return;
    setLoadingDetails(true);
    const supabase = createClient();
    const { data: lines } = await supabase
      .from('lab_order_lines')
      .select('order_ref, shop_name, product_name_vi, variant_label, qty')
      .in('import_id', import_ids)
      .eq('team', team)
      .order('order_ref');
    const byRef = new Map<string, OrderDetail>();
    for (const line of lines ?? []) {
      if (!byRef.has(line.order_ref))
        byRef.set(line.order_ref, { order_ref: line.order_ref, shop_name: line.shop_name, items: [] });
      byRef.get(line.order_ref)!.items.push({
        product_name_vi: line.product_name_vi,
        variant_label: line.variant_label,
        qty: line.qty,
      });
    }
    setHistoryDetails(prev => ({ ...prev, [delivery_date]: Array.from(byRef.values()) }));
    setLoadingDetails(false);
  }

  // Producing tomorrow (or any future day) = produced ahead of the delivery date
  const isAhead = prodDay === 'tomorrow';

  async function advanceStatus(a: Assignment) {
    const next = STATUS_FLOW[a.status];
    if (!next) return;
    setUpdating(a.id);
    const supabase = createClient();
    const update: any = { status: next, updated_at: new Date().toISOString() };
    if (next === 'done') { update.qty_produced = a.qty_to_produce; update.produced_ahead = isAhead; }
    if (a.status === 'blocked') update.blocked_reason = null;
    await supabase.from('lab_assignments').update(update).eq('id', a.id);
    setAssignments(prev => prev.map(x => x.id === a.id ? { ...x, ...update } : x));
    setUpdating(null);
  }

  async function markInStock(a: Assignment) {
    setUpdating(a.id);
    const supabase = createClient();
    const update = { status: 'skip' as AssignmentStatus, updated_at: new Date().toISOString(), produced_ahead: isAhead };
    await supabase.from('lab_assignments').update(update).eq('id', a.id);
    setAssignments(prev => prev.map(x => x.id === a.id ? { ...x, ...update } : x));
    setUpdating(null);
  }

  async function saveBlocked() {
    if (!blockedModal) return;
    // Store a human-readable label (VI = workshop language), not the internal slug
    const REASON_LABELS: Record<string, string> = {
      manque_temps: 'Thiếu thời gian / Lack of time',
      matieres_premieres: 'Thiếu nguyên liệu / Missing ingredients',
      equipement: 'Sự cố thiết bị / Equipment issue',
    };
    const reason = blockedReason === 'other' ? blockedCustom.trim() : (REASON_LABELS[blockedReason] ?? blockedReason);
    if (!reason) return;
    const supabase = createClient();
    const update = { status: 'blocked' as AssignmentStatus, blocked_reason: reason, updated_at: new Date().toISOString() };
    await supabase.from('lab_assignments').update(update).eq('id', blockedModal.id);
    setAssignments(prev => prev.map(x => x.id === blockedModal.id ? { ...x, ...update } : x));
    setBlockedModal(null);
    setBlockedReason('');
    setBlockedCustom('');
  }

  async function savePartial() {
    if (!qtyModal) return;
    const supabase = createClient();
    const isDone = qtyInput >= qtyModal.qty_to_produce;
    const update = {
      status: (isDone ? 'done' : 'partial') as AssignmentStatus,
      qty_produced: qtyInput,
      updated_at: new Date().toISOString(),
      produced_ahead: isDone ? isAhead : false,
    };
    await supabase.from('lab_assignments').update(update).eq('id', qtyModal.id);
    setAssignments(prev => prev.map(x => x.id === qtyModal.id ? { ...x, ...update } : x));
    setQtyModal(null);
  }

  async function saveExtra() {
    if (!extraProduct || extraQty < 1) return;
    setSavingExtra(true);
    const importId = assignments[0]?.import_id;
    if (!importId) { setSavingExtra(false); return; }
    const supabase = createClient();
    const row = {
      import_id: importId,
      team,
      product_name_vi: extraProduct.name_vi,
      product_name_en: extraProduct.name_en ?? '',
      image_url: extraVariant?.image_url ?? extraProduct.main_image_url,
      fiche_id: extraProduct.id,
      variant_id: extraVariant?.id ?? extraProduct.variant_id ?? null,
      variant_label: extraVariant?.label ?? 'Standard',
      total_qty: extraQty,
      qty_to_produce: extraQty,
      qty_produced: extraQty,
      status: 'done' as AssignmentStatus,
      sort_order: 9999,
      is_extra: true,
      breakdown: [] as BreakdownItem[],
    };
    const { data } = await supabase.from('lab_assignments').insert(row).select('id').single();
    if (data) {
      setAssignments(prev => [...prev, {
        ...row, id: data.id, notes: '', blocked_reason: null, sku: extraVariant?.sku ?? extraProduct.sku ?? null, weight_grams: null, category_name_vi: extraProduct.subcategory ?? null, category_name_en: extraProduct.subcategory ?? null,
        lab_imports: prev[0]?.lab_imports ?? { delivery_date: today, order_number: 1, type: 'daily', status: 'published' },
      }]);
    }
    closeExtraModal();
    setSavingExtra(false);
  }

  function closeExtraModal() {
    setExtraModal(false);
    setExtraSearch('');
    setExtraResults([]);
    setExtraProduct(null);
    setExtraVariant(null);
    setExtraQty(1);
    setExtraQtyInput('1');
    setSelectedCategory('');
  }

  // Open the "send to stock" bon: preselect every finished, not-yet-transferred product
  function openStockModal() {
    const sel: Record<string, { on: boolean; qty: string }> = {};
    for (const a of assignments) {
      if (a.status === 'done' && !a.cancelled && !a.transferred) {
        sel[a.id] = { on: true, qty: String(a.qty_produced || a.qty_to_produce || a.total_qty || 0) };
      }
    }
    setStockSel(sel);
    setStockModal(true);
  }

  async function submitStockTransfer() {
    const chosen = assignments.filter(a => stockSel[a.id]?.on && Number(stockSel[a.id].qty) > 0);
    if (!chosen.length) return;
    setSendingStock(true);
    const { submitStockTransferAction } = await import('./stock-actions');
    const res = await submitStockTransferAction(team, chosen.map(a => ({
      assignmentId: a.id,
      productNameVi: a.product_name_vi,
      productNameEn: a.product_name_en ?? '',
      sku: a.sku ?? null,
      variantLabel: a.variant_label ?? 'Standard',
      imageUrl: a.image_url ?? null,
      deliveryDate: a.lab_imports?.delivery_date ?? null,
      qtySent: Number(stockSel[a.id].qty),
    })));
    if (res.ok) {
      const ids = new Set(chosen.map(a => a.id));
      setAssignments(prev => prev.map(x => ids.has(x.id) ? { ...x, transferred: true } : x));
      setStockModal(false);
    }
    setSendingStock(false);
  }

  // Cancelled = Odoo qty dropped to 0 after import. Kept visible (struck through) but
  // out of every active list and out of progress.
  const production = assignments.filter(a => !a.cancelled && ['pending', 'in_progress', 'partial', 'blocked'].includes(a.status));
  const inStock = assignments.filter(a => !a.cancelled && a.status === 'skip'); // available, not produced
  const termine = assignments.filter(a => !a.cancelled && a.status === 'done');  // Done = actually produced only
  const cancelledCards = assignments.filter(a => a.cancelled);

  // Order-based cards only (exclude extra production — it belongs to no client order).
  // Order fulfillment metrics are measured on these, not on ad-hoc extras.
  const orderCards = assignments.filter(a => !a.is_extra && !a.cancelled);
  const totalQty = orderCards.filter(a => a.status !== 'skip').reduce((s, a) => s + a.qty_to_produce, 0);
  const doneQty = orderCards.filter(a => a.status === 'done').reduce((s, a) => s + a.qty_produced, 0);
  // Completion = cards handled (done OR in stock) / total order cards. In-stock counts as handled,
  // so a fully-in-stock day shows 100% (nothing to produce) instead of a misleading 0%.
  const handledCards = orderCards.filter(a => a.status === 'done' || a.status === 'skip').length;
  const pct = orderCards.length ? Math.round(handledCards / orderCards.length * 100) : 0;

  const inProgressCount = assignments.filter(a => a.status === 'in_progress').length;
  const pendingCount = assignments.filter(a => a.status === 'pending').length;
  const termineCount = termine.length;

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });


  const tabs: { id: Tab; labelVi: string; labelEn: string; count: number; icon: React.ReactNode }[] = [
    {
      id: 'production',
      labelVi: 'Sản xuất',
      labelEn: 'Production',
      count: production.length,
      icon: <FlaskConical size={14} />,
    },
    {
      id: 'commande',
      labelVi: 'Đơn hàng',
      labelEn: 'Orders',
      count: orderCards.length, // client orders only, no extra production
      icon: <ClipboardList size={14} />,
    },
    {
      id: 'termine',
      labelVi: 'Hoàn thành',
      labelEn: 'Done',
      count: termineCount,
      icon: <CheckCircle2 size={14} />,
    },
    {
      id: 'upcoming',
      labelVi: 'Sắp tới',
      labelEn: 'Upcoming',
      count: upcomingData.length,
      icon: <ChevronRight size={14} />,
    },
    {
      id: 'history',
      labelVi: 'Lịch sử',
      labelEn: 'History',
      count: historyData.length,
      icon: <Clock size={14} />,
    },
  ];

  // Read-only roles at the station: worker & viewer (legacy 'employee' kept for safety)
  const isEmployee = userRole === 'worker' || userRole === 'viewer' || userRole === 'employee';

  const sharedCardProps = {
    lang,
    updating,
    readOnly: isEmployee || isHistoryView,
    onAdvance: advanceStatus,
    onMarkInStock: markInStock,
    onPartial: (a: Assignment) => { setQtyInput(a.qty_produced); setQtyModal(a); },
    onViewFiche: (a: Assignment) => a.fiche_id ? setFicheModal({ ficheId: a.fiche_id, productName: a.product_name_vi }) : null,
    onNoteUpdate: (id: string, note: string) => setAssignments(prev => prev.map(x => x.id === id ? { ...x, notes: note } : x)),
    onBlocked: (a: Assignment) => { setBlockedReason(''); setBlockedCustom(''); setBlockedModal(a); },
    meta,
    // Real station URL — '/station/me' breaks for admins without a lab team (bounced to dashboard)
    backTo: `/station/${teamSlug}`,
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FFF4CC' }}>
      {/* Top bar */}
      <header className="sticky top-0 z-20" style={{ backgroundColor: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="max-w-3xl mx-auto px-2.5 py-2 sm:px-4 sm:py-3 flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
            <div className="hidden min-[380px]:flex w-8 h-8 sm:w-9 sm:h-9 rounded-xl items-center justify-center shrink-0" style={{ backgroundColor: 'rgba(255,244,204,0.2)' }}>
              <FlaskConical size={17} className="text-white" />
            </div>
            <div className="min-w-0 text-left">
              <div className="text-white font-bold text-[13px] sm:text-sm leading-tight truncate">
                {lang === 'vi' ? meta.vi : meta.en}
              </div>
              <div className="text-[10px] sm:text-[11px] truncate">
                <span className="font-bold text-yellow-300">{lang === 'vi' ? 'HÔM NAY' : 'TODAY'}</span>
                <span className="text-white/70 hidden min-[400px]:inline"> · {formatDate(today)}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <div className="rounded-full px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-bold whitespace-nowrap" style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
              {doneQty}/{totalQty}
            </div>
            <div className="flex gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
              {(['vi', 'en'] as const).map(l => (
                <button key={l} onClick={() => setLang(l)}
                  className="px-1.5 sm:px-2 py-1 rounded text-[11px] sm:text-xs font-bold transition-all active:scale-95"
                  style={lang === l
                    ? { backgroundColor: '#FFF4CC', color: '#1A4731' }
                    : { color: 'rgba(255,255,255,0.7)' }
                  }>{l.toUpperCase()}</button>
              ))}
            </div>
            <Link href={`/station/fiches?team=${team}`} title={lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe cards'}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
              <BookOpen size={14} />
            </Link>
            <button onClick={logout} title={lang === 'vi' ? 'Đăng xuất' : 'Log out'}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-colors active:scale-95"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
              <LogOut size={14} />
            </button>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
          <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: '#C9A84C' }} />
        </div>
        {/* Tab navigation */}
        <div className="flex border-t" style={{ borderColor: 'rgba(255,255,255,0.15)', backgroundColor: '#163D29' }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className="flex-1 min-w-0 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1.5 py-1.5 sm:py-2.5 text-[10px] sm:text-xs font-bold transition-all active:scale-95"
              style={activeTab === tab.id
                ? { color: '#C9A84C', borderBottom: '2px solid #C9A84C' }
                : { color: 'rgba(255,255,255,0.55)', borderBottom: '2px solid transparent' }
              }>
              {tab.icon}
              <span className="flex items-center gap-1 truncate max-w-full">
                <span className="truncate">{lang === 'vi' ? tab.labelVi : tab.labelEn}</span>
                {tab.count > 0 && (
                  <span className="rounded-full px-1.5 py-0.5 text-[9px] sm:text-[10px] font-black shrink-0"
                    style={activeTab === tab.id
                      ? { backgroundColor: '#C9A84C', color: '#1A4731' }
                      : { backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.7)' }
                    }>
                    {tab.count}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </header>

      {/* Shared Today / Tomorrow day selector — applies to Production, Orders AND Done tabs
          so it's always clear which day you're looking at (removes today/tomorrow confusion) */}
      {tomorrow && (activeTab === 'production' || activeTab === 'commande' || activeTab === 'termine') && (
        <div className="max-w-3xl mx-auto px-4 pt-4 space-y-2.5">
          <div className="flex gap-2">
            {([['today', lang === 'vi' ? 'Hôm nay' : 'Today'], ['tomorrow', lang === 'vi' ? 'Ngày mai' : 'Tomorrow']] as const).map(([d, label]) => {
              const list = (d === 'tomorrow' ? tomorrowAsg : todayAssignments).filter(a => !a.is_extra);
              const handled = list.filter(a => a.status === 'done' || a.status === 'skip').length;
              const active = prodDay === d;
              const dateStr = new Date((d === 'tomorrow' ? tomorrow : today) + 'T00:00:00')
                .toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'numeric' });
              return (
                <button key={d} onClick={() => setProdDay(d)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                  style={active
                    ? { backgroundColor: '#1A4731', color: 'white' }
                    : { backgroundColor: 'white', color: '#1A4731', border: '1px solid #E0D49A' }}>
                  <span>{label}</span>
                  <span className={active ? 'text-white/60' : 'text-ink-light'} style={{ fontSize: 11, fontWeight: 500 }}>{dateStr}</span>
                  {/* Progress badge only where progress matters — not on the Done tab (a record, not a to-do) */}
                  {list.length > 0 && activeTab !== 'termine' && (
                    <span className="text-[11px] font-black rounded-full px-1.5 py-0.5"
                      style={active ? { backgroundColor: '#C9A84C', color: '#1A4731' } : { backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                      {handled}/{list.length}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {prodDay === 'tomorrow' && (
            <div className="rounded-xl px-4 py-2 flex items-center gap-2 text-sm font-semibold"
              style={{ backgroundColor: '#EFF6FF', color: '#1E40AF', border: '1px solid #93C5FD' }}>
              ⏩ {lang === 'vi'
                ? `Đang xem NGÀY MAI — ${new Date(tomorrow + 'T00:00:00').toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' })}`
                : `Viewing TOMORROW — ${new Date(tomorrow + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}`}
            </div>
          )}
        </div>
      )}

      {/* Celebratory banner only on the work tabs, not on Done (which is just a production record) */}
      {pct === 100 && assignments.length > 0 && activeTab !== 'termine' && (
        <div className="text-center py-3 text-sm font-bold" style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
          {lang === 'vi' ? '🎉 Hoàn thành tất cả!' : '🎉 All done!'}
        </div>
      )}

      {/* ─── PRODUCTION TAB ─── */}
      {activeTab === 'production' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-28">
          {production.length === 0 && (
            <div className="text-center py-20">
              <CheckCircle2 size={48} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
              {prodDay === 'tomorrow' && assignments.length === 0 ? (
                <>
                  <p className="font-semibold" style={{ color: '#1A4731' }}>
                    {lang === 'vi' ? 'Chưa có đơn cho ngày mai' : 'No order published for tomorrow yet'}
                  </p>
                  <p className="text-sm mt-1 text-ink-light">
                    {lang === 'vi' ? 'Đơn ngày mai sẽ hiện ở đây khi được phát hành' : "Tomorrow's order will appear here once published"}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold" style={{ color: '#1A4731' }}>
                    {lang === 'vi' ? 'Không có sản phẩm cần làm' : 'Nothing left to produce'}
                  </p>
                  <p className="text-sm mt-1 text-ink-light">
                    {lang === 'vi' ? 'Tất cả đã hoàn thành hoặc có sẵn' : 'All items are done or in stock'}
                  </p>
                </>
              )}
            </div>
          )}
          {/* Compact recap: total to produce per SKU (aggregated across all cards) for the selected day */}
          {production.length > 0 && (() => {
            const OTHER = lang === 'vi' ? 'Khác' : 'Other';
            const m = new Map<string, { name: string; sku: string | null; cat: string; qty: number }>();
            for (const a of production) {
              const key = a.sku || a.product_name_vi;
              const cat = (lang === 'vi' ? a.category_name_vi : a.category_name_en) || a.category_name_vi || OTHER;
              const name = lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi);
              const e = m.get(key) ?? { name, sku: a.sku ?? null, cat, qty: 0 };
              e.qty += a.qty_to_produce;
              m.set(key, e);
            }
            const items = Array.from(m.values());
            const totalUnits = items.reduce((s, r) => s + r.qty, 0);
            const cats = Array.from(new Set(items.map(r => r.cat))).sort((x, y) => x === OTHER ? 1 : y === OTHER ? -1 : x.localeCompare(y));
            return (
              <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
                <button onClick={() => setShowRecap(v => !v)} className="w-full flex items-center justify-between px-3 py-2.5 text-white" style={{ backgroundColor: '#1A4731' }}>
                  <span className="text-sm font-bold">📋 {lang === 'vi' ? 'Tổng cần làm' : 'Total à produire'}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-bold" style={{ color: '#F0D98A' }}>{items.length} · {totalUnits} {lang === 'vi' ? 'cái' : 'u.'}</span>
                    <ChevronRight size={16} className={`transition-transform ${showRecap ? 'rotate-90' : ''}`} />
                  </span>
                </button>
                {showRecap && (
                  <div className="grid grid-cols-2 bg-white">
                    {cats.flatMap(cat => [
                      <div key={`c-${cat}`} className="col-span-2 px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
                        style={{ backgroundColor: '#FBF6E3', color: '#92600A', borderTop: '1px solid #F0EAD0' }}>{cat}</div>,
                      ...items.filter(r => r.cat === cat).map((r, i) => (
                        <div key={r.sku ?? r.name} className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
                          style={{ borderTop: '1px solid #F0EAD0', borderRight: i % 2 === 0 ? '1px solid #F0EAD0' : undefined }}>
                          <span className="flex-1 truncate" style={{ color: '#1A4731' }}>{r.name}{r.sku && <span className="ml-1 text-[9px] font-mono text-ink-light">{r.sku}</span>}</span>
                          <span className="font-black shrink-0" style={{ color: '#92600A' }}>×{r.qty}</span>
                        </div>
                      )),
                    ])}
                  </div>
                )}
              </div>
            );
          })()}

          {(() => {
            // Group by fiche category — a workshop works in stations, not one long list.
            const OTHER = lang === 'vi' ? 'Khác' : 'Other';
            const groups = new Map<string, typeof production>();
            for (const a of production) {
              const cat = (lang === 'vi' ? a.category_name_vi : a.category_name_en) || a.category_name_vi || OTHER;
              if (!groups.has(cat)) groups.set(cat, []);
              groups.get(cat)!.push(a);
            }
            const entries = Array.from(groups.entries()).sort((x, y) =>
              x[0] === OTHER ? 1 : y[0] === OTHER ? -1 : x[0].localeCompare(y[0]));
            // Single category (or none) → plain list, no chrome
            if (entries.length <= 1) {
              return production.map(a => <ProductionCard key={a.id} a={a} {...sharedCardProps} />);
            }
            return (
              <>
                {/* Category quick-jump chips */}
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 sticky top-[102px] sm:top-[118px] z-10 py-2"
                  style={{ backgroundColor: '#FDF8E7' }}>
                  {entries.map(([cat, items]) => {
                    const qty = items.reduce((s, a) => s + a.qty_to_produce, 0);
                    return (
                      <a key={cat} href={`#cat-${encodeURIComponent(cat)}`}
                        className="shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap"
                        style={{ backgroundColor: 'white', border: '1px solid #E0D49A', color: '#1A4731' }}>
                        {cat} <span style={{ color: '#92600A' }}>· {qty}</span>
                      </a>
                    );
                  })}
                </div>
                {entries.map(([cat, items]) => (
                  <div key={cat} id={`cat-${encodeURIComponent(cat)}`} className="space-y-3 scroll-mt-24">
                    <div className="flex items-center gap-2 pt-2">
                      <span className="font-bold text-sm" style={{ color: '#1A4731' }}>{cat}</span>
                      <span className="text-xs font-medium" style={{ color: '#92600A' }}>
                        {items.length} {lang === 'vi' ? 'sản phẩm' : 'products'} · {items.reduce((s, a) => s + a.qty_to_produce, 0)} {lang === 'vi' ? 'cái' : 'units'}
                      </span>
                      <div className="flex-1 border-t" style={{ borderColor: '#E0D49A' }} />
                    </div>
                    {items.map(a => <ProductionCard key={a.id} a={a} {...sharedCardProps} />)}
                  </div>
                ))}
              </>
            );
          })()}

          {/* In-stock (skip) items — available, not produced. Collapsed, with revert. */}
          {inStock.length > 0 && !isEmployee && (
            <div className="rounded-2xl overflow-hidden mt-2" style={{ border: '1px solid #C4B5FD', backgroundColor: '#F5F3FF' }}>
              <button onClick={() => setShowInStock(v => !v)}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-bold" style={{ color: '#6D28D9' }}>
                <Package size={15} />
                <span>{lang === 'vi' ? 'Có sẵn trong kho' : 'In stock'} · {inStock.length}</span>
                <span className="text-xs font-normal" style={{ color: '#8B5CF6' }}>
                  ({lang === 'vi' ? 'không cần làm' : 'no need to produce'})
                </span>
                <ChevronRight size={15} className={`ml-auto transition-transform ${showInStock ? 'rotate-90' : ''}`} />
              </button>
              {showInStock && (
                <div className="divide-y" style={{ borderColor: '#EDE9FE' }}>
                  {inStock.map(a => (
                    <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 bg-white">
                      {a.image_url
                        ? <img src={a.image_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} />
                        : <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>
                          {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                        </div>
                        <div className="text-xs" style={{ color: '#8B5CF6' }}>×{a.qty_to_produce}</div>
                      </div>
                      <button onClick={() => advanceStatus(a)} disabled={updating === a.id}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold active:scale-95 transition-all shrink-0"
                        style={{ backgroundColor: '#EDE9FE', color: '#6D28D9', opacity: updating === a.id ? 0.6 : 1 }}>
                        {lang === 'vi' ? 'Cần làm' : 'Produce'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Cancelled — Odoo qty dropped to 0 after publishing. Kept visible, struck through. */}
          {cancelledCards.length > 0 && (
            <div className="mt-2 space-y-3">
              <div className="flex items-center gap-2 pt-2">
                <span className="font-bold text-sm" style={{ color: '#6B7280' }}>
                  {lang === 'vi' ? '✕ Đã hủy' : '✕ Cancelled'}
                </span>
                <span className="text-xs font-medium" style={{ color: '#9CA3AF' }}>
                  {cancelledCards.length} · {lang === 'vi' ? 'không cần làm' : 'do not produce'}
                </span>
                <div className="flex-1 border-t" style={{ borderColor: '#E5E7EB' }} />
              </div>
              {cancelledCards.map(a => <ProductionCard key={a.id} a={a} {...sharedCardProps} />)}
            </div>
          )}
        </div>
      )}

      {/* ─── BON DE COMMANDE TAB — client orders only (no extra production) ─── */}
      {activeTab === 'commande' && (() => {
        const orderList = assignments.filter(a => !a.is_extra);
        return (
        <div className="max-w-3xl mx-auto px-4 py-5 pb-10">
          {orderList.length === 0 ? (
            <div className="text-center py-20">
              <ClipboardList size={48} className="mx-auto mb-3 text-ink-light" />
              <p className="font-semibold text-ink-light">
                {prodDay === 'tomorrow'
                  ? (lang === 'vi' ? 'Chưa có đơn hàng ngày mai' : 'No orders for tomorrow')
                  : (lang === 'vi' ? 'Chưa có đơn hàng hôm nay' : 'No orders for today')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Summary header — day-aware label + completion (in-stock counts as handled) */}
              <div className="rounded-2xl px-5 py-4 flex items-center justify-between"
                style={{ backgroundColor: '#1A4731', color: 'white' }}>
                <div>
                  <div className="font-bold text-base">
                    {prodDay === 'tomorrow'
                      ? (lang === 'vi' ? 'Tổng đơn hàng ngày mai' : "Tomorrow's order summary")
                      : (lang === 'vi' ? 'Tổng đơn hàng hôm nay' : "Today's order summary")}
                  </div>
                  <div className="text-white/70 text-sm mt-0.5">
                    {orderList.length} {lang === 'vi' ? 'sản phẩm' : 'products'} — {totalQty} {lang === 'vi' ? 'cái cần làm' : 'units to make'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-black" style={{ color: '#C9A84C' }}>{pct}%</div>
                  <div className="text-white/60 text-xs">{lang === 'vi' ? 'Hoàn thành' : 'Complete'}</div>
                </div>
              </div>

              {/* Order lines */}
              <div className="rounded-2xl overflow-hidden"
                style={{ border: '1px solid #E0D49A', backgroundColor: 'white' }}>
                <div className="px-4 py-2.5 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider"
                  style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderBottom: '1px solid #E0D49A' }}>
                  <span>{lang === 'vi' ? 'Sản phẩm' : 'Product'}</span>
                  <span>{lang === 'vi' ? 'Số lượng' : 'Qty'}</span>
                </div>
                {orderList.map((a, i) => {
                  const st = STATUS_META[a.status];
                  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];
                  return (
                    <div key={a.id} style={{ borderTop: i > 0 ? '1px solid #F5EfC8' : undefined, opacity: a.cancelled ? 0.65 : 1 }}>
                      {/* Product row */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        {a.image_url ? (
                          <img src={a.image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
                            style={{ border: '1px solid #E0D49A' }} />
                        ) : (
                          <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-xl"
                            style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-sm"
                            style={{ color: a.cancelled ? '#9CA3AF' : '#1A4731', textDecoration: a.cancelled ? 'line-through' : undefined }}>
                            {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {a.sku && (
                              <span className="text-[10px] font-mono font-semibold px-1 py-0.5 rounded"
                                style={{ backgroundColor: '#F5F5F5', color: '#555' }}>{a.sku}</span>
                            )}
                            {a.weight_grams && (
                              <span className="text-[10px] font-semibold px-1 py-0.5 rounded"
                                style={{ backgroundColor: '#FFF4CC', color: '#92600A' }}>{a.weight_grams}g</span>
                            )}
                            {(a.category_name_vi || a.category_name_en) && (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                                style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                                {lang === 'vi' ? a.category_name_vi : (a.category_name_en || a.category_name_vi)}
                              </span>
                            )}
                            {a.cancelled ? (
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold"
                                style={{ backgroundColor: '#E5E7EB', color: '#6B7280' }}>
                                {lang === 'vi' ? '✕ Đã hủy' : '✕ Cancelled'}
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
                                style={{ backgroundColor: st.color }}>
                                {lang === 'vi' ? st.labelVi : st.labelEn}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-2xl font-black shrink-0"
                          style={{ color: a.cancelled ? '#9CA3AF' : meta.color, textDecoration: a.cancelled ? 'line-through' : undefined }}>
                          x{a.qty_to_produce}
                        </div>
                      </div>
                      {/* Shop breakdown */}
                      {breakdown.length > 0 && (
                        <div className="pb-3">
                          {breakdown.map((b, bi) => (
                            <div key={bi} className="flex items-center justify-between px-5 py-1.5 text-sm"
                              style={{ backgroundColor: bi % 2 === 0 ? '#FFFDF0' : '#FFFAEE' }}>
                              <div className="flex items-center gap-2 text-ink-light">
                                <Store size={11} className="shrink-0" />
                                <span>{b.shop_name}</span>
                                {b.delivery_time && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                                    style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                                    ⏰ {b.delivery_time.slice(0, 5)}
                                  </span>
                                )}
                              </div>
                              <span className="font-bold text-sm" style={{ color: '#1A4731' }}>x{b.qty}</span>
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
        );
      })()}

      {/* ─── TERMINÉ TAB — split: from orders vs extra production ─── */}
      {activeTab === 'termine' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-10">
          {/* Send finished products to stock (chef only, not history view) */}
          {!isEmployee && !isHistoryView && termine.some(a => !a.transferred) && (
            <button onClick={openStockModal}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-sm active:scale-[0.99] transition-all"
              style={{ backgroundColor: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>
              <Package size={16} />
              {lang === 'vi' ? 'Chuyển vào kho' : 'Send to stock'}
            </button>
          )}
          {termine.length === 0 ? (
            <div className="text-center py-20">
              <Clock size={48} className="mx-auto mb-3 text-ink-light" />
              <p className="font-semibold text-ink-light">
                {lang === 'vi' ? 'Chưa có sản phẩm hoàn thành' : 'No completed items yet'}
              </p>
            </div>
          ) : (() => {
            const fromOrder = termine.filter(a => !a.is_extra);
            const extra = termine.filter(a => a.is_extra);
            const Section = ({ title, count, items, color, bg }: { title: string; count: number; items: Assignment[]; color: string; bg: string }) => (
              <div className="space-y-3">
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ backgroundColor: bg, color }}>
                    {title} · {count}
                  </span>
                  <div className="flex-1 border-t" style={{ borderColor: '#E0D49A' }} />
                </div>
                {items.map(a => (
                  <TermineCard key={a.id} a={a} lang={lang} meta={meta} onAdvance={advanceStatus} updating={updating} />
                ))}
              </div>
            );
            return (
              <>
                {fromOrder.length > 0 && (
                  <Section title={lang === 'vi' ? 'Theo đơn hàng' : 'From orders'} count={fromOrder.length} items={fromOrder} color="#2D6A4F" bg="#F0F9F4" />
                )}
                {extra.length > 0 && (
                  <Section title={lang === 'vi' ? 'Sản xuất thêm' : 'Extra production'} count={extra.length} items={extra} color="#92600A" bg="#FEF3C7" />
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ─── UPCOMING TAB ─── */}
      {activeTab === 'upcoming' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-16">
          {loadingDates && (
            <div className="space-y-3">
              <SkeletonRow /><SkeletonRow /><SkeletonRow />
            </div>
          )}
          {!loadingDates && upcomingData.length === 0 && (
            <div className="text-center py-20">
              <ClipboardList size={40} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
              <p className="font-semibold" style={{ color: '#1A4731' }}>
                {lang === 'vi' ? 'Chưa có đơn hàng sắp tới' : 'No upcoming orders'}
              </p>
              <p className="text-sm mt-1 text-gray-400">
                {lang === 'vi' ? 'Import đơn hàng để xem ở đây' : 'Import orders to see them here'}
              </p>
            </div>
          )}
          {upcomingData.map(d => {
            const dateLabel = new Date(d.delivery_date + 'T00:00:00').toLocaleDateString('vi-VN', {
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            });
            const isExpanded = expandedHistoryDate === d.delivery_date;
            const details = historyDetails[d.delivery_date];
            return (
              <div key={d.delivery_date}
                className="rounded-2xl bg-white overflow-hidden"
                style={{ border: '1px solid #E0D49A', boxShadow: '0 1px 4px rgba(26,71,49,0.07)' }}>
                <button
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedHistoryDate(null);
                    } else {
                      setExpandedHistoryDate(d.delivery_date);
                      loadHistoryDetails(d.delivery_date, d.import_ids);
                    }
                  }}
                  className="w-full px-5 py-4 text-left flex items-center justify-between transition-transform active:scale-[0.98]">
                  <div>
                    <div className="font-bold text-sm capitalize" style={{ color: '#1A4731' }}>{dateLabel}</div>
                    <div className="text-xs mt-0.5 font-medium" style={{ color: '#2D6A4F' }}>
                      {d.productCount} {lang === 'vi' ? 'sản phẩm' : 'products'} · {d.totalQty} {lang === 'vi' ? 'cái' : 'units'}
                    </div>
                  </div>
                  <ChevronRight size={16}
                    className="transition-transform duration-200 shrink-0"
                    style={{ color: '#C9A84C', transform: isExpanded ? 'rotate(90deg)' : 'none' }} />
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-2 border-t" style={{ borderColor: '#F0E8B0' }}>
                    {loadingDetails && !details && (
                      <div className="space-y-2 pt-2">
                        <div className="skeleton h-12 w-full" />
                        <div className="skeleton h-12 w-full" />
                      </div>
                    )}
                    {details && details.length === 0 && (
                      <p className="text-center text-xs py-3 text-gray-400">
                        {lang === 'vi' ? 'Không có chi tiết đơn hàng' : 'No order details'}
                      </p>
                    )}
                    {/* Consolidated per-product totals — what this day actually requires */}
                    {details && details.length > 0 && (() => {
                      const totals = new Map<string, number>();
                      for (const order of details) {
                        for (const item of order.items) {
                          const key = `${item.product_name_vi}${item.variant_label && item.variant_label !== 'Standard' ? ` · ${item.variant_label}` : ''}`;
                          totals.set(key, (totals.get(key) ?? 0) + item.qty);
                        }
                      }
                      const rows = Array.from(totals.entries()).sort((x, y) => y[1] - x[1]);
                      return (
                        <div className="rounded-xl p-3 mt-2" style={{ backgroundColor: '#F0F9F4', border: '1px solid #A7D4B8' }}>
                          <div className="text-xs font-bold mb-1.5" style={{ color: '#1A4731' }}>
                            {lang === 'vi' ? 'Tổng cần sản xuất' : 'Total to produce'}
                          </div>
                          <div className="space-y-0.5">
                            {rows.map(([name, qty]) => (
                              <div key={name} className="flex items-center justify-between text-xs">
                                <span style={{ color: '#374151' }}>{name}</span>
                                <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{qty}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {(details ?? []).map(order => (
                      <div key={order.order_ref} className="rounded-xl p-3 mt-2"
                        style={{ backgroundColor: '#FEFCE8', border: '1px solid #F0E8B0' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold" style={{ color: '#92600A' }}>{order.order_ref}</span>
                          <span className="text-xs font-medium" style={{ color: '#1A4731' }}>{order.shop_name}</span>
                        </div>
                        <div className="space-y-0.5">
                          {order.items.map((item, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span style={{ color: '#374151' }}>
                                {item.product_name_vi}
                                {item.variant_label ? <span className="ml-1 text-gray-400">· {item.variant_label}</span> : null}
                              </span>
                              <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{item.qty}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={() => router.push(`/station/${teamSlug}?date=${d.delivery_date}`)}
                      className="w-full mt-2 py-2.5 rounded-xl text-xs font-bold transition-colors"
                      style={{ backgroundColor: '#F0F9F4', color: '#1A4731', border: '1px solid #A7D4B8' }}>
                      {lang === 'vi' ? 'Mở ngày này →' : 'Open this day →'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── HISTORY TAB ─── */}
      {activeTab === 'history' && (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-16">
          {loadingDates && (
            <div className="space-y-3">
              <SkeletonRow /><SkeletonRow /><SkeletonRow />
            </div>
          )}
          {!loadingDates && historyData.length === 0 && (
            <div className="text-center py-20">
              <Clock size={40} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
              <p className="font-semibold" style={{ color: '#1A4731' }}>
                {lang === 'vi' ? 'Chưa có lịch sử' : 'No history yet'}
              </p>
            </div>
          )}
          {historyData.map(d => {
            const pct = d.totalQty ? Math.round(d.doneQty / d.totalQty * 100) : 0;
            const dateLabel = new Date(d.delivery_date + 'T00:00:00').toLocaleDateString('vi-VN', {
              weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
            });
            const isExpanded = expandedHistoryDate === d.delivery_date;
            const details = historyDetails[d.delivery_date];
            return (
              <div key={d.delivery_date}
                className="rounded-2xl bg-white overflow-hidden"
                style={{ border: '1px solid #E0D49A', boxShadow: '0 1px 4px rgba(26,71,49,0.07)' }}>
                <button
                  onClick={() => {
                    if (isExpanded) {
                      setExpandedHistoryDate(null);
                    } else {
                      setExpandedHistoryDate(d.delivery_date);
                      loadHistoryDetails(d.delivery_date, d.import_ids);
                    }
                  }}
                  className="w-full px-5 py-4 text-left flex items-center justify-between transition-transform active:scale-[0.98]">
                  <div>
                    <div className="font-bold text-sm capitalize" style={{ color: '#1A4731' }}>{dateLabel}</div>
                    <div className="text-xs mt-0.5 font-medium" style={{ color: pct === 100 ? '#2D6A4F' : '#92600A' }}>
                      {pct === 100 ? '✓ ' : ''}{pct}% · {d.productCount} {lang === 'vi' ? 'sản phẩm' : 'products'}
                    </div>
                  </div>
                  <ChevronRight size={16}
                    className="transition-transform duration-200 shrink-0"
                    style={{ color: '#C9A84C', transform: isExpanded ? 'rotate(90deg)' : 'none' }} />
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-2 border-t" style={{ borderColor: '#F0E8B0' }}>
                    {loadingDetails && !details && (
                      <div className="space-y-2 pt-2">
                        <div className="skeleton h-12 w-full" />
                        <div className="skeleton h-12 w-full" />
                      </div>
                    )}
                    {details && details.length === 0 && (
                      <p className="text-center text-xs py-3 text-gray-400">
                        {lang === 'vi' ? 'Không có chi tiết đơn hàng' : 'No order details'}
                      </p>
                    )}
                    {(details ?? []).map(order => (
                      <div key={order.order_ref} className="rounded-xl p-3 mt-2"
                        style={{ backgroundColor: '#FEFCE8', border: '1px solid #F0E8B0' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold" style={{ color: '#92600A' }}>{order.order_ref}</span>
                          <span className="text-xs font-medium" style={{ color: '#1A4731' }}>{order.shop_name}</span>
                        </div>
                        <div className="space-y-0.5">
                          {order.items.map((item, i) => (
                            <div key={i} className="flex items-center justify-between text-xs">
                              <span style={{ color: '#374151' }}>
                                {item.product_name_vi}
                                {item.variant_label ? <span className="ml-1 text-gray-400">· {item.variant_label}</span> : null}
                              </span>
                              <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{item.qty}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* FAB — Add extra production (Production tab only, not in history view, not for employees) */}
      {activeTab === 'production' && assignments.length > 0 && !isHistoryView && !isEmployee && (
        <div className="fixed z-10 pointer-events-none bottom-4 right-4 sm:bottom-6 sm:inset-x-0 sm:right-auto sm:flex sm:justify-center"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {/* Round FAB bottom-right on phones (never covers the last card's buttons), labelled pill on bigger screens */}
          <button
            onClick={() => setExtraModal(true)}
            className="pointer-events-auto flex items-center justify-center gap-2 rounded-full font-bold text-sm shadow-xl active:scale-95 transition-all w-14 h-14 sm:w-auto sm:h-auto sm:px-5 sm:py-3"
            style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}
            aria-label={lang === 'vi' ? 'Sản xuất thêm ngoài đơn' : 'Add extra production'}
          >
            <Plus size={22} className="sm:hidden" />
            <span className="hidden sm:flex items-center gap-2"><Plus size={16} />{lang === 'vi' ? 'Sản xuất thêm ngoài đơn' : 'Add extra production'}</span>
          </button>
        </div>
      )}

      {/* Send-to-stock transfer note (bon de transfert) */}
      {stockModal && (() => {
        const sendable = termine.filter(a => !a.transferred);
        const chosen = sendable.filter(a => stockSel[a.id]?.on && Number(stockSel[a.id]?.qty) > 0);
        return (
          <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
            onClick={() => !sendingStock && setStockModal(false)}>
            <div className="modal-sheet bg-white w-full max-w-lg rounded-t-2xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: '1px solid #E0D49A' }}>
                <div className="flex items-center gap-2">
                  <Package size={18} style={{ color: '#1D4ED8' }} />
                  <span className="font-bold text-base" style={{ color: '#1A4731' }}>
                    {lang === 'vi' ? 'Chuyển vào kho' : 'Send to stock'}
                  </span>
                </div>
                <button onClick={() => !sendingStock && setStockModal(false)} className="p-1 text-ink-light hover:text-ink"><X size={20} /></button>
              </div>
              <div className="px-5 py-2 text-xs text-ink-light shrink-0">
                {lang === 'vi' ? 'Chọn sản phẩm và số lượng gửi vào kho.' : 'Pick the products and quantity sent to stock.'}
              </div>
              <div className="overflow-y-auto flex-1 px-3 py-2 space-y-1.5">
                {sendable.map(a => {
                  const sel = stockSel[a.id] ?? { on: false, qty: '0' };
                  return (
                    <div key={a.id} className="flex items-center gap-3 p-2.5 rounded-xl"
                      style={{ backgroundColor: sel.on ? '#EFF6FF' : '#F9FAFB', border: '1px solid', borderColor: sel.on ? '#BFDBFE' : '#E5E7EB' }}>
                      <button onClick={() => setStockSel(p => ({ ...p, [a.id]: { ...sel, on: !sel.on } }))}
                        className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                        style={{ backgroundColor: sel.on ? '#1D4ED8' : 'white', border: '1px solid', borderColor: sel.on ? '#1D4ED8' : '#D1D5DB' }}>
                        {sel.on && <CheckCircle2 size={16} className="text-white" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>
                          {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                        </div>
                        <div className="text-[11px] text-ink-light">{lang === 'vi' ? 'Đã làm' : 'Produced'}: {a.qty_produced || a.total_qty}</div>
                      </div>
                      <input type="number" value={sel.qty} disabled={!sel.on}
                        onChange={e => setStockSel(p => ({ ...p, [a.id]: { ...sel, qty: e.target.value } }))}
                        className="w-16 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                        style={{ border: '1px solid #D1D5DB', opacity: sel.on ? 1 : 0.5 }} />
                    </div>
                  );
                })}
              </div>
              <div className="px-5 py-4 shrink-0 flex items-center justify-between gap-3" style={{ borderTop: '1px solid #E0D49A' }}>
                <span className="text-sm text-ink-light">
                  {chosen.length} {lang === 'vi' ? 'sản phẩm' : 'products'}
                </span>
                <button onClick={submitStockTransfer} disabled={sendingStock || chosen.length === 0}
                  className="px-5 py-2.5 rounded-xl font-bold text-white text-sm disabled:opacity-50"
                  style={{ backgroundColor: '#1D4ED8' }}>
                  {sendingStock ? '…' : (lang === 'vi' ? 'Gửi phiếu' : 'Send transfer')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Fiche modal */}
      {ficheModal && (
        <FicheModal ficheId={ficheModal.ficheId} productName={ficheModal.productName}
          lang={lang} backTo={`/station/${teamSlug}`} onClose={() => setFicheModal(null)} />
      )}

      {/* Blocked reason modal */}
      {blockedModal && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => { setBlockedModal(null); setBlockedReason(''); setBlockedCustom(''); }}>
          <div className="modal-sheet bg-white w-full max-w-sm rounded-t-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#DC2626' }}>
                  {lang === 'vi' ? 'Lý do bị chặn' : 'Blocked reason'}
                </h3>
                <p className="text-xs text-ink-light mt-0.5 truncate">{blockedModal.product_name_vi}</p>
              </div>
              <button onClick={() => { setBlockedModal(null); setBlockedReason(''); setBlockedCustom(''); }} className="p-1 text-ink-light"><X size={20} /></button>
            </div>
            <div className="px-5 pb-5 space-y-3">
              {[
                { value: 'manque_temps', vi: 'Thiếu thời gian', en: 'Lack of time' },
                { value: 'matieres_premieres', vi: 'Thiếu nguyên liệu', en: 'Missing ingredients' },
                { value: 'equipement', vi: 'Sự cố thiết bị', en: 'Equipment issue' },
                { value: 'other', vi: 'Lý do khác', en: 'Other reason' },
              ].map(opt => (
                <button key={opt.value} onClick={() => setBlockedReason(opt.value)}
                  className="w-full text-left px-4 py-3 rounded-xl font-medium text-sm transition-all"
                  style={blockedReason === opt.value
                    ? { backgroundColor: '#FEE2E2', color: '#DC2626', border: '2px solid #DC2626' }
                    : { backgroundColor: '#F9FAFB', color: '#374151', border: '2px solid transparent' }}>
                  {lang === 'vi' ? opt.vi : opt.en}
                </button>
              ))}
              {blockedReason === 'other' && (
                <input
                  value={blockedCustom}
                  onChange={e => setBlockedCustom(e.target.value)}
                  placeholder={lang === 'vi' ? 'Nhập lý do…' : 'Enter reason…'}
                  className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                  style={{ borderColor: '#E0D49A' }}
                  autoFocus
                />
              )}
              <button
                onClick={saveBlocked}
                disabled={!blockedReason || (blockedReason === 'other' && !blockedCustom.trim())}
                className="w-full py-3 rounded-xl font-bold text-sm text-white disabled:opacity-40"
                style={{ backgroundColor: '#DC2626' }}>
                {lang === 'vi' ? 'Xác nhận bị chặn' : 'Confirm blocked'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Extra production modal */}
      {extraModal && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={closeExtraModal}>
          <div className="modal-sheet bg-white w-full max-w-sm rounded-t-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#1A4731' }}>
                  {lang === 'vi' ? 'Sản xuất thêm ngoài đơn' : 'Extra production'}
                </h3>
                <p className="text-xs text-ink-light mt-0.5">
                  {lang === 'vi'
                    ? 'Chọn sản phẩm từ danh mục — không thể nhập tự do'
                    : 'Select from catalogue — free text not allowed'}
                </p>
              </div>
              <button onClick={closeExtraModal} className="p-1 text-ink-light"><X size={20} /></button>
            </div>

            <div className="px-5 pb-5 space-y-4">
              {/* Category filter chips */}
              {!extraProduct && extraCategories.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    onClick={() => setSelectedCategory('')}
                    className="px-3 py-1 rounded-full text-xs font-bold transition-all active:scale-95"
                    style={selectedCategory === ''
                      ? { backgroundColor: '#1A4731', color: 'white' }
                      : { backgroundColor: '#F3F4F6', color: '#6B7280' }
                    }
                  >
                    {lang === 'vi' ? 'Tất cả' : 'All'}
                  </button>
                  {extraCategories.map(cat => (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedCategory(cat.id === selectedCategory ? '' : cat.id)}
                      className="px-3 py-1 rounded-full text-xs font-bold transition-all active:scale-95"
                      style={selectedCategory === cat.id
                        ? { backgroundColor: '#1A4731', color: 'white' }
                        : { backgroundColor: '#F3F4F6', color: '#6B7280' }
                      }
                    >
                      {lang === 'vi' ? cat.name_vi : cat.name_en}
                    </button>
                  ))}
                </div>
              )}

              {extraProduct ? (
                <div className="flex items-center gap-3 rounded-xl p-3" style={{ backgroundColor: '#F0F9F4', border: '1.5px solid #2D6A4F' }}>
                  {(extraVariant?.image_url ?? extraProduct.main_image_url) ? (
                    <img src={extraVariant?.image_url ?? extraProduct.main_image_url ?? undefined} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                  ) : (
                    <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-xl" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>{extraProduct.name_vi}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {(extraVariant?.sku ?? extraProduct.sku) && <span className="text-[10px] font-mono text-ink-light">{extraVariant?.sku ?? extraProduct.sku}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                        style={extraProduct.is_lab_only
                          ? { backgroundColor: '#EDE9FE', color: '#6D28D9' }
                          : { backgroundColor: '#DBEAFE', color: '#1D4ED8' }
                        }>
                        {extraProduct.is_lab_only ? 'Lab' : 'Catalogue'}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => { setExtraProduct(null); setExtraVariant(null); setExtraSearch(''); }}
                    className="p-1 text-ink-light shrink-0"><X size={16} /></button>
                </div>
              ) : (
                <div>
                  <div className="relative">
                    <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                    <input
                      value={extraSearch}
                      onChange={e => setExtraSearch(e.target.value)}
                      placeholder={lang === 'vi' ? 'Tên sản phẩm hoặc SKU…' : 'Product name or SKU…'}
                      className="w-full rounded-xl border border-gray-200 pl-9 pr-3 py-2.5 text-sm outline-none focus:border-green-600"
                      autoFocus
                    />
                    {searchLoading && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-green-600 border-t-transparent animate-spin" />
                    )}
                  </div>
                  {extraResults.length > 0 && (
                    <div className="mt-2 rounded-xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
                      {extraResults.map((p, i) => (
                        <button key={p.id}
                          onClick={() => { setExtraProduct(p); setExtraVariant(p.variants?.[0] ?? null); }}
                          className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-green-50 active:bg-green-100"
                          style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
                          {p.main_image_url ? (
                            <img src={p.main_image_url} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                          ) : (
                            <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>{p.name_vi}</div>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {p.sku && <span className="text-[10px] font-mono text-ink-light">{p.sku}</span>}
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                                style={p.is_lab_only
                                  ? { backgroundColor: '#EDE9FE', color: '#6D28D9' }
                                  : { backgroundColor: '#DBEAFE', color: '#1D4ED8' }
                                }>
                                {p.is_lab_only ? 'Lab' : 'Catalogue'}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {extraSearch.length > 0 && !searchLoading && extraResults.length === 0 && (
                    <p className="text-sm text-ink-light text-center py-3">
                      {lang === 'vi' ? 'Không tìm thấy sản phẩm nào' : 'No products found'}
                    </p>
                  )}
                </div>
              )}

              {extraProduct && (extraProduct.variants?.length ?? 0) > 1 && (
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-ink-light">
                    {lang === 'vi' ? 'Chọn loại' : 'Choisir la variante'}
                  </label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {extraProduct.variants!.map(v => {
                      const on = extraVariant?.id === v.id;
                      return (
                        <button key={v.id} onClick={() => setExtraVariant(v)}
                          className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
                          style={on
                            ? { backgroundColor: '#1A4731', color: 'white' }
                            : { backgroundColor: 'white', border: '1px solid #E0D49A', color: '#1A4731' }}>
                          {v.label}{v.sku ? ` · ${v.sku}` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {extraProduct && (
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-ink-light">
                    {lang === 'vi' ? 'Số lượng' : 'Quantity'}
                  </label>
                  <div className="flex items-center gap-3 mt-2">
                    <button onClick={() => { const v = Math.max(1, extraQty - 1); setExtraQty(v); setExtraQtyInput(String(v)); }}
                      className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center active:scale-95"
                      style={{ color: '#1A4731' }}>
                      <Minus size={18} />
                    </button>
                    <input
                      type="number" min={1}
                      value={extraQtyInput}
                      onChange={e => {
                        setExtraQtyInput(e.target.value);
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v >= 1) setExtraQty(v);
                      }}
                      onBlur={() => {
                        const v = parseInt(extraQtyInput, 10);
                        const safe = isNaN(v) || v < 1 ? 1 : v;
                        setExtraQty(safe);
                        setExtraQtyInput(String(safe));
                      }}
                      className="text-4xl font-black text-center rounded-xl border-2 outline-none w-20 py-1"
                      style={{ color: '#1A4731', borderColor: '#1A4731', WebkitAppearance: 'none', MozAppearance: 'textfield' }}
                    />
                    <button onClick={() => { const v = extraQty + 1; setExtraQty(v); setExtraQtyInput(String(v)); }}
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white active:scale-95"
                      style={{ backgroundColor: '#1A4731' }}>
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={closeExtraModal}
                  className="flex-1 py-3 rounded-xl font-semibold border border-gray-200 text-gray-500">
                  {lang === 'vi' ? 'Hủy' : 'Cancel'}
                </button>
                <button onClick={saveExtra} disabled={!extraProduct || savingExtra}
                  className="flex-1 py-3 rounded-xl font-bold text-white disabled:opacity-40 transition-colors"
                  style={{ backgroundColor: '#1A4731' }}>
                  {savingExtra ? '…' : (lang === 'vi' ? 'Xác nhận' : 'Confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Qty modal */}
      {qtyModal && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="modal-sheet bg-white w-full max-w-sm rounded-t-2xl p-6 space-y-5">
            <div>
              <h3 className="font-bold text-base" style={{ color: '#1A4731' }}>{qtyModal.product_name_vi}</h3>
              <p className="text-sm text-ink-light mt-0.5">
                {lang === 'vi' ? 'Cần làm' : 'Target'}: <strong>{qtyModal.qty_to_produce}</strong>
              </p>
              {qtyInput > qtyModal.qty_to_produce && (
                <p className="text-xs font-semibold mt-1" style={{ color: '#D97706' }}>
                  {lang === 'vi' ? '⚠️ Vượt mục tiêu — ghi nhận sản xuất thêm' : '⚠️ Over target — extra production noted'}
                </p>
              )}
            </div>
            <div className="flex items-center justify-center gap-4">
              <button onClick={() => setQtyInput(q => Math.max(0, q - 1))}
                className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center active:scale-95 transition-transform"
                style={{ color: '#1A4731' }}>
                <Minus size={20} />
              </button>
              <input
                type="number" min={0}
                value={qtyInput}
                onChange={e => setQtyInput(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="text-5xl font-black text-center rounded-xl border-2 outline-none w-24 py-2"
                style={{
                  color: qtyInput > qtyModal.qty_to_produce ? '#D97706' : '#1A4731',
                  borderColor: qtyInput > qtyModal.qty_to_produce ? '#D97706' : '#1A4731',
                  WebkitAppearance: 'none', MozAppearance: 'textfield',
                }}
              />
              <button onClick={() => setQtyInput(q => q + 1)}
                className="w-12 h-12 rounded-full flex items-center justify-center text-white active:scale-95 transition-transform"
                style={{ backgroundColor: '#1A4731' }}>
                <Plus size={20} />
              </button>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setQtyModal(null)} className="flex-1 py-3 rounded-xl font-semibold border border-gray-200 text-ink-light">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button onClick={savePartial}
                className="flex-1 py-3 rounded-xl font-bold text-white transition-colors"
                style={{ backgroundColor: '#1A4731' }}>
                {lang === 'vi' ? 'Xác nhận' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── NOTES EDITOR ────────────────────────────────────────────────────────────

function NotesEditor({
  assignmentId, initialNotes, lang, onSaved,
}: {
  assignmentId: string;
  initialNotes: string;
  lang: 'vi' | 'en';
  onSaved: (id: string, note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialNotes);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const supabase = createClient();
    await supabase.from('lab_assignments').update({ notes: value }).eq('id', assignmentId);
    setSaving(false);
    setEditing(false);
    onSaved(assignmentId, value);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1 flex-1 min-w-0">
        {value ? (
          <span className="text-xs text-ink-light italic truncate flex-1">{value}</span>
        ) : (
          <span className="text-xs text-ink-light/50 flex-1">
            {lang === 'vi' ? 'Thêm ghi chú…' : 'Add note…'}
          </span>
        )}
        <button onClick={() => setEditing(true)}
          className="p-1 shrink-0 opacity-40 hover:opacity-100 transition-opacity"
          style={{ color: '#1A4731' }}>
          <PenLine size={11} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-1">
      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        rows={2}
        autoFocus
        className="text-xs flex-1 border rounded-lg px-2 py-1 resize-none outline-none"
        style={{ borderColor: '#C4B5FD', fontSize: '11px' }}
      />
      <div className="flex flex-col gap-1 shrink-0">
        <button onClick={save} disabled={saving}
          className="text-[11px] font-bold px-2 py-0.5 rounded"
          style={{ backgroundColor: '#1A4731', color: 'white', opacity: saving ? 0.6 : 1 }}>
          {saving ? '…' : '✓'}
        </button>
        <button onClick={() => { setValue(initialNotes); setEditing(false); }}
          className="text-[11px] font-bold px-2 py-0.5 rounded"
          style={{ backgroundColor: '#F5F5F5', color: '#555' }}>
          ✕
        </button>
      </div>
    </div>
  );
}

// ─── PRODUCTION CARD ─────────────────────────────────────────────────────────

function ProductionCard({
  a, lang, updating, readOnly, onAdvance, onMarkInStock, onPartial, onViewFiche, onNoteUpdate, onBlocked, meta, backTo,
}: {
  a: Assignment;
  lang: 'vi' | 'en';
  updating: string | null;
  readOnly?: boolean;
  onAdvance: (a: Assignment) => void;
  onMarkInStock: (a: Assignment) => void;
  onPartial: (a: Assignment) => void;
  onViewFiche: (a: Assignment) => void;
  onNoteUpdate: (id: string, note: string) => void;
  onBlocked: (a: Assignment) => void;
  meta: typeof TEAM_LABELS[Team];
  backTo: string;
}) {
  const st = STATUS_META[a.status];
  const isUpdating = updating === a.id;
  // Breakdown collapsed by default on phones (open on sm+ via CSS)
  const [showBreakdown, setShowBreakdown] = useState(false);
  const canAdvance = !readOnly && !a.cancelled && ['pending', 'in_progress'].includes(a.status);
  const canMarkStock = !readOnly && !a.cancelled && ['pending', 'in_progress'].includes(a.status) && !a.is_extra;
  const canBlock = !readOnly && !a.cancelled && ['pending', 'in_progress'].includes(a.status);
  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];

  const actionLabel: Record<string, string> = {
    pending: lang === 'vi' ? 'Bắt đầu' : 'Start',
    in_progress: lang === 'vi' ? 'Xong' : 'Mark done',
  };

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        backgroundColor: a.cancelled ? '#F9FAFB' : 'white',
        border: a.cancelled ? '1px solid #E5E7EB' : '1px solid #E0D49A',
        boxShadow: a.cancelled ? 'none' : '0 1px 4px rgba(26,71,49,0.07)',
        opacity: a.cancelled ? 0.7 : 1,
      }}>

      {/* Status stripe for in_progress */}
      {a.status === 'in_progress' && !a.cancelled && (
        <div className="h-1" style={{ backgroundColor: '#2563EB' }} />
      )}

      <div className="flex flex-wrap items-start p-3 sm:p-4 gap-3">
        {/* Image */}
        {a.image_url ? (
          <img src={a.image_url} alt="" className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl object-cover shrink-0"
            style={{ border: '1px solid #E0D49A' }} loading="lazy" />
        ) : (
          <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl"
            style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          {a.fiche_id ? (
            <Link href={`/station/fiche/${a.fiche_id}?back=${backTo}`}
              className="font-bold text-sm sm:text-base leading-tight block hover:underline"
              style={{ color: a.cancelled ? '#9CA3AF' : '#1A4731', textDecoration: a.cancelled ? 'line-through' : undefined }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </Link>
          ) : (
            <div className="font-bold text-sm sm:text-base leading-tight"
              style={{ color: a.cancelled ? '#9CA3AF' : '#1A4731', textDecoration: a.cancelled ? 'line-through' : undefined }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </div>
          )}

          {/* SKU + weight + variant */}
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {a.sku && (
              <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: '#F5F5F5', color: '#555' }}>
                {a.sku}
              </span>
            )}
            {a.weight_grams && (
              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: '#FFF4CC', color: '#92600A' }}>
                {a.weight_grams}g
              </span>
            )}
            {a.variant_label && a.variant_label !== 'Standard' && (
              <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: '#EFF6FF', color: '#1D4ED8' }}>
                {a.variant_label}
              </span>
            )}
            {a.is_extra && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: '#FEF3C7', color: '#D97706' }}>
                {lang === 'vi' ? '+ Ngoài đơn' : '+ Extra'}
              </span>
            )}
          </div>

          {/* Qty + status */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-xl sm:text-2xl font-black" style={{ color: a.cancelled ? '#9CA3AF' : meta.color, textDecoration: a.cancelled ? 'line-through' : undefined }}>x{a.qty_to_produce}</span>
            {a.qty_produced > 0 && a.status !== 'done' && (
              <span className="text-sm text-ink-light">(✓ {a.qty_produced})</span>
            )}
            {a.cancelled ? (
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold"
                style={{ backgroundColor: '#E5E7EB', color: '#6B7280' }}>
                {lang === 'vi' ? '✕ Đã hủy' : '✕ Cancelled'}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold text-white"
                style={{ backgroundColor: st.color }}>
                {lang === 'vi' ? st.labelVi : st.labelEn}
              </span>
            )}
          </div>
          {a.status === 'blocked' && a.blocked_reason && !a.cancelled && (
            <div className="mt-1 text-xs font-medium rounded-lg px-2 py-1 inline-block"
              style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>
              ⚠ {a.blocked_reason}
            </div>
          )}

          {/* Birthday cake: ready-by deadline (red) + message on the cake */}
          {(a.bc_ready_time || a.bc_message) && (
            <div className="mt-1.5 flex flex-col gap-1 items-start">
              {a.bc_ready_time && (
                <span className="text-[11px] font-bold rounded-lg px-2 py-1 inline-flex items-center gap-1.5"
                  style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>
                  <Clock size={12} /> {lang === 'vi' ? 'Cần xong' : 'Ready by'} {a.bc_ready_time.slice(0, 5)}
                </span>
              )}
              {a.bc_message && (
                <span className="text-xs font-medium rounded-lg px-2 py-1 inline-flex items-start gap-1.5"
                  style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                  🎂 <span style={{ fontWeight: 500 }}>{a.bc_message}</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons — horizontal row below content on phones, column on the right from sm up */}
        <div className="flex w-full sm:w-auto sm:flex-col gap-2 shrink-0 order-last sm:order-none">
          {canAdvance && (
            <button onClick={() => onAdvance(a)} disabled={isUpdating}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl font-bold text-white text-sm active:scale-95 transition-all"
              style={{ backgroundColor: '#1A4731', opacity: isUpdating ? 0.6 : 1 }}>
              {isUpdating ? '…' : actionLabel[a.status] ?? ''}
            </button>
          )}
          {canMarkStock && (
            <button onClick={() => onMarkInStock(a)} disabled={isUpdating}
              className="flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1 active:scale-95 transition-all"
              style={{ border: '1px solid #C4B5FD', color: '#6D28D9', backgroundColor: '#F5F3FF', opacity: isUpdating ? 0.6 : 1 }}>
              <Package size={11} />
              {lang === 'vi' ? 'Có sẵn' : 'In stock'}
            </button>
          )}
          {a.status === 'in_progress' && !readOnly && (
            <button onClick={() => onPartial(a)}
              className="flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors text-center"
              style={{ borderColor: '#E0D49A', color: '#6B7280' }}>
              {lang === 'vi' ? 'Ghi số' : 'Enter qty'}
            </button>
          )}
          {canBlock && (
            <button onClick={() => onBlocked(a)} disabled={isUpdating}
              className="flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-semibold active:scale-95 transition-all"
              style={{ border: '1px solid #FCA5A5', color: '#DC2626', backgroundColor: '#FEF2F2', opacity: isUpdating ? 0.6 : 1 }}>
              {lang === 'vi' ? 'Chặn' : 'Block'}
            </button>
          )}
          {a.status === 'blocked' && !readOnly && (
            <button onClick={() => onAdvance(a)} disabled={isUpdating}
              className="flex-1 sm:flex-none px-3 py-1.5 rounded-xl text-xs font-semibold active:scale-95 transition-all"
              style={{ border: '1px solid #A7D4B8', color: '#2D6A4F', backgroundColor: '#F0F9F4', opacity: isUpdating ? 0.6 : 1 }}>
              {lang === 'vi' ? 'Mở lại' : 'Unblock'}
            </button>
          )}
        </div>
      </div>

      {/* Breakdown — tap to expand on phones, always visible from sm up */}
      {breakdown.length > 0 && (
        <div className="border-t" style={{ borderColor: '#F5EFC8' }}>
          <button
            onClick={() => setShowBreakdown(v => !v)}
            className="w-full px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1.5 sm:pointer-events-none"
            style={{ color: '#2D6A4F', backgroundColor: '#F0F9F4' }}>
            <Store size={10} />
            <span>{lang === 'vi' ? 'Khách hàng' : 'Clients'} · {breakdown.length}</span>
            {/* Collapsed summary: earliest delivery time hints the deadline without opening */}
            {!showBreakdown && breakdown.some(b => b.delivery_time) && (
              <span className="sm:hidden normal-case font-bold px-1.5 py-0.5 rounded"
                style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                ⏰ {breakdown.map(b => b.delivery_time).filter(Boolean).sort()[0]?.slice(0, 5)}
              </span>
            )}
            <ChevronRight size={11} className={`ml-auto sm:hidden transition-transform ${showBreakdown ? 'rotate-90' : ''}`} />
          </button>
          <div className={`${showBreakdown ? '' : 'hidden'} sm:block`}>
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2 text-sm"
              style={{
                borderTop: i > 0 ? '1px solid #F5EFC8' : undefined,
                backgroundColor: i % 2 === 0 ? 'white' : '#FFFAEE',
              }}>
              <span className="text-ink font-medium flex items-center gap-1.5">
                {b.shop_name}
                {b.delivery_time && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                    ⏰ {b.delivery_time.slice(0, 5)}
                  </span>
                )}
              </span>
              <span className="font-black" style={{ color: '#1A4731' }}>x{b.qty}</span>
            </div>
          ))}
          </div>
        </div>
      )}

      {/* Notes + fiche */}
      <div className="px-4 pb-3 pt-2 flex items-center justify-between gap-2"
        style={{ borderTop: '1px solid #F5EFC8' }}>
        <NotesEditor assignmentId={a.id} initialNotes={a.notes} lang={lang} onSaved={onNoteUpdate} />
        {a.fiche_id && (
          <button onClick={() => onViewFiche(a)}
            className="flex items-center gap-1 text-xs font-semibold transition-colors shrink-0"
            style={{ color: '#2D6A4F' }}>
            <BookOpen size={12} />
            {lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe card'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── TERMINÉ CARD ────────────────────────────────────────────────────────────

function TermineCard({
  a, lang, meta, onAdvance, updating,
}: {
  a: Assignment;
  lang: 'vi' | 'en';
  meta: typeof TEAM_LABELS[Team];
  onAdvance: (a: Assignment) => void;
  updating: string | null;
}) {
  const isSkip = a.status === 'skip';
  const ahead = !!a.produced_ahead && !isSkip; // done in advance of the delivery day
  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        backgroundColor: isSkip ? '#F5F3FF' : ahead ? '#EFF6FF' : 'white',
        border: isSkip ? '1.5px solid #C4B5FD' : ahead ? '1.5px solid #93C5FD' : '1px solid #E0D49A',
        opacity: isSkip ? 1 : ahead ? 1 : 0.75,
      }}>
      <div className="flex items-center gap-3 p-4">
        {a.image_url ? (
          <img src={a.image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
            style={{ border: '1px solid #E0D49A' }} />
        ) : (
          <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-xl"
            style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm" style={{ color: '#1A4731' }}>
            {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {a.sku && <span className="text-[10px] font-mono text-ink-light">{a.sku}</span>}
            {a.weight_grams && <span className="text-[10px] text-ink-light">{a.weight_grams}g</span>}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {isSkip ? (
              <span className="text-xs font-semibold flex items-center gap-1" style={{ color: '#6D28D9' }}>
                <Package size={11} />
                {lang === 'vi' ? 'Có sẵn trong kho' : 'In stock'}
              </span>
            ) : (
              <span className="text-xs font-semibold flex items-center gap-1" style={{ color: ahead ? '#1E40AF' : '#059669' }}>
                <CheckCircle2 size={11} />
                {lang === 'vi' ? `Đã làm x${a.qty_produced}` : `Done x${a.qty_produced}`}
              </span>
            )}
            {ahead && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                style={{ backgroundColor: '#DBEAFE', color: '#1E40AF' }}>
                ⏩ {lang === 'vi' ? 'Làm trước' : 'Ahead'}
              </span>
            )}
            {a.transferred && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
                style={{ backgroundColor: '#DBEAFE', color: '#1D4ED8' }}>
                <Package size={10} />{lang === 'vi' ? 'Đã chuyển kho' : 'Sent to stock'}
              </span>
            )}
            <span className="text-xl font-black" style={{ color: isSkip ? '#7C3AED' : meta.color }}>
              x{a.qty_to_produce}
            </span>
          </div>
        </div>
        {/* Revert button for skip */}
        {isSkip && (
          <button onClick={() => onAdvance(a)} disabled={updating === a.id}
            className="px-3 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all"
            style={{ backgroundColor: '#EDE9FE', color: '#6D28D9', opacity: updating === a.id ? 0.6 : 1 }}>
            {lang === 'vi' ? 'Cần làm' : 'Produce'}
          </button>
        )}
      </div>
      {/* Breakdown for done items */}
      {!isSkip && breakdown.length > 0 && (
        <div className="border-t" style={{ borderColor: '#F5EFC8' }}>
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-1.5 text-xs text-ink-light"
              style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
              <span>{b.shop_name}</span>
              <span className="font-bold">x{b.qty}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FICHE MODAL ─────────────────────────────────────────────────────────────

function FicheModal({
  ficheId, productName, lang, backTo, onClose,
}: {
  ficheId: string; productName: string; lang: 'vi' | 'en'; backTo: string; onClose: () => void;
}) {
  const [steps, setSteps] = useState<FicheStep[] | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => setIsLoggedIn(!!data.session));
    // fiche_id is known directly on the assignment — load steps straight away
    supabase
      .from('lab_fiche_steps')
      .select('step_number, description_vi, description_en, duration_minutes, temperature_celsius')
      .eq('fiche_id', ficheId)
      .eq('step_type', 'step')
      .order('step_number')
      .then(({ data }) => setSteps(data ?? []));
  }, [ficheId]);

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="modal-sheet bg-white w-full max-w-lg rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid #E0D49A' }}>
          <div className="flex items-center gap-2">
            <BookOpen size={18} style={{ color: '#1A4731' }} />
            <span className="font-bold text-base" style={{ color: '#1A4731' }}>{productName}</span>
          </div>
          <div className="flex items-center gap-2">
            {isLoggedIn && (
              <Link href={`/admin/fiches/${ficheId}?back=${backTo}`}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{ backgroundColor: '#F0FDF4', color: '#166534' }}>
                {lang === 'vi' ? 'Chỉnh sửa' : 'Edit'}
              </Link>
            )}
            <Link href={`/station/fiche/${ficheId}?back=${backTo}`}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              style={{ backgroundColor: '#FFF4CC', color: '#1A4731' }}>
              {lang === 'vi' ? 'Xem đầy đủ' : 'Full view'}
            </Link>
            <button onClick={onClose} className="p-1 text-ink-light hover:text-ink transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {steps === null ? (
            <div className="space-y-4">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex gap-3">
                  <div className="skeleton w-7 h-7 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5 pt-0.5">
                    <div className="skeleton h-3.5 w-full" />
                    <div className="skeleton h-3.5 w-2/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : steps.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-ink-light text-sm">
                {lang === 'vi' ? 'Chưa có phiếu kỹ thuật cho sản phẩm này.' : 'No recipe steps added yet.'}
              </p>
              <Link href={`/station/fiche/${ficheId}?back=${backTo}`}
                className="text-xs font-semibold mt-2 inline-block" style={{ color: '#1A4731' }}>
                {lang === 'vi' ? 'Xem trang phiếu →' : 'View fiche page →'}
              </Link>
            </div>
          ) : steps.map(step => (
            <div key={step.step_number} className="flex gap-3">
              <div className="w-7 h-7 rounded-full text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
                style={{ backgroundColor: '#1A4731' }}>
                {step.step_number}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-sm leading-relaxed" style={{ color: '#1A2C24' }}>
                  {lang === 'vi' ? step.description_vi : (step.description_en || step.description_vi)}
                </p>
                {(step.duration_minutes || step.temperature_celsius) && (
                  <div className="flex gap-4 text-xs text-ink-light">
                    {step.duration_minutes && (
                      <span className="flex items-center gap-1">
                        <Timer size={11} /> {step.duration_minutes} {lang === 'vi' ? 'phút' : 'min'}
                      </span>
                    )}
                    {step.temperature_celsius && (
                      <span className="flex items-center gap-1">
                        <Thermometer size={11} /> {step.temperature_celsius}°C
                      </span>
                    )}
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
