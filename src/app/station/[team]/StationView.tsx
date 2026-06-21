'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  CheckCircle2, Play, AlertCircle, Clock, FlaskConical, Minus, Plus,
  BookOpen, X, Timer, Thermometer, LogOut, Store,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, type Team, type AssignmentStatus } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

type BreakdownItem = { shop_name: string; qty: number; order_ref?: string };

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
  breakdown: BreakdownItem[];
  lab_imports: { delivery_date: string; order_number: number; type: string; status: string };
};

type FicheStep = {
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
};

const STATUS_FLOW: Partial<Record<AssignmentStatus, AssignmentStatus>> = {
  pending: 'in_progress',
  in_progress: 'done',
  skip: 'pending', // chef can override a skip
};

export default function StationView({
  team, assignments: initial, today,
}: {
  team: Team;
  assignments: Assignment[];
  today: string;
}) {
  const { lang, setLang } = useI18n();
  const router = useRouter();
  const [assignments, setAssignments] = useState(initial);
  const [updating, setUpdating] = useState<string | null>(null);
  const [qtyModal, setQtyModal] = useState<Assignment | null>(null);
  const [qtyInput, setQtyInput] = useState(0);
  const [ficheModal, setFicheModal] = useState<{ productId: string; productName: string } | null>(null);
  const [expandedBreakdown, setExpandedBreakdown] = useState<Set<string>>(new Set());
  const meta = TEAM_LABELS[team];

  // Supabase Realtime
  useEffect(() => {
    const supabase = createClient();
    const importIds = Array.from(new Set(initial.map(a => a.import_id)));
    if (importIds.length === 0) return;

    const channel = supabase
      .channel(`station-${team}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'lab_assignments',
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

  async function savePartial() {
    if (!qtyModal) return;
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

  function toggleBreakdown(id: string) {
    setExpandedBreakdown(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const pending = assignments.filter(a => a.status === 'pending');
  const inProgress = assignments.filter(a => a.status === 'in_progress');
  const done = assignments.filter(a => a.status === 'done');
  const skipped = assignments.filter(a => a.status === 'skip');
  const other = assignments.filter(a => ['partial', 'blocked'].includes(a.status));

  const totalQty = assignments.filter(a => a.status !== 'skip').reduce((s, a) => s + a.qty_to_produce, 0);
  const doneQty = assignments.filter(a => a.status === 'done').reduce((s, a) => s + a.qty_produced, 0);
  const pct = totalQty ? Math.round(doneQty / totalQty * 100) : 0;

  async function logout() {
    await createClient().auth.signOut();
    router.push('/login');
  }

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

  const sharedCardProps = {
    lang,
    updating,
    onAdvance: advanceStatus,
    onPartial: (a: Assignment) => { setQtyInput(a.qty_produced); setQtyModal(a); },
    onViewFiche: (a: Assignment) => a.product_id ? setFicheModal({ productId: a.product_id, productName: a.product_name_vi }) : null,
    meta,
    expandedBreakdown,
    onToggleBreakdown: toggleBreakdown,
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FFF4CC' }}>
      {/* Top bar — Jungle green */}
      <header className="sticky top-0 z-20" style={{ backgroundColor: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: 'rgba(255,244,204,0.2)' }}>
              <FlaskConical size={18} className="text-white" />
            </div>
            <div className="min-w-0">
              <div className="text-white font-bold text-sm leading-tight truncate">
                {lang === 'vi' ? meta.vi : meta.en}
              </div>
              <div className="text-white/60 text-[11px] truncate">{formatDate(today)}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Progress pill */}
            <div className="rounded-full px-3 py-1 text-xs font-bold" style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
              {doneQty}/{totalQty}
            </div>
            {/* Lang toggle */}
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
            {/* Fiches */}
            <Link href="/station/fiches" title={lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe cards'}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ backgroundColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)' }}>
              <BookOpen size={15} />
            </Link>
            {/* Logout */}
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
      </header>

      {/* Completion banner */}
      {pct === 100 && assignments.length > 0 && (
        <div className="text-center py-3 text-sm font-bold" style={{ backgroundColor: '#C9A84C', color: '#1A4731' }}>
          {lang === 'vi' ? '🎉 Hoàn thành tất cả!' : '🎉 All done for today!'}
        </div>
      )}

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6 pb-24">
        {assignments.length === 0 && (
          <div className="text-center py-20">
            <CheckCircle2 size={48} className="mx-auto mb-3" style={{ color: '#2D6A4F' }} />
            <p className="font-semibold" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? 'Chưa có đơn sản xuất hôm nay' : 'No production orders for today'}
            </p>
            <p className="text-sm mt-1 text-ink-light">
              {lang === 'vi' ? 'Đơn sẽ xuất hiện khi được phát hành' : 'Orders will appear once published'}
            </p>
          </div>
        )}

        {/* In progress — first */}
        {inProgress.length > 0 && (
          <section>
            <SectionHeader icon={<Play size={13} style={{ color: '#2563EB' }} />}
              label={lang === 'vi' ? 'Đang làm' : 'In progress'} count={inProgress.length} />
            <div className="space-y-3">
              {inProgress.map(a => <TaskCard key={a.id} a={a} {...sharedCardProps} />)}
            </div>
          </section>
        )}

        {/* Pending */}
        {pending.length > 0 && (
          <section>
            <SectionHeader icon={<Clock size={13} style={{ color: '#D97706' }} />}
              label={lang === 'vi' ? 'Chờ làm' : 'Pending'} count={pending.length} />
            <div className="space-y-3">
              {pending.map(a => <TaskCard key={a.id} a={a} {...sharedCardProps} />)}
            </div>
          </section>
        )}

        {/* Skip — visible for chef verification (NOT grayed out) */}
        {skipped.length > 0 && (
          <section>
            <SectionHeader
              icon={<AlertCircle size={13} style={{ color: '#7C3AED' }} />}
              label={lang === 'vi' ? 'Được báo "có sẵn" — hãy kiểm tra lại' : 'Marked in-stock — please verify'}
              count={skipped.length}
              accent
            />
            <div className="space-y-3">
              {skipped.map(a => <TaskCard key={a.id} a={a} {...sharedCardProps} isSkip />)}
            </div>
          </section>
        )}

        {/* Done */}
        {done.length > 0 && (
          <section>
            <SectionHeader icon={<CheckCircle2 size={13} style={{ color: '#059669' }} />}
              label={lang === 'vi' ? 'Hoàn thành' : 'Done'} count={done.length} />
            <div className="space-y-2 opacity-50">
              {done.map(a => <TaskCard key={a.id} a={a} {...sharedCardProps} isDone />)}
            </div>
          </section>
        )}

        {/* Other exceptions (partial / blocked) */}
        {other.length > 0 && (
          <section>
            <SectionHeader icon={<AlertCircle size={13} style={{ color: '#DC2626' }} />}
              label={lang === 'vi' ? 'Ngoại lệ khác' : 'Other exceptions'} count={other.length} />
            <div className="space-y-3">
              {other.map(a => <TaskCard key={a.id} a={a} {...sharedCardProps} />)}
            </div>
          </section>
        )}
      </div>

      {/* Fiche modal */}
      {ficheModal && (
        <FicheModal productId={ficheModal.productId} productName={ficheModal.productName}
          lang={lang} onClose={() => setFicheModal(null)} />
      )}

      {/* Qty modal */}
      {qtyModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white w-full max-w-sm rounded-t-2xl p-6 space-y-5">
            <div>
              <h3 className="font-bold text-base" style={{ color: '#1A4731' }}>{qtyModal.product_name_vi}</h3>
              <p className="text-sm text-ink-light mt-0.5">
                {lang === 'vi' ? 'Cần làm' : 'Target'}: <strong>{qtyModal.qty_to_produce}</strong>
              </p>
            </div>
            <div className="flex items-center justify-center gap-6">
              <button onClick={() => setQtyInput(q => Math.max(0, q - 1))}
                className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center active:scale-95 transition-transform"
                style={{ color: '#1A4731' }}>
                <Minus size={20} />
              </button>
              <span className="text-5xl font-black w-16 text-center" style={{ color: '#1A4731' }}>{qtyInput}</span>
              <button onClick={() => setQtyInput(q => Math.min(qtyModal.qty_to_produce, q + 1))}
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

function SectionHeader({ icon, label, count, accent }: { icon: React.ReactNode; label: string; count: number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider"
        style={{ color: accent ? '#7C3AED' : '#6B7280' }}>
        {icon}
        {label} <span className="ml-0.5 opacity-70">({count})</span>
      </div>
      <div className="flex-1 h-px" style={{ backgroundColor: accent ? '#DDD6FE' : '#E0D49A' }} />
    </div>
  );
}

function TaskCard({
  a, lang, updating, onAdvance, onPartial, onViewFiche, meta,
  isDone = false, isSkip = false,
  expandedBreakdown, onToggleBreakdown,
}: {
  a: Assignment; lang: 'vi' | 'en'; updating: string | null;
  onAdvance: (a: Assignment) => void;
  onPartial: (a: Assignment) => void;
  onViewFiche: (a: Assignment) => void;
  meta: typeof TEAM_LABELS[Team];
  isDone?: boolean; isSkip?: boolean;
  expandedBreakdown: Set<string>;
  onToggleBreakdown: (id: string) => void;
}) {
  const st = STATUS_META[a.status];
  const canAdvance = ['pending', 'in_progress', 'skip'].includes(a.status);
  const isUpdating = updating === a.id;

  const actionLabel: Record<string, string> = {
    pending: lang === 'vi' ? 'Bắt đầu' : 'Start',
    in_progress: lang === 'vi' ? 'Xong' : 'Mark done',
    skip: lang === 'vi' ? 'Cần làm' : 'Override',
  };

  const breakdown: BreakdownItem[] = Array.isArray(a.breakdown) ? a.breakdown : [];
  const isExpanded = expandedBreakdown.has(a.id);

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        backgroundColor: isSkip ? '#F5F3FF' : 'white',
        border: isSkip ? '1.5px solid #C4B5FD' : '1px solid #E0D49A',
        boxShadow: '0 1px 4px rgba(26,71,49,0.07)',
      }}>

      {/* Skip warning banner */}
      {isSkip && (
        <div className="px-4 py-2 flex items-center gap-2 text-xs font-semibold"
          style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>
          <AlertCircle size={13} />
          {lang === 'vi' ? 'Trợ lý đã đánh dấu "có sẵn" — vui lòng kiểm tra trước khi sản xuất'
            : 'Marked in-stock by assistant — verify before producing'}
        </div>
      )}

      <div className="flex items-start p-4 gap-3">
        {/* Product image */}
        {a.image_url ? (
          <img src={a.image_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0"
            style={{ border: '1px solid #E0D49A' }} loading="lazy" />
        ) : (
          <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl"
            style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
        )}

        {/* Main info */}
        <div className="flex-1 min-w-0">
          {a.product_id ? (
            <Link href={`/station/fiche/${a.product_id}?back=/station/me`}
              className="font-bold text-base leading-tight block hover:underline"
              style={{ color: '#1A4731' }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </Link>
          ) : (
            <div className="font-bold text-base leading-tight" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? a.product_name_vi : (a.product_name_en || a.product_name_vi)}
            </div>
          )}
          {a.variant_label !== 'Standard' && (
            <div className="text-sm text-ink-light mt-0.5">{a.variant_label}</div>
          )}

          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-2xl font-black" style={{ color: meta.color }}>×{a.qty_to_produce}</span>
            {a.qty_produced > 0 && a.status !== 'done' && (
              <span className="text-sm text-ink-light">(✓ {a.qty_produced})</span>
            )}
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold text-white"
              style={{ backgroundColor: st.color }}>
              {lang === 'vi' ? st.labelVi : st.labelEn}
            </span>
          </div>

          {/* Client breakdown toggle */}
          {breakdown.length > 1 && (
            <button onClick={() => onToggleBreakdown(a.id)}
              className="mt-2 flex items-center gap-1 text-xs font-medium transition-colors"
              style={{ color: '#2D6A4F' }}>
              <Store size={11} />
              {isExpanded
                ? (lang === 'vi' ? 'Ẩn chi tiết khách hàng' : 'Hide client breakdown')
                : (lang === 'vi' ? `Xem ${breakdown.length} khách hàng` : `${breakdown.length} clients`)
              }
            </button>
          )}
          {breakdown.length === 1 && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-light">
              <Store size={11} />
              {breakdown[0].shop_name} — ×{breakdown[0].qty}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {canAdvance && !isDone && (
          <div className="flex flex-col gap-2 shrink-0">
            <button onClick={() => onAdvance(a)} disabled={isUpdating}
              className="px-4 py-2.5 rounded-xl font-bold text-white text-sm active:scale-95 transition-all"
              style={{
                backgroundColor: isSkip ? '#7C3AED' : '#1A4731',
                opacity: isUpdating ? 0.6 : 1,
              }}>
              {isUpdating ? '…' : actionLabel[a.status] ?? ''}
            </button>
            {a.status === 'in_progress' && (
              <button onClick={() => onPartial(a)}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors text-center"
                style={{ borderColor: '#E0D49A', color: '#6B7280' }}>
                {lang === 'vi' ? 'Ghi số' : 'Enter qty'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Client breakdown expanded */}
      {isExpanded && breakdown.length > 0 && (
        <div className="mx-4 mb-3 rounded-xl overflow-hidden" style={{ border: '1px solid #E0D49A' }}>
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider"
            style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F', borderBottom: '1px solid #E0D49A' }}>
            {lang === 'vi' ? 'Chi tiết theo khách hàng' : 'Per-client breakdown'}
          </div>
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between px-3 py-2 text-sm"
              style={{
                borderTop: i > 0 ? '1px solid #F5EFC8' : undefined,
                backgroundColor: i % 2 === 0 ? 'white' : '#FFFAEE',
              }}>
              <span className="text-ink font-medium truncate flex-1">{b.shop_name}</span>
              <span className="font-black ml-3 shrink-0" style={{ color: '#1A4731' }}>×{b.qty}</span>
            </div>
          ))}
        </div>
      )}

      {/* Notes + fiche link */}
      {(a.notes || a.product_id) && (
        <div className="px-4 pb-3 pt-1 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid #F5EFC8' }}>
          {a.notes ? (
            <span className="text-xs text-ink-light flex-1 italic">{a.notes}</span>
          ) : <span />}
          {a.product_id && (
            <button onClick={() => onViewFiche(a)}
              className="flex items-center gap-1 text-xs font-semibold transition-colors shrink-0"
              style={{ color: '#2D6A4F' }}>
              <BookOpen size={12} />
              {lang === 'vi' ? 'Phiếu kỹ thuật' : 'Recipe card'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FicheModal({
  productId, productName, lang, onClose,
}: {
  productId: string; productName: string; lang: 'vi' | 'en'; onClose: () => void;
}) {
  const [steps, setSteps] = useState<FicheStep[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from('lab_fiche_steps')
      .select('step_number, description_vi, description_en, duration_minutes, temperature_celsius')
      .eq('product_id', productId)
      .eq('step_type', 'step')
      .order('step_number')
      .then(({ data }) => setSteps(data ?? []));
  }, [productId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="bg-white w-full max-w-lg rounded-t-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0"
          style={{ borderBottom: '1px solid #E0D49A' }}>
          <div className="flex items-center gap-2">
            <BookOpen size={18} style={{ color: '#1A4731' }} />
            <span className="font-bold text-base" style={{ color: '#1A4731' }}>{productName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/station/fiche/${productId}?back=/station/me`}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              style={{ backgroundColor: '#FFF4CC', color: '#1A4731' }}>
              {lang === 'vi' ? 'Xem đầy đủ' : 'Full view'}
            </Link>
            <button onClick={onClose} className="p-1 text-ink-light hover:text-ink transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Steps */}
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          {steps === null ? (
            <p className="text-ink-light text-sm text-center py-10">
              {lang === 'vi' ? 'Đang tải…' : 'Loading…'}
            </p>
          ) : steps.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-ink-light text-sm">
                {lang === 'vi' ? 'Chưa có phiếu kỹ thuật cho sản phẩm này.' : 'No recipe steps added yet.'}
              </p>
              <Link href={`/station/fiche/${productId}?back=/station/me`}
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
