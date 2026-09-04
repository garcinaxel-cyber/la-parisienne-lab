'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2, Play, AlertCircle, Clock, FlaskConical, Minus, Plus,
  BookOpen, X, Timer, Thermometer, LogOut, Store, Package, ClipboardList,
  ChevronRight, PenLine, RefreshCw, Truck, TrendingUp,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, type Team, type AssignmentStatus } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';
import { useRealtimeRefresh } from '@/lib/useRealtimeRefresh';
import { thumb } from '@/lib/img-thumb';

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

// changed_at/changed_delta: set by odoo-apply.ts whenever Odoo moves this client's demand after
// the card already existed — lab-local "MM-DD HH:mm" stamp + the delta applied, shown inline next
// to the client instead of a flat audit-trail line at the bottom of the card (2026-08-13, Axel:
// "je veux que ça apparaisse à côté du client correspondant... au lieu de chercher quel client
// est la REP...").
type BreakdownItem = {
  shop_name: string; qty: number; order_ref?: string; delivery_time?: string | null; note?: string | null;
  changed_at?: string; changed_delta?: number;
};

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
  blocked_at?: string | null;
  blocked_by_name?: string | null;
  sort_order: number;
  import_id: string;
  is_extra?: boolean;
  produced_by_name?: string | null;
  produced_at?: string | null;
  produced_ahead?: boolean;
  cancelled?: boolean;
  transferred?: boolean;
  qty_sent_total?: number;
  bc_message?: string | null;
  bc_notes?: string | null; // generic free-text note (entremets etc. — see page.tsx, 2026-08-27)
  bc_ready_time?: string | null;
  bc_design_notes?: string | null;
  bc_design_photo_url?: string | null;
  bc_shop_name?: string | null; // manual/exceptional cake's own shop — breakdown is always [] for these
  bc_order_ref?: string | null; // set once the manual cake is matched to a real Odoo order
  draft_odoo?: boolean;
  sku: string | null;
  weight_grams: number | null;
  category_name_vi: string | null;
  category_name_en: string | null;
  breakdown: BreakdownItem[];
  lab_imports: { delivery_date: string; order_number: number; type: string; status: string; imported_at?: string };
};

// Search result = a lab fiche (id is the fiche_id, variant_id its default variant)
type SearchProduct = {
  id: string;
  name_vi: string;
  name_en: string | null;
  sku: string | null;
  variant_id: string | null;
  main_image_url: string | null;
  variants?: { id: string; sku: string | null; label: string; image_url: string | null; weight_g: number | null }[];
  is_lab_only: boolean;
  category_id: string | null;
  subcategory: string | null;
};
type ExtraVariant = { id: string; sku: string | null; label: string; image_url: string | null; weight_g?: number | null };

type Category = { id: string; name_vi: string; name_en: string };

type FicheStep = {
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
};

type Tab = 'production' | 'commande' | 'termine' | 'upcoming' | 'history' | 'analytics';

type DateSummary = {
  delivery_date: string;
  productCount: number;
  totalQty: number;
  doneQty: number;
  stockQty: number; // servi depuis le stock (cartes 'skip') — rendu explicite 2026-09-03
  import_ids: string[];
  unsentCount: number; // distinct products still not sent to stock (history tab only)
};

// Analytics tab — reworked 2026-08-21 (Axel: "Completion by team (delivery) du jour" + Lab stock
// for the team's own products, everything else removed). Today only, no more 7j/30j range.
// Stock grouped by category (Axel: "ranger par categorie"); completion includes a per-product
// detail (Axel: "je veux le detail aussi").
type StockLevel = { sku: string; name: string; qty: number; found: boolean; threshold: number | null };
type StockCategoryGroup = { category: string; items: StockLevel[] };
type CompletionProductDetail = { sku: string; name: string; expected: number; checked: number; gap: number };
type TeamTodaySnapshot = {
  completion: { expected: number; checked: number; rate: number; products: CompletionProductDetail[] };
  stock: StockCategoryGroup[]; // empty for teams with no dedicated stock category (entremet, baker)
};

type OrderDetail = {
  id: string; // stable React key — distinct from order_ref, which synthetic manual entries share
  order_ref: string;
  shop_name: string;
  isManual?: boolean; // exceptional/manual cake not yet linked to an Odoo order
  items: {
    product_name_vi: string; variant_label: string; qty: number; sku: string | null;
    message?: string | null; notes?: string | null; designNotes?: string | null; designPhotoUrl?: string | null;
  }[];
};

// One raw (done, non-cancelled) production card for the history tab's expanded view.
type HistoryProdRow = {
  id: string; product_name_vi: string; product_name_en: string; sku: string | null;
  variant_label: string; image_url: string | null;
  qty_produced: number; total_qty: number; qty_sent_total: number; is_extra: boolean;
  delivery_date: string;
};
type HistoryProdGroup = {
  key: string; name: string; name_en: string; sku: string | null; variant: string;
  image_url: string | null; qty: number; is_extra: boolean;
  remaining: number; parts: { id: string; qty: number; deliveryDate: string }[];
};

// Split a day's raw production cards into "sent" (fully sent to stock — shown as a compact
// aggregated list) and "unsent" (still has something to send — shown as individual, selectable
// cards). Mirrors the same qty_produced - qty_sent_total logic as groupSendable() (today's
// stock modal) but works off the lightweight rows fetched for history days.
function groupHistoryProd(rows: HistoryProdRow[]): { sent: HistoryProdGroup[]; unsent: HistoryProdGroup[] } {
  const m = new Map<string, HistoryProdGroup>();
  for (const r of rows) {
    const key = `${r.sku ?? ''}||${r.variant_label}||${r.product_name_vi}||${r.is_extra ? 1 : 0}`;
    const produced = r.qty_produced || r.total_qty || 0;
    const remaining = Math.max(0, produced - r.qty_sent_total);
    const g = m.get(key) ?? {
      key, name: r.product_name_vi, name_en: r.product_name_en, sku: r.sku,
      variant: r.variant_label, image_url: r.image_url, qty: 0, is_extra: r.is_extra,
      remaining: 0, parts: [],
    };
    g.qty += produced;
    if (remaining > 0) { g.remaining += remaining; g.parts.push({ id: r.id, qty: remaining, deliveryDate: r.delivery_date }); }
    m.set(key, g);
  }
  const all = Array.from(m.values());
  const byName = (x: HistoryProdGroup, y: HistoryProdGroup) => (x.is_extra ? 1 : 0) - (y.is_extra ? 1 : 0) || x.name.localeCompare(y.name);
  return { sent: all.filter(g => g.remaining === 0).sort(byName), unsent: all.filter(g => g.remaining > 0).sort(byName) };
}

const STATUS_FLOW: Partial<Record<AssignmentStatus, AssignmentStatus>> = {
  pending: 'in_progress',
  in_progress: 'done',
  partial: 'done',
  skip: 'pending',
  blocked: 'pending',
};

export default function StationView({
  team, teamSlug, assignments: initial, tomorrowAssignments = [], viewDate, today, tomorrow, isHistoryView, userRole, userId = null, userName = null,
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
  userId?: string | null;
  userName?: string | null;
}) {
  const { lang, setLang } = useI18n();
  const router = useRouter();
  // Live updates: the existing channel below patches assignment status/qty in place (smooth).
  // This refreshes the page for changes that need fresh server data — new cards (INSERT/DELETE),
  // a newly published order (lab_imports), per-order publish + birthday message/ready-time.
  // Scoped by team where the table has a `team` column (lab_order_lines, lab_assignments) —
  // 2026-08-06: previously unfiltered, so ANY team's change (all 4 stations open at once during
  // the 7-9h rush) refreshed EVERY open /station/[team] tab, multiplying invocations/Active CPU
  // 4x for no reason. lab_imports (one row per import session, no team column) and
  // lab_birthday_details (no team column, reached only via order_line_id join — Realtime filters
  // can't follow FKs) stay unfiltered, but both are low-frequency writes (a handful/day vs.
  // hundreds of assignment/order-line updates as chefs work), so this is the lever that matters.
  useRealtimeRefresh(`station-refresh-${team}`, [
    { table: 'lab_imports' },
    { table: 'lab_order_lines', filter: `team=eq.${team}` },
    { table: 'lab_birthday_details' },
    { table: 'lab_assignments', filter: `team=eq.${team}` },
  ]);
  // Production day sub-toggle: today (default) or tomorrow (pre-production)
  const [prodDay, setProdDay] = useState<'today' | 'tomorrow'>('today');
  const [showInStock, setShowInStock] = useState(false);
  const [showRecap, setShowRecap] = useState(true);
  const [showDoneRecap, setShowDoneRecap] = useState(true);
  const [showOrderRecap, setShowOrderRecap] = useState(true);
  // Point 2 (chef Entremet, 2026-09-02): per-order tracking. orderView switches the
  // Commande tab between the per-product list ('sp', historic view) and per-order
  // cards ('don'); orderFilter narrows the Production tab to one order's cards.
  const [orderView, setOrderView] = useState<'sp' | 'don'>('sp');
  const [orderFilter, setOrderFilter] = useState<string | null>(null);
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
  // Raw (non-cancelled, done) production cards per day — kept raw rather than pre-aggregated
  // so the history view can split "sent to stock" (compact list) from "not sent" (individual
  // cards, selectable) once expanded. See groupHistoryProd() below.
  const [historyProduction, setHistoryProduction] = useState<Record<string, HistoryProdRow[]>>({});
  // Cartes "có sẵn trong kho" (skip) du jour — servies depuis le stock, donc absentes de la
  // liste "produit". Sans elles, le badge (98) ≠ la liste (80) et ça ressemble à des lignes
  // cachées (Axel, 2026-09-03 : "le total produit par jour est pas correct ou il y a des
  // lignes cachées") — en réalité 80 produits + 18 pris en stock = 98.
  const [historyInStock, setHistoryInStock] = useState<Record<string, { name: string; variant: string; qty: number }[]>>({});
  const [loadingDetails, setLoadingDetails] = useState(false);
  // Which "not sent" product groups are selected for the history day's send-to-stock action.
  // Missing entry for a date = everything defaults to selected (see groupHistoryProd usage).
  const [historySel, setHistorySel] = useState<Record<string, Set<string>>>({});
  const [sendingHistoryStock, setSendingHistoryStock] = useState<string | null>(null);

  // Analytics tab — today's Completion by team (delivery) + Lab stock (2026-08-21 rework)
  const [analyticsData, setAnalyticsData] = useState<TeamTodaySnapshot | null>(null);
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  // Safety stock threshold — inline edit per Lab stock line (Axel, 2026-08-21)
  const [thresholdEdit, setThresholdEdit] = useState<string | null>(null); // sku being edited
  const [thresholdDraft, setThresholdDraft] = useState('');
  const [savingThreshold, setSavingThreshold] = useState<string | null>(null);

  // Stock transfer (send finished products to stock)
  const [stockModal, setStockModal] = useState(false);
  const [stockSel, setStockSel] = useState<Record<string, { on: boolean; qty: string }>>({});
  const [sendingStock, setSendingStock] = useState(false);

  // Birthday cake design reference photo — tap the thumbnail to see it full-size
  const [designPhotoModal, setDesignPhotoModal] = useState<string | null>(null);

  // Delete an extra production card (wrong product picked) — blocked once transferred
  const [deleteModal, setDeleteModal] = useState<Assignment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  // Extra production modal
  const [extraModal, setExtraModal] = useState(false);
  const [extraSearch, setExtraSearch] = useState('');
  const [extraResults, setExtraResults] = useState<SearchProduct[]>([]);
  const [extraProduct, setExtraProduct] = useState<SearchProduct | null>(null);
  const [extraVariant, setExtraVariant] = useState<ExtraVariant | null>(null);
  const [extraQty, setExtraQty] = useState(1);
  const [extraQtyInput, setExtraQtyInput] = useState('1');
  // Weight-based extra production (2026-08-22): Biscuit Voyage (incl. Lady Finger, per Axel —
  // also weight-produced) is made in bulk by weight, then packaged into fixed-weight units. A
  // chef can enter the produced weight in kg instead of a unit count; converted to a floored
  // unit count (remainder deliberately discarded — no fractional boxes make sense in Odoo).
  const [extraWeightKg, setExtraWeightKg] = useState('');
  const [savingExtra, setSavingExtra] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [extraCategories, setExtraCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');

  // On-demand Odoo sync (header button) — same "auto" behaviour as the 15-min cron, just
  // triggered by a chef who doesn't want to wait. syncState drives the icon (spin while
  // syncing, brief check/alert after) and syncCooldown blocks re-clicks for ~45s so the button
  // can't be hammered.
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'ok' | 'error'>('idle');
  const [syncCooldown, setSyncCooldown] = useState(false);
  async function handleSyncOdoo() {
    if (syncState === 'syncing' || syncCooldown) return;
    setSyncState('syncing');
    const { syncOdooAction } = await import('./actions');
    const res = await syncOdooAction();
    setSyncState(res.error ? 'error' : 'ok');
    setSyncCooldown(true);
    setTimeout(() => setSyncCooldown(false), 45000);
    setTimeout(() => setSyncState('idle'), 2500);
    if (res.ok && (res.createdImports || res.changesApplied)) router.refresh();
  }

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

  // Weight-based extra production — gate strictly on category (confirmed with Axel: this
  // includes Lady Finger, which is also weight-produced despite living under Biscuit Voyage).
  const isWeightCategory = extraProduct?.subcategory === 'Biscuit Voyage';
  const extraVariantWeightG = extraVariant?.weight_g ?? null;
  const canWeighExtra = isWeightCategory && !!extraVariantWeightG && extraVariantWeightG > 0;
  const extraWeightKgNum = parseFloat(extraWeightKg.replace(',', '.'));
  const extraWeightUnits = canWeighExtra && Number.isFinite(extraWeightKgNum) && extraWeightKgNum > 0 && extraVariantWeightG
    ? Math.floor((extraWeightKgNum * 1000) / extraVariantWeightG)
    : 0;

  // Keep extraQty (what saveExtra actually writes) in sync with the weight conversion while in
  // weight mode, so the rest of the save path needs zero changes.
  useEffect(() => {
    if (!canWeighExtra) return;
    setExtraQty(extraWeightUnits);
    setExtraQtyInput(String(extraWeightUnits));
  }, [canWeighExtra, extraWeightUnits]);

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

    // A dead local session (access token expired *and* refresh token revoked — e.g. the
    // browser sat open for weeks) doesn't error out below: supabase-js quietly drops back to
    // an anonymous request, and RLS returns an empty-but-error-free result set. That's
    // indistinguishable from genuinely-empty history/upcoming, so check auth up front instead.
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }

      supabase
        .from('lab_imports')
        .select('id, delivery_date')
        .eq('status', 'published')
        [isUpcoming ? 'gt' : 'lt']('delivery_date', today)
        .order('delivery_date', { ascending: isUpcoming })
        // The auto-sync re-imports throughout the day, so one calendar date can span many
        // lab_imports rows (10+ isn't unusual). Capping this query by ROW count would cut the
        // list off after 1-2 days instead of the ~30 distinct days we actually want — so we
        // fetch a generous batch of rows here, then dedupe/cap by DATE below.
        .limit(600)
        .then(async ({ data: allImports, error: importsErr }) => {
          // A stale/expired session surfaces here as a PostgREST error (not just empty data) —
          // without this check it silently renders as an empty "No history yet" with no way to
          // recover, when the actual fix is just to sign back in.
          if (importsErr) {
            console.error('lab_imports fetch failed', importsErr);
            if (/jwt/i.test(importsErr.message ?? '') || importsErr.code === 'PGRST301' || importsErr.code === 'PGRST303') {
              router.push('/login');
              return;
            }
          }
          if (!allImports?.length) {
            if (isUpcoming) setUpcomingData([]);
            else setHistoryData([]);
            setLoadingDates(false);
            return;
          }
          // allImports is already ordered by delivery_date, so this keeps the nearest/most
          // recent days in order. History is capped at 7 (rolling week) rather than 30 --
          // Axel, 2026-09-01: keep DB load light now that this query pages through everything
          // instead of silently truncating (see the lab_assignments pagination just below) --
          // old history isn't actionable day-to-day anyway. Upcoming keeps the full 30 (future
          // days are far fewer rows, never near the row-cap problem this was about).
          const keepDates = new Set(Array.from(new Set(allImports.map((i: any) => i.delivery_date))).slice(0, isUpcoming ? 30 : 7));
          const imports = allImports.filter((i: any) => keepDates.has(i.delivery_date));
          const importIds = imports.map((i: any) => i.id);
          // PostgREST silently caps any query with no explicit limit at 1000 rows (no error --
          // asgnsErr stays null, you just get fewer rows than exist). A 30-day window can hold
          // more than that for a busy team (baby_mama alone was already at 1184 rows on
          // 2026-09-01), and with no .order() here WHICH rows got dropped was arbitrary -- could
          // land on any date/status, changing from load to load. That under/over-counted the
          // "sản phẩm / cái" badge shown per day, while the per-day detail view (loadHistoryDetails,
          // one day's imports at a time, always far under 1000) stayed correct -- exactly the
          // mismatch Axel flagged on 09-01 (history badge 27·96 vs detail total 136 for 31/08).
          // Fix: page through with .range() on a stable order until a page comes back short.
          let asgns: any[] = [];
          let asgnsErr: any = null;
          {
            const PAGE_SIZE = 1000;
            let from = 0;
            for (let page = 0; page < 20; page++) { // 20 * 1000 = safety ceiling, never expected to hit
              const { data, error } = await supabase
                .from('lab_assignments')
                .select('import_id, qty_to_produce, status, product_name_vi, variant_label, transferred, cancelled')
                .in('import_id', importIds)
                .eq('team', team)
                .order('id', { ascending: true })
                .range(from, from + PAGE_SIZE - 1);
              if (error) { asgnsErr = error; break; }
              asgns = asgns.concat(data ?? []);
              if (!data || data.length < PAGE_SIZE) break;
              from += PAGE_SIZE;
            }
          }
          if (asgnsErr) {
            console.error('lab_assignments fetch failed', asgnsErr);
            if (/jwt/i.test(asgnsErr.message ?? '') || asgnsErr.code === 'PGRST301' || asgnsErr.code === 'PGRST303') {
              router.push('/login');
              return;
            }
          }
          const byDate = new Map<string, DateSummary>();
          for (const imp of imports) {
            if (!byDate.has(imp.delivery_date))
              byDate.set(imp.delivery_date, { delivery_date: imp.delivery_date, productCount: 0, totalQty: 0, doneQty: 0, stockQty: 0, import_ids: [], unsentCount: 0 });
            byDate.get(imp.delivery_date)!.import_ids.push(imp.id);
          }
          // Distinct products still not sent to stock, per date (history tab only — surfaced as a
          // badge on the collapsed row so a chef notices without opening it).
          const unsentByDate = new Map<string, Set<string>>();
          for (const a of asgns ?? []) {
            const imp = imports.find((i: any) => i.id === a.import_id);
            if (!imp) continue;
            // Cancelled cards are out of every production metric everywhere else (today's
            // tabs, analytics) — the badge was the one place still counting them, silently
            // inflating "sản phẩm / cái" on days with cancellations (Axel, 2026-09-03).
            if (a.cancelled) continue;
            const s = byDate.get(imp.delivery_date)!;
            s.productCount++;
            s.totalQty += a.qty_to_produce ?? 0;
            if (a.status === 'done' || a.status === 'skip') s.doneQty += a.qty_to_produce ?? 0;
            if (a.status === 'skip') s.stockQty += a.qty_to_produce ?? 0;
            if (!isUpcoming && a.status === 'done' && !a.cancelled && !a.transferred) {
              const set = unsentByDate.get(imp.delivery_date) ?? new Set<string>();
              set.add(`${a.product_name_vi ?? ''}||${a.variant_label ?? 'Standard'}`);
              unsentByDate.set(imp.delivery_date, set);
            }
          }
          unsentByDate.forEach((set, date) => { byDate.get(date)!.unsentCount = set.size; });
          const result = Array.from(byDate.values()).filter(d => d.productCount > 0);
          if (isUpcoming) setUpcomingData(result);
          else setHistoryData(result);
          setLoadingDates(false);
        });
    })();
  }, [activeTab, team, today]);

  // Analytics data — via a server action (see getTeamAnalyticsAction in ./actions), NOT
  // a direct client query: lab_delivery_check_lines/lab_excluded_skus RLS only grants SELECT to
  // admin/lab_manager/assistant, so a chef's own browser session can't read them. The action
  // checks the chef is logged in, then reads through the service-role client and returns only
  // today's team-scoped completion + Lab stock — same pattern as the Odoo sync button.
  // Fetched once on mount (no longer gated on opening the tab, 2026-09-04, Axel: point rouge sur
  // le titre Analytique quand un stock est sous le seuil de securite) so the tab-title red-dot
  // alert (see lowStockAlert below) reflects reality even before the chef opens the tab. For
  // entremet/baker (no TEAM_STOCK_CATEGORIES entry) this still only costs the cheap completion
  // query — getTeamAnalyticsAction only calls Odoo when categories?.length is truthy.
  useEffect(() => {
    if (analyticsData) return;
    setLoadingAnalytics(true);
    (async () => {
      const { getTeamAnalyticsAction } = await import('./actions');
      const res = await getTeamAnalyticsAction(team);
      if (res.data) setAnalyticsData(res.data);
      setLoadingAnalytics(false);
    })();
  }, [team, analyticsData]);

  async function saveThreshold(sku: string) {
    const val = parseFloat(thresholdDraft);
    if (!Number.isFinite(val) || val < 0) return;
    setSavingThreshold(sku);
    const { setStockThresholdAction } = await import('./actions');
    const res = await setStockThresholdAction(sku, val, userName);
    if (!res.error) {
      setAnalyticsData(prev => prev ? {
        ...prev,
        stock: prev.stock.map(g => ({ ...g, items: g.items.map(s => s.sku === sku ? { ...s, threshold: val } : s) })),
      } : prev);
      setThresholdEdit(null);
    }
    setSavingThreshold(null);
  }

  async function loadHistoryDetails(delivery_date: string, import_ids: string[]) {
    if (historyDetails[delivery_date] !== undefined) return;
    setLoadingDetails(true);
    const supabase = createClient();
    // Orders (what was to produce) + real production (what was actually made) in parallel
    const [{ data: lines }, { data: prod }, { data: manualCakes }] = await Promise.all([
      supabase.from('lab_order_lines')
        .select('id, order_ref, shop_name, product_name_vi, variant_label, qty, product_sku')
        .in('import_id', import_ids).eq('team', team).order('order_ref'),
      supabase.from('lab_assignments')
        .select('id, product_name_vi, product_name_en, variant_label, image_url, qty_produced, total_qty, qty_to_produce, qty_sent_total, is_extra, cancelled, variant_id, status')
        .in('import_id', import_ids).eq('team', team).in('status', ['done', 'skip']),
      // Birthday-cake design photo/notes/message — only lives on lab_manual_cakes, never on
      // lab_order_lines. Matched by team+date so both Odoo-linked AND still-unlinked
      // exceptional orders show their design here (not just once they hit an Odoo doc).
      supabase.from('lab_manual_cakes')
        .select('id, product_sku, product_name_vi, qty, shop_name, message, notes, design_notes, design_photo_url, matched_order_ref, cancelled_at')
        .eq('team', team).eq('delivery_date', delivery_date),
    ]);
    const lineIds = (lines ?? []).map((l: any) => l.id);
    const { data: bcDetails } = lineIds.length
      ? await supabase.from('lab_birthday_details').select('order_line_id, message').in('order_line_id', lineIds)
      : { data: [] as any[] };
    const messageByLineId: Record<string, string | null> = {};
    for (const d of bcDetails ?? []) messageByLineId[d.order_line_id] = d.message ?? null;
    const activeManualCakes = (manualCakes ?? []).filter((m: any) => !m.cancelled_at);
    const manualByRefSku: Record<string, any> = {};
    for (const m of activeManualCakes) {
      if (m.matched_order_ref && m.matched_order_ref !== '__pending_create__') {
        manualByRefSku[`${m.matched_order_ref}||${m.product_sku ?? ''}`] = m;
      }
    }

    const byRef = new Map<string, OrderDetail>();
    for (const line of lines ?? []) {
      if (!byRef.has(line.order_ref))
        byRef.set(line.order_ref, { id: line.order_ref, order_ref: line.order_ref, shop_name: line.shop_name, items: [] });
      const mc = manualByRefSku[`${line.order_ref}||${line.product_sku ?? ''}`];
      byRef.get(line.order_ref)!.items.push({
        product_name_vi: line.product_name_vi,
        variant_label: line.variant_label,
        qty: line.qty,
        sku: line.product_sku ?? null,
        message: messageByLineId[line.id] ?? mc?.message ?? null,
        notes: mc?.notes ?? null,
        designNotes: mc?.design_notes ?? null,
        designPhotoUrl: mc?.design_photo_url ?? null,
      });
    }
    // Exceptional orders not yet linked to an Odoo document have no lab_order_lines row at
    // all, so they'd otherwise be invisible here even though they already count toward the
    // day's total. Show each as its own card.
    for (const m of activeManualCakes) {
      if (m.matched_order_ref && m.matched_order_ref !== '__pending_create__') continue;
      byRef.set(`__manual__${m.id}`, {
        id: `__manual__${m.id}`,
        order_ref: lang === 'vi' ? 'Đơn ngoại lệ' : 'Exceptional order',
        shop_name: m.shop_name ?? '',
        isManual: true,
        items: [{
          product_name_vi: m.product_name_vi, variant_label: 'Standard', qty: m.qty, sku: m.product_sku ?? null,
          message: m.message ?? null, notes: m.notes ?? null, designNotes: m.design_notes ?? null, designPhotoUrl: m.design_photo_url ?? null,
        }],
      });
    }
    setHistoryDetails(prev => ({ ...prev, [delivery_date]: Array.from(byRef.values()) }));
    // Resolve the real SKU via lab_fiche_variants — needed because "Send to stock" from this
    // history tab feeds submitStockTransferAction the same as the live tab, and a null sku here
    // means the Odoo sync can never match the product (silent gap — see 2026-08-05 Charlotte
    // Watermint D14 investigation, 446 vs 447 units).
    const variantIds = Array.from(new Set((prod ?? []).map((a: any) => a.variant_id).filter(Boolean)));
    const { data: variantRows } = variantIds.length
      ? await supabase.from('lab_fiche_variants').select('id, sku').in('id', variantIds)
      : { data: [] as any[] };
    const skuByVariantId: Record<string, string | null> = {};
    for (const v of variantRows ?? []) skuByVariantId[v.id] = v.sku ?? null;
    // Skip = servi depuis le stock : montré dans son propre bloc, jamais dans la logique
    // d'envoi en stock (rien n'a été produit, il n'y a rien à envoyer).
    const inStockAgg = new Map<string, { name: string; variant: string; qty: number }>();
    for (const a of (prod ?? []).filter(x => x.status === 'skip' && !x.cancelled)) {
      const key = `${a.product_name_vi}||${a.variant_label ?? 'Standard'}`;
      const g = inStockAgg.get(key) ?? { name: a.product_name_vi, variant: a.variant_label ?? 'Standard', qty: 0 };
      g.qty += a.qty_to_produce ?? 0;
      inStockAgg.set(key, g);
    }
    setHistoryInStock(prev => ({ ...prev, [delivery_date]: Array.from(inStockAgg.values()).sort((x, y) => x.name.localeCompare(y.name)) }));
    const rows: HistoryProdRow[] = (prod ?? []).filter(a => !a.cancelled && a.status === 'done').map(a => ({
      id: a.id, product_name_vi: a.product_name_vi, product_name_en: a.product_name_en ?? '',
      sku: (a.variant_id && skuByVariantId[a.variant_id]) ?? null,
      variant_label: a.variant_label ?? 'Standard', image_url: a.image_url ?? null,
      qty_produced: a.qty_produced ?? 0, total_qty: a.total_qty ?? 0, qty_sent_total: a.qty_sent_total ?? 0,
      is_extra: !!a.is_extra, delivery_date,
    }));
    setHistoryProduction(prev => ({ ...prev, [delivery_date]: rows }));
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
    if (next === 'done') {
      update.qty_produced = a.qty_to_produce; update.produced_ahead = isAhead;
      update.produced_by = userId; update.produced_by_name = userName; update.produced_at = new Date().toISOString();
      // Re-derive `transferred` from the actual sent-vs-produced invariant instead of leaving
      // a stale value. A card reopened by the same-day merge (fix/card-fragmentation-and-
      // sync-lock) keeps whatever `transferred`/`qty_sent_total` it had from BEFORE more demand
      // was merged in — if that was already true (fully sent at the smaller old total), it must
      // become false again now that qty_produced just jumped to the new, bigger target, or the
      // freshly produced remainder becomes permanently invisible to "Send to stock".
      update.transferred = (a.qty_sent_total ?? 0) >= a.qty_to_produce;
    }
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
    // blocked_at/blocked_by_name (lab_v46, 2026-08-20): traceability for the Analytics "blocked
    // reasons" list, so a reason can be traced back to the actual card instead of just a count.
    // Deliberately never cleared on unblock (see lab_v46_check_and_blocked_tracking.sql comment).
    const update = { status: 'blocked' as AssignmentStatus, blocked_reason: reason, blocked_at: new Date().toISOString(), blocked_by_name: userName, updated_at: new Date().toISOString() };
    await supabase.from('lab_assignments').update(update).eq('id', blockedModal.id);
    setAssignments(prev => prev.map(x => x.id === blockedModal.id ? { ...x, ...update } : x));
    setBlockedModal(null);
    setBlockedReason('');
    setBlockedCustom('');
  }

  async function savePartial() {
    if (!qtyModal) return;
    const supabase = createClient();
    // Extra card: the quantity IS the target — editing keeps it done and moves
    // all three quantities together (min 1; to remove the card, delete it instead).
    if (qtyModal.is_extra) {
      const q = Math.max(1, qtyInput);
      const update: any = {
        total_qty: q, qty_to_produce: q, qty_produced: q, updated_at: new Date().toISOString(),
        // Same re-derivation as advanceStatus below — editing an extra card's quantity must
        // not leave a stale `transferred: true` if the new qty now exceeds what was sent.
        transferred: (qtyModal.qty_sent_total ?? 0) >= q,
      };
      await supabase.from('lab_assignments').update(update).eq('id', qtyModal.id);
      setAssignments(prev => prev.map(x => x.id === qtyModal.id ? { ...x, ...update } : x));
      setQtyModal(null);
      return;
    }
    const isDone = qtyInput >= qtyModal.qty_to_produce;
    const update: any = {
      status: (isDone ? 'done' : 'partial') as AssignmentStatus,
      qty_produced: qtyInput,
      updated_at: new Date().toISOString(),
      produced_ahead: isDone ? isAhead : false,
      // See advanceStatus: keep `transferred` honest whenever qty_produced changes, so a
      // reopened/edited card never hides a freshly-produced remainder from "Send to stock".
      transferred: (qtyModal.qty_sent_total ?? 0) >= qtyInput,
    };
    if (isDone) { update.produced_by = userId; update.produced_by_name = userName; update.produced_at = new Date().toISOString(); }
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
      produced_by: userId,
      produced_by_name: userName,
      produced_at: new Date().toISOString(),
      breakdown: [] as BreakdownItem[],
    };
    const { data } = await supabase.from('lab_assignments').insert(row).select('id').single();
    if (data) {
      setAssignments(prev => [...prev, {
        ...row, id: data.id, notes: '', blocked_reason: null, sku: extraVariant?.sku ?? extraProduct.sku ?? null, weight_grams: extraVariant?.weight_g ?? null, category_name_vi: extraProduct.subcategory ?? null, category_name_en: extraProduct.subcategory ?? null,
        lab_imports: prev[0]?.lab_imports ?? { delivery_date: today, order_number: 1, type: 'daily', status: 'published' },
      }]);
    }
    closeExtraModal();
    setSavingExtra(false);
  }

  async function deleteExtra() {
    if (!deleteModal) return;
    setDeleting(true);
    setDeleteError(false);
    const supabase = createClient();
    // is_extra + transferred guards repeated client-side; RLS (v21) enforces them server-side.
    // .select() confirms a row was actually removed — RLS silently deletes 0 rows otherwise,
    // and we must NOT hide the card locally while it still exists in the DB.
    const { data, error } = await supabase.from('lab_assignments')
      .delete().eq('id', deleteModal.id).eq('is_extra', true).eq('transferred', false)
      .select('id');
    if (!error && (data?.length ?? 0) > 0) {
      const gone = deleteModal.id;
      setTodayAssignments(prev => prev.filter(x => x.id !== gone));
      setTomorrowAsg(prev => prev.filter(x => x.id !== gone));
      setDeleteModal(null);
    } else {
      setDeleteError(true);
    }
    setDeleting(false);
  }

  function closeExtraModal() {
    setExtraModal(false);
    setExtraSearch('');
    setExtraResults([]);
    setExtraProduct(null);
    setExtraVariant(null);
    setExtraQty(1);
    setExtraQtyInput('1');
    setExtraWeightKg('');
    setSelectedCategory('');
  }

  // Chefs send stock BY PRODUCT, not per order card. Several production cards for the same
  // product (one per order lot) are merged into a single line whose quantity is the total
  // produced. On submit the chosen total is split back across the underlying cards.
  type StockGroup = {
    key: string; name_vi: string; name_en: string; sku: string | null; variant_label: string;
    image_url: string | null; produced: number; remaining: number;
    parts: { id: string; remaining: number; deliveryDate: string | null }[];
  };
  // "remaining" = what's left to send for a card, i.e. qty_produced minus whatever was already
  // sent in previous (possibly partial) transfers — NOT just qty_produced. A card only counts as
  // fully transferred once nothing remains; a partial send must leave the rest sendable later.
  function groupSendable(list: typeof assignments): StockGroup[] {
    const m = new Map<string, StockGroup>();
    for (const a of list) {
      const key = `${a.sku ?? ''}||${a.variant_label ?? 'Standard'}||${a.product_name_vi}`;
      const prod = a.qty_produced || a.total_qty || 0;
      const rem = Math.max(0, prod - (a.qty_sent_total || 0));
      if (rem <= 0) continue;
      const g = m.get(key) ?? {
        key, name_vi: a.product_name_vi, name_en: a.product_name_en ?? '', sku: a.sku ?? null,
        variant_label: a.variant_label ?? 'Standard', image_url: a.image_url ?? null, produced: 0, remaining: 0, parts: [],
      };
      g.produced += prod;
      g.remaining += rem;
      g.parts.push({ id: a.id, remaining: rem, deliveryDate: a.lab_imports?.delivery_date ?? null });
      m.set(key, g);
    }
    return Array.from(m.values());
  }

  // Open the "send to stock" bon: preselect every finished product with something left to send
  function openStockModal() {
    const sel: Record<string, { on: boolean; qty: string }> = {};
    const sendable = assignments.filter(a => a.status === 'done' && !a.cancelled && !a.transferred);
    for (const g of groupSendable(sendable)) sel[g.key] = { on: true, qty: String(g.remaining) };
    setStockSel(sel);
    setStockModal(true);
  }

  async function submitStockTransfer() {
    const sendable = assignments.filter(a => a.status === 'done' && !a.cancelled && !a.transferred);
    const groups = groupSendable(sendable);
    // Split each group's chosen total across its cards (fill each card up to what it has LEFT to send)
    const entries: any[] = [];
    const touchedIds = new Set<string>();
    for (const g of groups) {
      const s = stockSel[g.key];
      if (!s?.on) continue;
      let remaining = Math.min(Number(s.qty) || 0, g.remaining);
      if (remaining <= 0) continue;
      for (const p of g.parts) {
        if (remaining <= 0) break;
        const take = Math.min(p.remaining, remaining);
        if (take <= 0) continue;
        entries.push({
          assignmentId: p.id, productNameVi: g.name_vi, productNameEn: g.name_en,
          sku: g.sku, variantLabel: g.variant_label, imageUrl: g.image_url,
          deliveryDate: p.deliveryDate, qtySent: take,
        });
        touchedIds.add(p.id);
        remaining -= take;
      }
    }
    if (!entries.length) return;
    setSendingStock(true);
    const { submitStockTransferAction } = await import('./stock-actions');
    const res = await submitStockTransferAction(team, entries);
    if (res.ok) {
      // Mirror the server logic locally: a card is fully "transferred" only once its cumulative
      // sent total reaches what it produced. A partial send bumps qty_sent_total but leaves the
      // card sendable (remaining > 0) so the leftover is never stranded.
      const sentThisSubmit = new Map(entries.map(e => [e.assignmentId as string, e.qtySent as number]));
      setAssignments(prev => prev.map(x => {
        const justSent = sentThisSubmit.get(x.id);
        if (justSent == null) return x;
        const newTotal = (x.qty_sent_total || 0) + justSent;
        const prod = x.qty_produced || x.total_qty || 0;
        return { ...x, qty_sent_total: newTotal, transferred: newTotal >= prod };
      }));
      setStockModal(false);
    }
    setSendingStock(false);
  }

  // Same "send to stock" action as above, applied to a past day in the history tab instead of
  // today's live assignments. Always sends the FULL remaining quantity of every selected group
  // (no partial-qty editing here — keeps the history UI to a checkbox, not a form).
  function toggleHistorySel(date: string, key: string, allKeys: string[]) {
    setHistorySel(prev => {
      const current = prev[date] ?? new Set(allKeys);
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return { ...prev, [date]: next };
    });
  }

  async function sendHistoryStock(date: string, unsent: HistoryProdGroup[]) {
    const sel = historySel[date] ?? new Set(unsent.map(g => g.key));
    const chosen = unsent.filter(g => sel.has(g.key));
    const entries = chosen.flatMap(g => g.parts.map(p => ({
      assignmentId: p.id, productNameVi: g.name, productNameEn: g.name_en,
      sku: g.sku, variantLabel: g.variant, imageUrl: g.image_url,
      deliveryDate: p.deliveryDate, qtySent: p.qty,
    })));
    if (!entries.length) return;
    setSendingHistoryStock(date);
    const { submitStockTransferAction } = await import('./stock-actions');
    const res = await submitStockTransferAction(team, entries);
    if (res.ok) {
      const sentIds = new Set(entries.map(e => e.assignmentId));
      const updatedRows = (historyProduction[date] ?? []).map(r =>
        sentIds.has(r.id) ? { ...r, qty_sent_total: r.qty_produced || r.total_qty } : r);
      setHistoryProduction(prev => ({ ...prev, [date]: updatedRows }));
      setHistorySel(prev => ({ ...prev, [date]: new Set() }));
      const stillUnsent = groupHistoryProd(updatedRows).unsent.length;
      setHistoryData(prev => prev.map(d => d.delivery_date === date ? { ...d, unsentCount: stillUnsent } : d));
    }
    setSendingHistoryStock(null);
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

  // ── Per-order grouping (point 2) ── groups the day's order cards by Odoo ref so a
  // chef can follow one order — especially a same-day supplementary order (đơn bổ sung)
  // — instead of hunting through per-product cards. Regular cards link to orders via
  // their breakdown entries; matched manual cakes via bc_order_ref.
  type OrderGroupItem = { a: Assignment; qty: number; note: string | null };
  type OrderGroup = { ref: string; shop: string; time: string | null; boSung: boolean; items: OrderGroupItem[] };
  const orderGroups: OrderGroup[] = (() => {
    // Bổ sung = the card's import was created ON the delivery day itself (lab time);
    // normal orders are imported before their delivery day starts.
    const labDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
    const m = new Map<string, OrderGroup>();
    const add = (ref: string, shop: string, time: string | null, boSung: boolean, item: OrderGroupItem) => {
      const g = m.get(ref) ?? { ref, shop, time: null, boSung: false, items: [] };
      g.items.push(item);
      if (time && (!g.time || time < g.time)) g.time = time;
      if (boSung) g.boSung = true;
      m.set(ref, g);
    };
    for (const a of orderCards) {
      const boSung = !!a.lab_imports?.imported_at
        && labDay.format(new Date(a.lab_imports.imported_at)) === a.lab_imports.delivery_date;
      const bds = (Array.isArray(a.breakdown) ? a.breakdown : []).filter(b => b.order_ref);
      for (const b of bds) add(b.order_ref!, b.shop_name, b.delivery_time?.slice(0, 5) ?? null, boSung, { a, qty: b.qty, note: b.note ?? null });
      if (!bds.length && a.bc_order_ref && a.bc_order_ref !== '__pending_create__') {
        add(a.bc_order_ref, a.bc_shop_name || '', a.bc_ready_time?.slice(0, 5) ?? null, boSung, { a, qty: a.qty_to_produce, note: a.bc_notes ?? null });
      }
    }
    return Array.from(m.values()).sort((x, y) =>
      x.boSung !== y.boSung ? (x.boSung ? -1 : 1)
        : (x.time ?? '99:99') !== (y.time ?? '99:99') ? (x.time ?? '99:99').localeCompare(y.time ?? '99:99')
          : x.ref.localeCompare(y.ref));
  })();
  const groupDone = (g: OrderGroup) =>
    g.items.filter(it => it.a.status === 'done' || it.a.status === 'skip').length;

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


  // Tab-title alert — at least one Lab stock line (any category) below its safety threshold,
  // same "low" condition as the red highlight on the stock card row further down (Axel,
  // 2026-08-21 rule; extended 2026-09-04 to also surface as a dot on the tab title itself, so a
  // chef sees it without having to open the Analytics tab first).
  const lowStockAlert = (analyticsData?.stock ?? []).some(g => g.items.some(i => i.found && i.threshold != null && i.qty < i.threshold));

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
    {
      id: 'analytics',
      labelVi: 'Phân tích',
      labelEn: 'Analytics',
      count: 0,
      icon: <TrendingUp size={14} />,
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
    onOpenDesignPhoto: (url: string) => setDesignPhotoModal(url),
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
            <button onClick={handleSyncOdoo} disabled={syncState === 'syncing' || syncCooldown}
              title={lang === 'vi' ? 'Đồng bộ Odoo ngay' : 'Sync Odoo now'}
              className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center transition-colors active:scale-95 disabled:opacity-40"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: syncState === 'ok' ? '#7CD98C' : syncState === 'error' ? '#F0A0A0' : 'rgba(255,255,255,0.8)' }}>
              {syncState === 'ok'
                ? <CheckCircle2 size={14} />
                : syncState === 'error'
                  ? <AlertCircle size={14} />
                  : <RefreshCw size={14} className={syncState === 'syncing' ? 'animate-spin' : ''} />}
            </button>
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
                {tab.id === 'analytics' && lowStockAlert && (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: '#EF4444', boxShadow: '0 0 0 2px rgba(239,68,68,0.35)' }}
                    title={lang === 'vi' ? 'Có sản phẩm dưới ngưỡng an toàn' : 'Stock below safety threshold'} />
                )}
              </span>
            </button>
          ))}
        </div>
      </header>

      {/* Reminder: anything produced (today OR ahead-of-tomorrow) that still needs to go to
          stock. Combines BOTH lists regardless of which Today/Tomorrow sub-tab is active — an
          ahead-produced item sitting in "Tomorrow" was made today and needs sending today too,
          not just whenever the chef happens to check that tab. */}
      {!isEmployee && !isHistoryView && (() => {
        const remaining = (a: Assignment) => {
          const prod = a.qty_produced || a.total_qty || 0;
          return Math.max(0, prod - (a.qty_sent_total || 0));
        };
        const unsentToday = todayAssignments.filter(a => !a.cancelled && a.status === 'done' && remaining(a) > 0);
        const unsentTomorrow = tomorrowAsg.filter(a => !a.cancelled && a.status === 'done' && remaining(a) > 0);
        const qtyToday = unsentToday.reduce((s, a) => s + remaining(a), 0);
        const qtyTomorrow = unsentTomorrow.reduce((s, a) => s + remaining(a), 0);
        const totalQty = qtyToday + qtyTomorrow;
        const totalCards = unsentToday.length + unsentTomorrow.length;
        if (totalQty <= 0) return null;
        return (
          <div className="max-w-3xl mx-auto px-4 pt-3">
            <button
              onClick={() => { setActiveTab('termine'); setOrderFilter(null); setProdDay(qtyToday > 0 ? 'today' : 'tomorrow'); }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors"
              style={{ backgroundColor: '#FFFBEB', border: '1px solid #FCD34D' }}>
              <Package size={18} className="shrink-0" style={{ color: '#B45309' }} />
              <span className="text-sm flex-1 min-w-0" style={{ color: '#92600A' }}>
                <span className="font-bold">{totalQty}</span>{' '}
                {lang === 'vi'
                  ? `sản phẩm (${totalCards} thẻ) đã làm xong, cần chuyển vào kho`
                  : `produit${totalQty > 1 ? 's' : ''} (${totalCards} carte${totalCards > 1 ? 's' : ''}) prêt${totalQty > 1 ? 's' : ''} à envoyer au stock`}
                {qtyTomorrow > 0 && (
                  <span className="block text-xs mt-0.5 opacity-90">
                    {lang === 'vi'
                      ? `Trong đó ${qtyTomorrow} làm trước cho ngày mai — vẫn cần chuyển kho hôm nay`
                      : `Dont ${qtyTomorrow} fait en avance pour demain — à envoyer au stock dès aujourd'hui`}
                  </span>
                )}
              </span>
              <ChevronRight size={16} className="shrink-0" style={{ color: '#B45309' }} />
            </button>
          </div>
        );
      })()}

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
                <button key={d} onClick={() => { setProdDay(d); setOrderFilter(null); }}
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
      {activeTab === 'production' && (() => {
        // Order filter (point 2): narrow this tab's lists to one order's cards. The
        // lists are re-derived (not renamed) so everything below stays untouched.
        const matchesOrder = (a: Assignment) => !orderFilter
          || (Array.isArray(a.breakdown) ? a.breakdown : []).some(b => b.order_ref === orderFilter)
          || a.bc_order_ref === orderFilter;
        // With a filter on, quantities shown are the FILTERED ORDER's share of the card,
        // not the card total: a card can merge several orders' demand (e.g. ×18 = 12+6
        // across two REPs), and showing the card total against one order overstates it —
        // the same class of bug as the History-tab totals (2026-09-01). Manual cakes
        // (empty breakdown, matched via bc_order_ref) belong to one order: card qty is
        // already that order's qty.
        const qtyForFilter = (a: Assignment) => {
          if (!orderFilter) return a.qty_to_produce;
          const share = (Array.isArray(a.breakdown) ? a.breakdown : [])
            .filter(b => b.order_ref === orderFilter)
            .reduce((s, b) => s + (Number(b.qty) || 0), 0);
          return share > 0 ? share : a.qty_to_produce;
        };
        const production = assignments.filter(a => !a.cancelled && ['pending', 'in_progress', 'partial', 'blocked'].includes(a.status)).filter(matchesOrder);
        const inStock = assignments.filter(a => !a.cancelled && a.status === 'skip').filter(matchesOrder);
        const cancelledCards = assignments.filter(a => a.cancelled).filter(matchesOrder);
        return (
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-3 pb-28">
          {/* Order-filter chips (point 2) — pick one order to see only its cards */}
          {orderGroups.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
              <button onClick={() => setOrderFilter(null)}
                className="shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap active:scale-95 transition-all"
                style={!orderFilter
                  ? { backgroundColor: '#1A4731', color: 'white', border: '1px solid #1A4731' }
                  : { backgroundColor: 'white', border: '1px solid #E0D49A', color: '#1A4731' }}>
                {lang === 'vi' ? 'Tất cả' : 'All'}
              </button>
              {orderGroups.map(g => {
                const active = orderFilter === g.ref;
                const n = g.items.filter(it => !it.a.cancelled && ['pending', 'in_progress', 'partial', 'blocked'].includes(it.a.status)).length;
                return (
                  <button key={g.ref} onClick={() => setOrderFilter(active ? null : g.ref)}
                    className="shrink-0 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap active:scale-95 transition-all"
                    style={active
                      ? { backgroundColor: '#1A4731', color: 'white', border: '1px solid #1A4731' }
                      : g.boSung
                        ? { backgroundColor: '#FFF4CC', border: '1px solid #C9A84C', color: '#92600A' }
                        : { backgroundColor: 'white', border: '1px solid #E0D49A', color: '#1A4731' }}>
                    {g.boSung && '⚡ '}{g.ref}
                    <span style={{ opacity: 0.75, fontWeight: 600 }}> · {g.shop}</span>
                    {n > 0 && <span style={{ opacity: 0.75 }}> · {n}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {orderFilter && (
            <div className="rounded-xl px-4 py-2 flex items-center justify-between text-sm font-semibold"
              style={{ backgroundColor: '#FFF4CC', color: '#92600A', border: '1px solid #C9A84C' }}>
              <span>🔎 {lang === 'vi' ? 'Đang lọc theo' : 'Filtering by'} <span className="font-mono font-bold">{orderFilter}</span></span>
              <button onClick={() => setOrderFilter(null)} className="font-bold underline shrink-0">
                ✕ {lang === 'vi' ? 'Bỏ lọc' : 'Clear'}
              </button>
            </div>
          )}
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
              e.qty += qtyForFilter(a);
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
                    {/* Category subtotal (Axel, 2026-08-27) — this header used to show only the
                        category name with no rolled-up quantity for it. */}
                    {cats.flatMap(cat => [
                      <div key={`c-${cat}`} className="col-span-2 px-3 py-1 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between"
                        style={{ backgroundColor: '#FBF6E3', color: '#92600A', borderTop: '1px solid #F0EAD0' }}>
                        <span>{cat}</span>
                        <span>×{items.filter(r => r.cat === cat).reduce((s, r) => s + r.qty, 0)}</span>
                      </div>,
                      ...items.filter(r => r.cat === cat).map((r, i) => (
                        <div key={r.sku ?? r.name} className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
                          style={{ borderTop: '1px solid #F0EAD0', borderRight: i % 2 === 0 ? '1px solid #F0EAD0' : undefined }}>
                          {/* SKU on its own line, not appended after the name (2026-08-12: chefs
                              reported long names getting cut — a name sharing one truncated line
                              with its SKU had even less room to breathe). */}
                          <div className="flex-1 min-w-0">
                            <div className="overflow-x-auto whitespace-nowrap no-scrollbar" style={{ color: '#1A4731', WebkitOverflowScrolling: 'touch' }}>{r.name}</div>
                            {r.sku && <div className="text-[9px] font-mono text-ink-light truncate">{r.sku}</div>}
                          </div>
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
              return production.map(a => (
                <div key={a.id}>
                  {orderFilter && qtyForFilter(a) < a.qty_to_produce && (
                    <div className="rounded-t-xl px-3 py-1.5 text-[11px] font-bold"
                      style={{ backgroundColor: '#FFF4CC', color: '#92600A', border: '1px solid #C9A84C', borderBottom: 'none' }}>
                      ↳ ×{qtyForFilter(a)} {lang === 'vi' ? 'cho đơn này' : 'for this order'} · {lang === 'vi' ? 'thẻ gộp nhiều đơn, tổng' : 'multi-order card, total'} ×{a.qty_to_produce}
                    </div>
                  )}
                  <ProductionCard a={a} {...sharedCardProps} />
                </div>
              ));
            }
            return (
              <>
                {/* Category quick-jump chips */}
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 sticky top-[102px] sm:top-[118px] z-10 py-2"
                  style={{ backgroundColor: '#FDF8E7' }}>
                  {entries.map(([cat, items]) => {
                    const qty = items.reduce((s, a) => s + qtyForFilter(a), 0);
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
                        {items.length} {lang === 'vi' ? 'sản phẩm' : 'products'} · {items.reduce((s, a) => s + qtyForFilter(a), 0)} {lang === 'vi' ? 'cái' : 'units'}
                      </span>
                      <div className="flex-1 border-t" style={{ borderColor: '#E0D49A' }} />
                    </div>
                    {items.map(a => (
                      <div key={a.id}>
                        {orderFilter && qtyForFilter(a) < a.qty_to_produce && (
                          <div className="rounded-t-xl px-3 py-1.5 text-[11px] font-bold"
                            style={{ backgroundColor: '#FFF4CC', color: '#92600A', border: '1px solid #C9A84C', borderBottom: 'none' }}>
                            ↳ ×{qtyForFilter(a)} {lang === 'vi' ? 'cho đơn này' : 'for this order'} · {lang === 'vi' ? 'thẻ gộp nhiều đơn, tổng' : 'multi-order card, total'} ×{a.qty_to_produce}
                          </div>
                        )}
                        <ProductionCard a={a} {...sharedCardProps} />
                      </div>
                    ))}
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
                        ? <img src={thumb(a.image_url, 96)} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} />
                        : <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>
                          {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                        </div>
                        <div className="text-xs" style={{ color: '#8B5CF6' }}>×{qtyForFilter(a)}</div>
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
        );
      })()}

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
              {/* Point 2 (chef Entremet): switch between per-order and per-product views */}
              <div className="flex rounded-xl overflow-hidden" style={{ border: '1px solid #E0D49A', backgroundColor: 'white' }}>
                {([['don', lang === 'vi' ? '📦 Theo đơn' : '📦 By order'], ['sp', lang === 'vi' ? '🧺 Theo sản phẩm' : '🧺 By product']] as const).map(([v, label]) => (
                  <button key={v} onClick={() => setOrderView(v)}
                    className="flex-1 py-2.5 text-sm font-bold transition-all"
                    style={orderView === v
                      ? { backgroundColor: '#1A4731', color: 'white' }
                      : { backgroundColor: 'white', color: '#1A4731' }}>
                    {label}
                  </button>
                ))}
              </div>

              {orderView === 'don' ? (
                <div className="space-y-3">
                  {orderGroups.length === 0 && (
                    <div className="text-center py-16">
                      <ClipboardList size={40} className="mx-auto mb-3 text-ink-light" />
                      <p className="font-semibold text-ink-light">
                        {lang === 'vi' ? 'Không tìm thấy đơn nào (thiếu mã đơn Odoo)' : 'No order with an Odoo ref found'}
                      </p>
                    </div>
                  )}
                  {orderGroups.map(g => {
                    const done = groupDone(g);
                    const total = g.items.length;
                    const prodCount = g.items.filter(it => ['pending', 'in_progress', 'partial', 'blocked'].includes(it.a.status)).length;
                    return (
                      <div key={g.ref} className="rounded-2xl overflow-hidden bg-white"
                        style={{ border: g.boSung ? '2px solid #C9A84C' : '1px solid #E0D49A' }}>
                        {/* Order header */}
                        <div className="px-4 py-3 flex items-center justify-between gap-2 flex-wrap"
                          style={{ backgroundColor: g.boSung ? '#FFF4CC' : '#F0F9F4' }}>
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <span className="font-mono font-black text-sm" style={{ color: '#92600A' }}>{g.ref}</span>
                            <span className="flex items-center gap-1 text-sm font-bold" style={{ color: '#1A4731' }}>
                              <Store size={12} />{g.shop}
                            </span>
                            {g.boSung && (
                              <span className="text-[10px] font-black rounded-full px-2 py-0.5 animate-pulse"
                                style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
                                ⚡ {lang === 'vi' ? 'BỔ SUNG' : 'SUPPLEMENT'}
                              </span>
                            )}
                            {g.time && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                                style={{ backgroundColor: 'white', color: '#C9A84C', border: '1px solid #E0D49A' }}>
                                ⏰ {g.time}
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-black shrink-0 rounded-full px-2 py-0.5"
                            style={done === total
                              ? { backgroundColor: '#047857', color: 'white' }
                              : { backgroundColor: 'white', color: '#1A4731', border: '1px solid #E0D49A' }}>
                            {done}/{total} {lang === 'vi' ? 'xong' : 'done'}
                          </span>
                        </div>
                        {/* Items of this order */}
                        {g.items.map((it, i) => {
                          const a = it.a;
                          const pill = a.status === 'done' ? { t: lang === 'vi' ? 'Xong' : 'Done', c: '#047857', bg: '#ECFDF5' }
                            : a.status === 'skip' ? { t: lang === 'vi' ? 'Có sẵn' : 'In stock', c: '#6D28D9', bg: '#F5F3FF' }
                              : a.status === 'blocked' ? { t: lang === 'vi' ? 'Chặn' : 'Blocked', c: '#B91C1C', bg: '#FEF2F2' }
                                : (a.status === 'in_progress' || a.status === 'partial') ? { t: lang === 'vi' ? 'Đang làm' : 'In progress', c: '#92600A', bg: '#FFF4CC' }
                                  : { t: lang === 'vi' ? 'Chưa làm' : 'To do', c: '#6B7280', bg: '#F3F4F6' };
                          return (
                            <div key={`${a.id}-${i}`} className="flex items-center gap-3 px-4 py-2.5"
                              style={{ borderTop: '1px solid #F0EAD0' }}>
                              {a.image_url
                                ? <img src={thumb(a.image_url, 96)} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E0D49A' }} />
                                : <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🥐</div>}
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold truncate" style={{ color: '#1A4731' }}>
                                  {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
                                </div>
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {a.sku && <span className="text-[9px] font-mono text-ink-light">{a.sku}</span>}
                                  {it.note && <span className="text-[10px] font-semibold" style={{ color: '#92600A' }}>📝 {it.note}</span>}
                                </div>
                              </div>
                              <span className="text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0" style={{ color: pill.c, backgroundColor: pill.bg }}>{pill.t}</span>
                              <span className="font-black shrink-0" style={{ color: '#1A4731' }}>×{it.qty}</span>
                            </div>
                          );
                        })}
                        {/* Jump to the Production tab filtered on this order */}
                        {prodCount > 0 && (
                          <button onClick={() => { setOrderFilter(g.ref); setActiveTab('production'); }}
                            className="w-full px-4 py-2.5 text-sm font-bold text-left flex items-center justify-between active:scale-[0.99] transition-all"
                            style={{ backgroundColor: '#FBF6E3', color: '#1A4731', borderTop: '1px solid #E0D49A' }}>
                            <span>{lang === 'vi' ? `Xem ${prodCount} thẻ trong Sản xuất` : `View ${prodCount} card(s) in Production`}</span>
                            <ChevronRight size={16} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (<>
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

              {/* Consolidated recap: total ORDERED per SKU (qty_to_produce, same field the row
                  below shows per-card) — same shape as the Production/Terminé tabs' recaps
                  (2026-08-12, chefs asked for the same style here, to consolidate total commandé
                  the way "Total produit" already consolidates total fabriqué). */}
              {(() => {
                const OTHER = lang === 'vi' ? 'Khác' : 'Other';
                const om = new Map<string, { name: string; sku: string | null; cat: string; qty: number }>();
                for (const a of orderList) {
                  const key = a.sku || a.product_name_vi;
                  const cat = (lang === 'vi' ? a.category_name_vi : a.category_name_en) || a.category_name_vi || OTHER;
                  const name = lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi);
                  const e = om.get(key) ?? { name, sku: a.sku ?? null, cat, qty: 0 };
                  e.qty += a.qty_to_produce;
                  om.set(key, e);
                }
                const orderItems = Array.from(om.values());
                const orderTotalUnits = orderItems.reduce((s, r) => s + r.qty, 0);
                const orderCats = Array.from(new Set(orderItems.map(r => r.cat))).sort((x, y) => x === OTHER ? 1 : y === OTHER ? -1 : x.localeCompare(y));
                return (
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
                    <button onClick={() => setShowOrderRecap(v => !v)} className="w-full flex items-center justify-between px-3 py-2.5 text-white" style={{ backgroundColor: '#1A4731' }}>
                      <span className="text-sm font-bold">🧾 {lang === 'vi' ? 'Tổng đặt hàng' : 'Total commandé'}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-bold" style={{ color: '#F0D98A' }}>{orderItems.length} · {orderTotalUnits} {lang === 'vi' ? 'cái' : 'u.'}</span>
                        <ChevronRight size={16} className={`transition-transform ${showOrderRecap ? 'rotate-90' : ''}`} />
                      </span>
                    </button>
                    {showOrderRecap && (
                      <div className="grid grid-cols-2 bg-white">
                        {/* Category subtotal (Axel, 2026-08-27) — same fix as the Production tab. */}
                        {orderCats.flatMap(cat => [
                          <div key={`oc-${cat}`} className="col-span-2 px-3 py-1 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between"
                            style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderTop: '1px solid #E0D49A' }}>
                            <span>{cat}</span>
                            <span>×{orderItems.filter(r => r.cat === cat).reduce((s, r) => s + r.qty, 0)}</span>
                          </div>,
                          ...orderItems.filter(r => r.cat === cat).map((r, i) => (
                            <div key={r.sku ?? r.name} className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
                              style={{ borderTop: '1px solid #F0EAD0', borderRight: i % 2 === 0 ? '1px solid #F0EAD0' : undefined }}>
                              <div className="flex-1 min-w-0">
                                <div className="overflow-x-auto whitespace-nowrap no-scrollbar" style={{ color: '#1A4731', WebkitOverflowScrolling: 'touch' }}>{r.name}</div>
                                {r.sku && <div className="text-[9px] font-mono text-ink-light truncate">{r.sku}</div>}
                              </div>
                              <span className="font-black shrink-0" style={{ color: '#2D6A4F' }}>×{r.qty}</span>
                            </div>
                          )),
                        ])}
                      </div>
                    )}
                  </div>
                );
              })()}

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
                          <img src={thumb(a.image_url, 112)} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
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
                            <div key={bi} className="px-5 py-1.5 text-sm"
                              style={{ backgroundColor: bi % 2 === 0 ? '#FFFDF0' : '#FFFAEE' }}>
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-ink-light">
                                  <Store size={11} className="shrink-0" />
                                  <span>{b.shop_name}</span>
                                  {b.order_ref && <span className="text-[10px] font-mono">{b.order_ref}</span>}
                                  {b.delivery_time && (
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                                      style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                                      ⏰ {b.delivery_time.slice(0, 5)}
                                    </span>
                                  )}
                                </div>
                                <span className="font-bold text-sm" style={{ color: '#1A4731' }}>x{b.qty}</span>
                              </div>
                              {b.changed_at && (
                                <div className="text-[10px] font-semibold mt-0.5" style={{ color: '#92600A' }}>
                                  🔄 {lang === 'vi' ? 'Odoo sửa' : 'Modifié'} {b.changed_at} ({(b.changed_delta ?? 0) > 0 ? '+' : ''}{b.changed_delta})
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Manual/exceptional cake — breakdown is always [] for these (see page.tsx),
                          so without this fallback the shop/order info is invisible on this tab too
                          (2026-08-25, Axel: reported after the Production-tab fix alone). */}
                      {breakdown.length === 0 && (a.bc_shop_name || a.bc_message || a.bc_notes) && (
                        <div className="pb-3">
                          <div className="px-5 py-1.5 text-sm space-y-1">
                            {a.bc_shop_name && (
                              <div className="flex items-center gap-2 text-ink-light">
                                <Store size={11} className="shrink-0" />
                                <span>{a.bc_shop_name}</span>
                                {a.bc_order_ref && <span className="text-[10px] font-mono">{a.bc_order_ref}</span>}
                              </div>
                            )}
                            {/* Message ("chữ trên bánh") + generic note — same fields the
                                Production tab shows, added here 2026-08-27 (staff reported these
                                never appeared on this tab at all, for any category). */}
                            {a.bc_message && (
                              <div className="font-semibold" style={{ color: '#92600A' }}>🎂 {a.bc_message}</div>
                            )}
                            {a.bc_notes && (
                              <div className="font-semibold" style={{ color: '#92600A' }}>📝 {a.bc_notes}</div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              </>)}
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
            // Consolidated recap: total ACTUALLY produced per SKU (qty_produced), across
            // every done card of the day (order + extra together) — same shape as the
            // Production tab's recap, so the two tables are directly comparable at a glance.
            const doneProduced = termine.filter(a => a.status !== 'skip');
            const OTHER = lang === 'vi' ? 'Khác' : 'Other';
            const dm = new Map<string, { name: string; sku: string | null; cat: string; qty: number }>();
            for (const a of doneProduced) {
              const key = a.sku || a.product_name_vi;
              const cat = (lang === 'vi' ? a.category_name_vi : a.category_name_en) || a.category_name_vi || OTHER;
              const name = lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi);
              const e = dm.get(key) ?? { name, sku: a.sku ?? null, cat, qty: 0 };
              e.qty += a.qty_produced ?? 0;
              dm.set(key, e);
            }
            const doneItems = Array.from(dm.values());
            const doneTotalUnits = doneItems.reduce((s, r) => s + r.qty, 0);
            const doneCats = Array.from(new Set(doneItems.map(r => r.cat))).sort((x, y) => x === OTHER ? 1 : y === OTHER ? -1 : x.localeCompare(y));
            return (
              <>
                {doneItems.length > 0 && (
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
                    <button onClick={() => setShowDoneRecap(v => !v)} className="w-full flex items-center justify-between px-3 py-2.5 text-white" style={{ backgroundColor: '#2D6A4F' }}>
                      <span className="text-sm font-bold">✅ {lang === 'vi' ? 'Tổng đã làm' : 'Total produit'}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs font-bold" style={{ color: '#F0D98A' }}>{doneItems.length} · {doneTotalUnits} {lang === 'vi' ? 'cái' : 'u.'}</span>
                        <ChevronRight size={16} className={`transition-transform ${showDoneRecap ? 'rotate-90' : ''}`} />
                      </span>
                    </button>
                    {showDoneRecap && (
                      <div className="grid grid-cols-2 bg-white">
                        {/* Category subtotal (Axel, 2026-08-27) — same fix as the other two tabs. */}
                        {doneCats.flatMap(cat => [
                          <div key={`dc-${cat}`} className="col-span-2 px-3 py-1 text-[10px] font-bold uppercase tracking-wider flex items-center justify-between"
                            style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderTop: '1px solid #E0D49A' }}>
                            <span>{cat}</span>
                            <span>×{doneItems.filter(r => r.cat === cat).reduce((s, r) => s + r.qty, 0)}</span>
                          </div>,
                          ...doneItems.filter(r => r.cat === cat).map((r, i) => (
                            <div key={r.sku ?? r.name} className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
                              style={{ borderTop: '1px solid #F0EAD0', borderRight: i % 2 === 0 ? '1px solid #F0EAD0' : undefined }}>
                              {/* SKU on its own line — see the Production tab recap above for why. */}
                              <div className="flex-1 min-w-0">
                                <div className="overflow-x-auto whitespace-nowrap no-scrollbar" style={{ color: '#1A4731', WebkitOverflowScrolling: 'touch' }}>{r.name}</div>
                                {r.sku && <div className="text-[9px] font-mono text-ink-light truncate">{r.sku}</div>}
                              </div>
                              <span className="font-black shrink-0" style={{ color: '#2D6A4F' }}>×{r.qty}</span>
                            </div>
                          )),
                        ])}
                      </div>
                    )}
                  </div>
                )}
              </>
            );
          })()}
          {termine.length > 0 && (() => {
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
                  <TermineCard key={a.id} a={a} lang={lang} meta={meta} onAdvance={advanceStatus} updating={updating}
                    readOnly={isEmployee || isHistoryView}
                    onEdit={x => { setQtyInput(x.qty_produced); setQtyModal(x); }}
                    onDelete={x => setDeleteModal(x)} />
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
                      const totals = new Map<string, { name: string; qty: number }>();
                      for (const order of details) {
                        for (const item of order.items) {
                          const displayName = `${item.product_name_vi}${item.variant_label && item.variant_label !== 'Standard' ? ` · ${item.variant_label}` : ''}`;
                          const key = item.sku || displayName;
                          const cur = totals.get(key);
                          if (cur) cur.qty += item.qty;
                          else totals.set(key, { name: displayName, qty: item.qty });
                        }
                      }
                      const rows = Array.from(totals.entries()).sort((a, b) => b[1].qty - a[1].qty);
                      return (
                        <div className="rounded-xl p-3 mt-2" style={{ backgroundColor: '#F0F9F4', border: '1px solid #A7D4B8' }}>
                          <div className="text-xs font-bold mb-1.5" style={{ color: '#1A4731' }}>
                            {lang === 'vi' ? 'Tổng cần sản xuất' : 'Total to produce'}
                          </div>
                          <div className="space-y-0.5">
                            {rows.map(([key, v]) => (
                          <div key={key} className="flex items-center justify-between text-xs">
                          <span style={{ color: '#374151' }}>{v.name}</span>
                          <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{v.qty}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {(details ?? []).map(order => (
                      <div key={order.id} className="rounded-xl p-3 mt-2"
                        style={{ backgroundColor: '#FEFCE8', border: '1px solid #F0E8B0' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold" style={{ color: '#92600A' }}>{order.order_ref}</span>
                          <span className="text-xs font-medium" style={{ color: '#1A4731' }}>{order.shop_name}</span>
                        </div>
                        <div className="space-y-1.5">
                          {order.items.map((item, i) => (
                            <div key={i}>
                              <div className="flex items-center justify-between text-xs">
                                <span style={{ color: '#374151' }}>
                                  {item.product_name_vi}
                                  {item.variant_label ? <span className="ml-1 text-gray-400">· {item.variant_label}</span> : null}
                                </span>
                                <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{item.qty}</span>
                              </div>
                              {item.message && (
                                <div className="text-[11px] mt-0.5" style={{ color: '#92600A' }}>🎂 {item.message}</div>
                              )}
                              {item.notes && (
                                <div className="text-[11px] mt-0.5" style={{ color: '#92600A' }}>📝 {item.notes}</div>
                              )}
                              {(item.designNotes || item.designPhotoUrl) && (
                                <div className="text-[11px] font-medium rounded-lg px-2 py-1 mt-1 flex items-start gap-1.5"
                                  style={{ backgroundColor: '#F5F3FF', color: '#6D28D9' }}>
                                  {item.designPhotoUrl && (
                                    <button type="button" onClick={() => setDesignPhotoModal(item.designPhotoUrl!)}
                                      className="shrink-0" title={lang === 'vi' ? 'Xem ảnh mẫu' : 'Voir la photo'}>
                                      <img src={thumb(item.designPhotoUrl, 80)} alt="" className="w-8 h-8 rounded-md object-cover" />
                                    </button>
                                  )}
                                  {item.designNotes && <span>🎨 {item.designNotes}</span>}
                                </div>
                              )}
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
            const prodRows = historyProduction[d.delivery_date];
            const { sent, unsent } = prodRows ? groupHistoryProd(prodRows) : { sent: [], unsent: [] };
            const sel = historySel[d.delivery_date] ?? new Set(unsent.map(g => g.key));
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
                      {pct === 100 ? '✓ ' : ''}{pct}% · {d.productCount} {lang === 'vi' ? 'sản phẩm' : 'products'} · {d.totalQty} {lang === 'vi' ? 'cái' : 'units'}
                      {d.stockQty > 0 && (
                        <span className="font-normal" style={{ color: '#6D28D9' }}>
                          {' '}({d.totalQty - d.stockQty} {lang === 'vi' ? 'làm' : 'produits'} + {d.stockQty} {lang === 'vi' ? 'từ kho' : 'du stock'})
                        </span>
                      )}
                    </div>
                    {d.unsentCount > 0 && (
                      <div className="inline-flex items-center gap-1 mt-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold"
                        style={{ backgroundColor: '#FCEBEB', color: '#791F1F' }}>
                        <AlertCircle size={10} />
                        {d.unsentCount} {lang === 'vi' ? 'sản phẩm chưa gửi kho' : 'not sent to stock'}
                      </div>
                    )}
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
                    {/* Production only (no order/commande view here — see the Upcoming tab for that) */}
                    {details && sent.length === 0 && unsent.length === 0 && (historyInStock[d.delivery_date] ?? []).length === 0 && (
                      <p className="text-center text-xs py-3 text-gray-400">
                        {lang === 'vi' ? 'Không có sản xuất' : 'Aucune production'}
                      </p>
                    )}
                    {/* Sent to stock — compact aggregated list, no individual cards */}
                    {sent.length > 0 && (
                      <div className="rounded-xl p-3 mt-2" style={{ backgroundColor: '#F0F9F4', border: '1px solid #C6E6D3' }}>
                        <div className="space-y-0.5">
                          {sent.map(g => (
                            <div key={g.key} className="flex items-center justify-between text-xs">
                              <span style={{ color: '#374151' }}>
                                {g.name}
                                {g.variant && g.variant !== 'Standard' ? <span className="ml-1 text-gray-400">· {g.variant}</span> : null}
                                {g.is_extra ? <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded font-bold align-middle" style={{ backgroundColor: '#DBEAFE', color: '#1D4ED8' }}>{lang === 'vi' ? 'Thêm' : 'Extra'}</span> : null}
                              </span>
                              <span className="font-bold ml-3 shrink-0" style={{ color: '#1A4731' }}>×{g.qty}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Servi depuis le stock (cartes skip) — rien n'a été produit pour ces
                        lignes, elles sortent de l'étagère. Les montrer ferme l'écart visuel
                        badge (98) vs liste produite (80) : 80 + 18 = 98 (2026-09-03). */}
                    {(historyInStock[d.delivery_date] ?? []).length > 0 && (
                      <div className="rounded-xl p-3 mt-2" style={{ backgroundColor: '#F5F3FF', border: '1px solid #DDD6FE' }}>
                        <div className="text-[11px] font-bold uppercase tracking-wide mb-1" style={{ color: '#6D28D9' }}>
                          📦 {lang === 'vi' ? 'Lấy từ kho — không cần làm' : 'Servi depuis le stock — pas produit'} · ×{(historyInStock[d.delivery_date] ?? []).reduce((s, g) => s + g.qty, 0)}
                        </div>
                        <div className="space-y-0.5">
                          {(historyInStock[d.delivery_date] ?? []).map(g => (
                            <div key={`${g.name}||${g.variant}`} className="flex items-center justify-between text-xs">
                              <span style={{ color: '#374151' }}>
                                {g.name}
                                {g.variant && g.variant !== 'Standard' ? <span className="ml-1 text-gray-400">· {g.variant}</span> : null}
                              </span>
                              <span className="font-bold ml-3 shrink-0" style={{ color: '#6D28D9' }}>×{g.qty}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Not sent yet — individual, selectable cards + a send-to-stock action */}
                    {unsent.length > 0 && (
                      <>
                        <div className="text-[11px] font-bold uppercase tracking-wide mt-3 mb-1" style={{ color: '#791F1F' }}>
                          {lang === 'vi' ? 'Chưa gửi kho' : 'Not sent to stock'}
                        </div>
                        {unsent.map(g => (
                          <label key={g.key} className="rounded-xl p-3 mb-2 flex items-center gap-2.5 cursor-pointer"
                            style={{ backgroundColor: '#FEFCE8', border: '1px solid #F0E8B0' }}>
                            <input type="checkbox" checked={sel.has(g.key)}
                              onChange={() => toggleHistorySel(d.delivery_date, g.key, unsent.map(u => u.key))}
                              className="w-4 h-4 shrink-0" style={{ accentColor: '#1A4731' }} />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold truncate" style={{ color: '#1A4731' }}>
                                {g.name}{g.variant && g.variant !== 'Standard' ? ` · ${g.variant}` : ''}
                              </div>
                              <div className="text-[11px]" style={{ color: '#92600A' }}>
                                {lang === 'vi' ? `Đã làm ×${g.qty} · còn ×${g.remaining} chưa gửi` : `Made ×${g.qty} · ×${g.remaining} left to send`}
                              </div>
                            </div>
                          </label>
                        ))}
                        <button onClick={() => sendHistoryStock(d.delivery_date, unsent)}
                          disabled={sendingHistoryStock === d.delivery_date || sel.size === 0}
                          className="w-full mt-1 py-2.5 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                          style={{ backgroundColor: '#1A4731', color: '#FFF4CC' }}>
                          <Truck size={14} />
                          {sendingHistoryStock === d.delivery_date
                            ? '…'
                            : `${lang === 'vi' ? 'Gửi vào kho' : 'Send to stock'} (${sel.size})`}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'analytics' && (() => {
        const stats = analyticsData;
        return (
          <div className="max-w-3xl mx-auto px-4 py-5 space-y-4 pb-16">
            {loadingAnalytics && !stats && (
              <div className="space-y-3">
                <SkeletonRow /><SkeletonRow />
              </div>
            )}

            {!loadingAnalytics && stats && (
              <>
                <div className="rounded-2xl bg-white p-4" style={{ border: '1px solid #E0D49A' }}>
                  <div className="font-bold text-xs mb-3" style={{ color: '#1A4731' }}>
                    {lang === 'vi' ? 'Hoàn thành hôm nay (delivery-check)' : "Completion by team (delivery) — today"}
                  </div>
                  <div className="flex items-end justify-between gap-3">
                    <div className="text-3xl font-bold" style={{ color: '#2D6A4F' }}>{stats.completion.rate}%</div>
                    <div className="text-xs text-right" style={{ color: '#6B6455' }}>
                      {stats.completion.checked} / {stats.completion.expected} {lang === 'vi' ? 'đã check' : 'checked'}
                    </div>
                  </div>
                  {stats.completion.products.length > 0 && (
                    <div className="mt-3 pt-3 space-y-1.5 border-t overflow-y-auto" style={{ borderColor: '#F3EFDD', maxHeight: 260 }}>
                      {stats.completion.products.map(p => (
                        <div key={p.sku} className="flex justify-between items-center text-[12px]">
                          <span className="truncate pr-3" style={{ color: '#1A4731' }}>{p.name}</span>
                          <span className="shrink-0" style={{ color: '#6B6455' }}>
                            {p.checked}/{p.expected} ·{' '}
                            <span className="font-bold" style={{ color: p.gap > 0 ? '#B45309' : '#2D6A4F' }}>
                              {p.gap > 0 ? '-' : '+'}{Math.abs(p.gap)}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {stats.stock.length > 0 && (
                  <div className="rounded-2xl bg-white p-4" style={{ border: '1px solid #E0D49A' }}>
                    <div className="mb-3">
                      <div className="font-bold text-xs" style={{ color: '#1A4731' }}>
                        {lang === 'vi' ? 'Tồn kho Lab' : 'Lab stock'}
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: '#6B6455' }}>
                        {lang === 'vi' ? 'Trực tiếp từ Odoo (kho LAB)' : 'Live from Odoo (LAB warehouse)'}
                      </div>
                    </div>
                    <div className="space-y-4">
                      {stats.stock.map(group => (
                        <div key={group.category}>
                          <div className="text-[10px] font-bold uppercase tracking-wide mb-1.5" style={{ color: '#92600A' }}>
                            {group.category}
                          </div>
                          <div className="space-y-1.5">
                            {group.items.map(s => {
                              const low = s.found && s.threshold != null && s.qty < s.threshold;
                              const editing = thresholdEdit === s.sku;
                              return (
                                <div key={s.sku} className="rounded-lg px-2 py-1.5 -mx-2" style={low ? { backgroundColor: '#FEF2F2' } : undefined}>
                                  <div className="flex justify-between items-center text-[13px]">
                                    <span className="truncate pr-3" style={{ color: '#1A4731' }}>{s.name}</span>
                                    <span className="font-bold shrink-0" style={{ color: s.found ? (low ? '#B42318' : '#1A4731') : '#B45309' }}>
                                      {s.found ? s.qty : '—'}
                                    </span>
                                  </div>
                                  <div className="flex justify-between items-center mt-0.5">
                                    {low
                                      ? <span className="text-[10px] font-bold" style={{ color: '#B42318' }}>{lang === 'vi' ? 'Cần sản xuất' : 'Faut produire'}</span>
                                      : <span />}
                                    {editing ? (
                                      <span className="flex items-center gap-1 shrink-0">
                                        <input type="number" value={thresholdDraft} onChange={e => setThresholdDraft(e.target.value)}
                                          autoFocus className="w-14 text-center rounded-lg px-1.5 py-0.5 text-[11px]" style={{ border: '1px solid #D1D5DB' }} />
                                        <button onClick={() => saveThreshold(s.sku)} disabled={savingThreshold === s.sku}
                                          className="text-[10px] font-bold px-2 py-0.5 rounded-full disabled:opacity-50"
                                          style={{ backgroundColor: '#1A4731', color: '#FFF4CC' }}>
                                          OK
                                        </button>
                                      </span>
                                    ) : (
                                      <button onClick={() => { setThresholdEdit(s.sku); setThresholdDraft(s.threshold != null ? String(s.threshold) : ''); }}
                                        className="text-[10px] shrink-0" style={{ color: '#6B6455' }}>
                                        {s.threshold != null
                                          ? `${lang === 'vi' ? 'Ngưỡng' : 'Seuil'}: ${s.threshold}`
                                          : (lang === 'vi' ? 'Đặt ngưỡng' : 'Définir seuil')}
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

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
        const groups = groupSendable(sendable);
        const chosen = groups.filter(g => stockSel[g.key]?.on && Number(stockSel[g.key]?.qty) > 0);
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
                {groups.map(g => {
                  const sel = stockSel[g.key] ?? { on: false, qty: '0' };
                  return (
                    <div key={g.key} className="flex items-center gap-3 p-2.5 rounded-xl"
                      style={{ backgroundColor: sel.on ? '#EFF6FF' : '#F9FAFB', border: '1px solid', borderColor: sel.on ? '#BFDBFE' : '#E5E7EB' }}>
                      <button onClick={() => setStockSel(p => ({ ...p, [g.key]: { ...sel, on: !sel.on } }))}
                        className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center"
                        style={{ backgroundColor: sel.on ? '#1D4ED8' : 'white', border: '1px solid', borderColor: sel.on ? '#1D4ED8' : '#D1D5DB' }}>
                        {sel.on && <CheckCircle2 size={16} className="text-white" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>
                          {lang === 'vi' ? g.name_vi : (g.name_en || g.name_vi)}
                          {g.variant_label && g.variant_label !== 'Standard' && (
                            <span className="text-[11px] font-normal text-ink-light"> · {g.variant_label}</span>
                          )}
                        </div>
                        <div className="text-[11px] text-ink-light">
                          {lang === 'vi' ? 'Đã làm' : 'Produced'}: {g.produced}
                          {g.remaining !== g.produced && (
                            <span className="font-semibold" style={{ color: '#1D4ED8' }}> · {lang === 'vi' ? 'còn lại' : 'left to send'}: {g.remaining}</span>
                          )}
                          {g.parts.length > 1 && <span> · {g.parts.length} {lang === 'vi' ? 'đơn' : 'orders'}</span>}
                        </div>
                      </div>
                      <input type="number" value={sel.qty} disabled={!sel.on}
                        onChange={e => setStockSel(p => ({ ...p, [g.key]: { ...sel, qty: e.target.value } }))}
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

      {/* Design reference photo — full-size view */}
      {designPhotoModal && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
          onClick={() => setDesignPhotoModal(null)}>
          <button type="button" onClick={() => setDesignPhotoModal(null)}
            className="absolute top-4 right-4 p-2 rounded-full text-white" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
            <X size={22} />
          </button>
          <img src={thumb(designPhotoModal, 1200)} alt="" className="max-w-full max-h-full rounded-lg object-contain" onClick={e => e.stopPropagation()} />
        </div>
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
                    <img src={thumb(extraVariant?.image_url ?? extraProduct.main_image_url ?? undefined, 96)} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
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
                            <img src={thumb(p.main_image_url, 96)} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
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

              {extraProduct && canWeighExtra && (
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-ink-light">
                    {lang === 'vi' ? 'Khối lượng sản xuất (kg)' : 'Poids produit (kg)'}
                  </label>
                  <div className="flex items-center gap-3 mt-2">
                    <input
                      type="text" inputMode="decimal"
                      value={extraWeightKg}
                      onChange={e => setExtraWeightKg(e.target.value)}
                      placeholder="0"
                      className="text-4xl font-black text-center rounded-xl border-2 outline-none w-32 py-1"
                      style={{ color: '#1A4731', borderColor: '#1A4731' }}
                    />
                    <span className="text-xl font-bold text-ink-light">kg</span>
                  </div>
                  <p className="text-sm text-ink-light mt-2">
                    {lang === 'vi'
                      ? `≈ ${extraWeightUnits} đơn vị (${extraVariantWeightG} g/đơn vị)`
                      : `≈ ${extraWeightUnits} unités (${extraVariantWeightG} g/unité)`}
                  </p>
                </div>
              )}

              {extraProduct && !canWeighExtra && (
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
                <button onClick={saveExtra} disabled={!extraProduct || savingExtra || (canWeighExtra && extraQty < 1)}
                  className="flex-1 py-3 rounded-xl font-bold text-white disabled:opacity-40 transition-colors"
                  style={{ backgroundColor: '#1A4731' }}>
                  {savingExtra ? '…' : (lang === 'vi' ? 'Xác nhận' : 'Confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete extra confirmation */}
      {deleteModal && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => { if (!deleting) { setDeleteModal(null); setDeleteError(false); } }}>
          <div className="modal-sheet bg-white w-full max-w-sm rounded-t-2xl p-6 space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div>
              <h3 className="font-bold text-base" style={{ color: '#DC2626' }}>
                {lang === 'vi' ? 'Xóa sản xuất thêm?' : 'Delete extra production?'}
              </h3>
              <p className="text-sm text-ink-light mt-1">
                {deleteModal.product_name_vi}
                {deleteModal.variant_label && deleteModal.variant_label !== 'Standard' ? ` · ${deleteModal.variant_label}` : ''}
                {' '}× {deleteModal.qty_produced}
              </p>
              <p className="text-xs text-ink-light mt-2">
                {lang === 'vi'
                  ? 'Thẻ này sẽ bị xóa vĩnh viễn. Nếu chọn nhầm sản phẩm, hãy xóa rồi tạo lại.'
                  : 'This card will be permanently removed. If the wrong product was picked, delete then re-create it.'}
              </p>
            </div>
            {deleteError && (
              <p className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>
                {lang === 'vi' ? 'Không thể xóa — vui lòng thử lại hoặc báo quản lý.' : 'Could not delete — try again or tell a manager.'}
              </p>
            )}
            <div className="flex gap-3">
              <button onClick={() => { setDeleteModal(null); setDeleteError(false); }} disabled={deleting}
                className="flex-1 py-3 rounded-xl font-semibold border border-gray-200 text-ink-light">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button onClick={deleteExtra} disabled={deleting}
                className="flex-1 py-3 rounded-xl font-bold text-white disabled:opacity-50"
                style={{ backgroundColor: '#DC2626' }}>
                {deleting ? '…' : (lang === 'vi' ? 'Xóa' : 'Delete')}
              </button>
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
                {qtyModal.is_extra
                  ? (lang === 'vi' ? 'Sửa số lượng sản xuất thêm' : 'Edit extra production quantity')
                  : <>{lang === 'vi' ? 'Cần làm' : 'Target'}: <strong>{qtyModal.qty_to_produce}</strong></>}
              </p>
              {!qtyModal.is_extra && qtyInput > qtyModal.qty_to_produce && (
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
                  color: !qtyModal.is_extra && qtyInput > qtyModal.qty_to_produce ? '#D97706' : '#1A4731',
                  borderColor: !qtyModal.is_extra && qtyInput > qtyModal.qty_to_produce ? '#D97706' : '#1A4731',
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
  a, lang, updating, readOnly, onAdvance, onMarkInStock, onPartial, onViewFiche, onNoteUpdate, onBlocked, onOpenDesignPhoto, meta, backTo,
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
  onOpenDesignPhoto: (url: string) => void;
  meta: typeof TEAM_LABELS[Team];
  backTo: string;
}) {
  const st = STATUS_META[a.status];
  const isUpdating = updating === a.id;
  // Breakdown collapsed by default on phones (open on sm+ via CSS)
  const [showBreakdown, setShowBreakdown] = useState(false);
  const canAdvance = !readOnly && !a.cancelled && ['pending', 'in_progress', 'partial'].includes(a.status);
  const canMarkStock = !readOnly && !a.cancelled && ['pending', 'in_progress'].includes(a.status) && !a.is_extra;
  const canBlock = !readOnly && !a.cancelled && ['pending', 'in_progress', 'partial'].includes(a.status);
  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];

  const actionLabel: Record<string, string> = {
    pending: lang === 'vi' ? 'Bắt đầu' : 'Start',
    in_progress: lang === 'vi' ? 'Xong' : 'Mark done',
    partial: lang === 'vi' ? 'Xong' : 'Mark done',
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
          <img src={thumb(a.image_url, 144)} alt="" className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl object-cover shrink-0"
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
            {a.draft_odoo && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                style={{ backgroundColor: '#FEF3C7', color: '#B45309' }}
                title={lang === 'vi' ? 'Đơn Odoo còn ở trạng thái nháp — có thể thay đổi' : 'Commande encore en brouillon sur Odoo — peut changer'}>
                <AlertCircle size={10} />{lang === 'vi' ? 'Nháp Odoo' : 'Brouillon Odoo'}
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
          {(a.bc_ready_time || a.bc_message || a.bc_notes || a.bc_shop_name || a.category_name_vi === 'Birthday cake') && (
            <div className="mt-1.5 flex flex-col gap-1 items-start">
              {/* Manual/exceptional cake: shop (always) + linked Odoo order once matched — this
                  card's own `breakdown` is always [] (see page.tsx), so without this the chef
                  has no idea which shop/client it's for (2026-08-25, Axel). */}
              {a.bc_shop_name && (
                <span className="text-xs font-medium rounded-lg px-2 py-1 inline-flex items-center gap-1.5"
                  style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                  <Store size={12} /> {a.bc_shop_name}
                  {a.bc_order_ref && <span className="text-[10px] font-mono font-bold">· {a.bc_order_ref}</span>}
                </span>
              )}
              {a.bc_ready_time && (
                <span className="text-[11px] font-bold rounded-lg px-2 py-1 inline-flex items-center gap-1.5"
                  style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}>
                  <Clock size={12} /> {lang === 'vi' ? 'Cần xong' : 'Ready by'} {a.bc_ready_time.slice(0, 5)}
                </span>
              )}
              {a.bc_message ? (
                <span className="text-xs font-medium rounded-lg px-2 py-1 inline-flex items-start gap-1.5"
                  style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                  🎂 <span style={{ fontWeight: 500 }}>{a.bc_message}</span>
                </span>
              ) : a.category_name_vi === 'Birthday cake' && (
                <span className="text-xs font-bold rounded-lg px-2 py-1 inline-flex items-center gap-1.5"
                  style={{ backgroundColor: '#FEE2E2', color: '#DC2626' }}
                  title={lang === 'vi' ? 'Chưa có lời chúc — hỏi trợ lý' : 'Message pas encore renseigné — voir avec l’assistante'}>
                  <AlertCircle size={12} /> {lang === 'vi' ? 'Thiếu lời chúc' : 'Message manquant'}
                </span>
              )}
              {(a.bc_design_notes || a.bc_design_photo_url) && (
                <div className="text-xs font-medium rounded-lg px-2 py-1.5 flex items-start gap-2"
                  style={{ backgroundColor: '#F5F3FF', color: '#6D28D9' }}>
                  {a.bc_design_photo_url && (
                    <button type="button" onClick={() => onOpenDesignPhoto(a.bc_design_photo_url!)}
                      className="shrink-0" title={lang === 'vi' ? 'Xem ảnh mẫu' : 'Voir la photo'}>
                      <img src={thumb(a.bc_design_photo_url, 96)} alt="" className="w-9 h-9 rounded-md object-cover" />
                    </button>
                  )}
                  {a.bc_design_notes && <span>🎨 {a.bc_design_notes}</span>}
                </div>
              )}
              {/* Generic assistant note — every category (not just cakes), 2026-08-27 fix: this
                  used to be captured on manual/exceptional orders but never surfaced anywhere. */}
              {a.bc_notes && (
                <span className="text-xs font-medium rounded-lg px-2 py-1 inline-flex items-start gap-1.5"
                  style={{ backgroundColor: '#FFFBEB', color: '#92600A' }}>
                  📝 <span>{a.bc_notes}</span>
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
            <div key={i} className="px-4 py-2 text-sm"
              style={{
                borderTop: i > 0 ? '1px solid #F5EFC8' : undefined,
                backgroundColor: i % 2 === 0 ? 'white' : '#FFFAEE',
              }}>
              <div className="flex items-center justify-between">
                <span className="text-ink font-medium flex items-center gap-1.5">
                  {b.shop_name}
                  {/* Order ref — same shop can appear twice on one card (e.g. two separate
                      LAB orders), which used to be indistinguishable at a glance (Axel,
                      2026-08-14). */}
                  {b.order_ref && <span className="text-[10px] font-mono text-ink-light">{b.order_ref}</span>}
                  {b.delivery_time && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: '#FFF4CC', color: '#C9A84C' }}>
                      ⏰ {b.delivery_time.slice(0, 5)}
                    </span>
                  )}
                </span>
                <span className="font-black" style={{ color: '#1A4731' }}>x{b.qty}</span>
              </div>
              {b.note && (
                <div className="text-xs font-semibold mt-1 whitespace-pre-line" style={{ color: '#B45309' }}>
                  📝 {b.note}
                </div>
              )}
              {b.changed_at && (
                <div className="text-[10px] font-semibold mt-1" style={{ color: '#92600A' }}>
                  🔄 {lang === 'vi' ? 'Odoo sửa' : 'Modifié'} {b.changed_at} ({(b.changed_delta ?? 0) > 0 ? '+' : ''}{b.changed_delta})
                </div>
              )}
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

// Lab-local calendar day ('YYYY-MM-DD') of a UTC timestamp — used to tell whether an "ahead"
// (produced_ahead) card was actually made today or yesterday, since the time alone (HH:MM) looks
// identical either way and that ambiguity was the whole source of confusion around this badge.
function labDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function producedDayLabel(iso: string, lang: 'vi' | 'en'): string {
  const day = labDayKey(iso);
  const today = labDayKey(new Date().toISOString());
  if (day === today) return lang === 'vi' ? 'hôm nay' : "aujourd'hui";
  const yesterday = labDayKey(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  if (day === yesterday) return lang === 'vi' ? 'hôm qua' : 'hier';
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
}

function TermineCard({
  a, lang, meta, onAdvance, updating, readOnly, onEdit, onDelete,
}: {
  a: Assignment;
  lang: 'vi' | 'en';
  meta: typeof TEAM_LABELS[Team];
  onAdvance: (a: Assignment) => void;
  updating: string | null;
  readOnly?: boolean;
  onEdit?: (a: Assignment) => void;
  onDelete?: (a: Assignment) => void;
}) {
  const isSkip = a.status === 'skip';
  // Editable until sent to stock — after that the card is frozen (bon already issued)
  const editable = !isSkip && !a.transferred && !a.cancelled && !readOnly;
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
          <img src={thumb(a.image_url, 112)} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
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
          {!isSkip && a.produced_by_name && (
            <div className="text-[10px] text-ink-light mt-1">
              {lang === 'vi' ? 'Bởi' : 'Fait par'}{' '}
              <span className="font-semibold" style={{ color: '#1A4731' }}>{a.produced_by_name}</span>
              {a.produced_at && (
                <>
                  {/* Date shown for "ahead" cards only — that's the case where the same HH:MM
                      could mean yesterday (Today tab) or today (Tomorrow tab); regular cards are
                      always "today" so the date would just be noise. */}
                  {ahead && <> {producedDayLabel(a.produced_at, lang)}</>}
                  {' '}{lang === 'vi' ? 'lúc' : 'à'}{' '}
                  <span className="font-semibold" style={{ color: '#1A4731' }}>
                    {new Date(a.produced_at).toLocaleTimeString(lang === 'vi' ? 'vi-VN' : 'fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        {/* Revert button for skip */}
        {isSkip && (
          <button onClick={() => onAdvance(a)} disabled={updating === a.id}
            className="px-3 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all"
            style={{ backgroundColor: '#EDE9FE', color: '#6D28D9', opacity: updating === a.id ? 0.6 : 1 }}>
            {lang === 'vi' ? 'Cần làm' : 'Produce'}
          </button>
        )}
        {/* Edit (+ delete for extra) while not yet sent to stock */}
        {editable && (
          <div className="flex flex-col gap-1.5 shrink-0">
            {onEdit && (
              <button onClick={() => onEdit(a)} disabled={updating === a.id}
                className="px-3 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all inline-flex items-center gap-1.5"
                style={{ backgroundColor: '#FEF3C7', color: '#92600A', opacity: updating === a.id ? 0.6 : 1 }}>
                <PenLine size={12} />{lang === 'vi' ? 'Sửa' : 'Edit'}
              </button>
            )}
            {a.is_extra && onDelete && (
              <button onClick={() => onDelete(a)} disabled={updating === a.id}
                className="px-3 py-2 rounded-xl text-xs font-bold active:scale-95 transition-all inline-flex items-center gap-1.5"
                style={{ backgroundColor: '#FEE2E2', color: '#DC2626', opacity: updating === a.id ? 0.6 : 1 }}>
                <X size={12} />{lang === 'vi' ? 'Xóa' : 'Delete'}
              </button>
            )}
          </div>
        )}
      </div>
      {/* Manual/exceptional cake — breakdown is always [] for these (see page.tsx). */}
      {!isSkip && breakdown.length === 0 && (a.bc_shop_name || a.bc_message || a.bc_notes) && (
        <div className="border-t px-4 py-1.5 text-xs space-y-0.5" style={{ borderColor: '#F5EFC8' }}>
          {a.bc_shop_name && (
            <span className="flex items-center gap-1.5 text-ink-light">
              {a.bc_shop_name}
              {a.bc_order_ref && <span className="text-[10px] font-mono">{a.bc_order_ref}</span>}
            </span>
          )}
          {/* Same message/notes fields shown on Production + Commande, added here 2026-08-27
              (staff reported these never appeared on Terminé either). */}
          {a.bc_message && <div className="font-semibold" style={{ color: '#92600A' }}>🎂 {a.bc_message}</div>}
          {a.bc_notes && <div className="font-semibold" style={{ color: '#92600A' }}>📝 {a.bc_notes}</div>}
        </div>
      )}
      {/* Breakdown for done items */}
      {!isSkip && breakdown.length > 0 && (
        <div className="border-t" style={{ borderColor: '#F5EFC8' }}>
          {breakdown.map((b, i) => (
            <div key={i} className="px-4 py-1.5 text-xs text-ink-light"
              style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  {b.shop_name}
                  {b.order_ref && <span className="text-[10px] font-mono">{b.order_ref}</span>}
                </span>
                <span className="font-bold">x{b.qty}</span>
              </div>
              {b.note && (
                <div className="font-semibold mt-0.5 whitespace-pre-line" style={{ color: '#B45309' }}>
                  📝 {b.note}
                </div>
              )}
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
