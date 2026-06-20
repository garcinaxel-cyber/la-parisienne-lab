'use client';
import { useState, useEffect } from 'react';
import { CheckCircle2, Play, AlertCircle, Clock, FlaskConical, Minus, Plus, BookOpen, X, Timer, Thermometer } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, type Team, type AssignmentStatus } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

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
};

export default function StationView({
  team, assignments: initial, today,
}: {
  team: Team;
  assignments: Assignment[];
  today: string;
}) {
  const { lang, setLang } = useI18n();
  const [assignments, setAssignments] = useState(initial);
  const [updating, setUpdating] = useState<string | null>(null);
  const [qtyModal, setQtyModal] = useState<Assignment | null>(null);
  const [qtyInput, setQtyInput] = useState(0);
  const [ficheModal, setFicheModal] = useState<{ productId: string; productName: string } | null>(null);
  const meta = TEAM_LABELS[team];

  // Supabase Realtime — subscribe to changes in lab_assignments for this team's today imports
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

  const pending = assignments.filter(a => a.status === 'pending');
  const inProgress = assignments.filter(a => a.status === 'in_progress');
  const done = assignments.filter(a => a.status === 'done');
  const blocked = assignments.filter(a => ['skip','partial','blocked'].includes(a.status));
  const totalQty = assignments.reduce((s, a) => s + a.qty_to_produce, 0);
  const doneQty = assignments.filter(a => a.status === 'done').reduce((s, a) => s + a.qty_produced, 0);
  const pct = totalQty ? Math.round(doneQty / totalQty * 100) : 0;

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

  return (
    <div className="min-h-screen bg-cream" style={{ '--team-color': meta.color, '--team-bg': meta.bg } as any}>
      {/* Top bar */}
      <header className="sticky top-0 z-20 shadow-sm" style={{ backgroundColor: meta.color }}>
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
              <FlaskConical size={16} className="text-white" />
            </div>
            <div>
              <div className="text-white font-bold text-sm leading-tight">
                {lang === 'vi' ? meta.vi : meta.en}
              </div>
              <div className="text-white/70 text-[11px]">{formatDate(today)}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Progress pill */}
            <div className="bg-white/20 rounded-full px-3 py-1 text-white text-xs font-semibold">
              {doneQty}/{totalQty} · {pct}%
            </div>
            {/* Lang toggle */}
            <div className="flex gap-0.5 bg-white/20 rounded-lg p-0.5">
              {(['vi','en'] as const).map(l => (
                <button key={l} onClick={() => setLang(l)}
                  className={`px-2 py-1 rounded text-xs font-bold transition-colors ${
                    lang === l ? 'bg-white text-navy' : 'text-white/70'
                  }`}>{l.toUpperCase()}</button>
              ))}
            </div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="h-1 bg-white/20">
          <div className="h-full bg-white transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6 pb-20">
        {assignments.length === 0 && (
          <div className="text-center py-20">
            <CheckCircle2 size={48} className="mx-auto mb-3 text-border-soft" />
            <p className="text-ink-light font-medium">
              {lang === 'vi' ? 'Chưa có đơn sản xuất hôm nay' : 'No production orders for today'}
            </p>
            <p className="text-xs text-ink-light mt-1">
              {lang === 'vi' ? 'Đơn sẽ xuất hiện khi được phát hành' : 'Orders will appear once published'}
            </p>
          </div>
        )}

        {/* In progress — show first */}
        {inProgress.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-light mb-3 flex items-center gap-1.5">
              <Play size={12} className="text-blue-500" />
              {lang === 'vi' ? 'Đang làm' : 'In progress'} ({inProgress.length})
            </h2>
            <div className="space-y-3">
              {inProgress.map(a => <TaskCard key={a.id} a={a} lang={lang} updating={updating} onAdvance={advanceStatus} onPartial={() => { setQtyInput(a.qty_produced); setQtyModal(a); }} onViewFiche={a.product_id ? () => setFicheModal({ productId: a.product_id!, productName: a.product_name_vi }) : null} meta={meta} />)}
            </div>
          </section>
        )}

        {/* Pending */}
        {pending.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-light mb-3 flex items-center gap-1.5">
              <Clock size={12} className="text-amber-500" />
              {lang === 'vi' ? 'Chờ làm' : 'Pending'} ({pending.length})
            </h2>
            <div className="space-y-3">
              {pending.map(a => <TaskCard key={a.id} a={a} lang={lang} updating={updating} onAdvance={advanceStatus} onPartial={() => { setQtyInput(a.qty_produced); setQtyModal(a); }} onViewFiche={a.product_id ? () => setFicheModal({ productId: a.product_id!, productName: a.product_name_vi }) : null} meta={meta} />)}
            </div>
          </section>
        )}

        {/* Done */}
        {done.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-light mb-3 flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-green-500" />
              {lang === 'vi' ? 'Hoàn thành' : 'Done'} ({done.length})
            </h2>
            <div className="space-y-2 opacity-60">
              {done.map(a => <TaskCard key={a.id} a={a} lang={lang} updating={updating} onAdvance={advanceStatus} onPartial={() => {}} onViewFiche={a.product_id ? () => setFicheModal({ productId: a.product_id!, productName: a.product_name_vi }) : null} meta={meta} isDone />)}
            </div>
          </section>
        )}

        {/* Blocked/skip */}
        {blocked.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-light mb-3 flex items-center gap-1.5">
              <AlertCircle size={12} className="text-red-500" />
              {lang === 'vi' ? 'Ngoại lệ' : 'Exceptions'} ({blocked.length})
            </h2>
            <div className="space-y-2 opacity-60">
              {blocked.map(a => <TaskCard key={a.id} a={a} lang={lang} updating={updating} onAdvance={advanceStatus} onPartial={() => {}} onViewFiche={a.product_id ? () => setFicheModal({ productId: a.product_id!, productName: a.product_name_vi }) : null} meta={meta} />)}
            </div>
          </section>
        )}
      </div>

      {/* Fiche modal */}
      {ficheModal && (
        <FicheModal
          productId={ficheModal.productId}
          productName={ficheModal.productName}
          lang={lang}
          onClose={() => setFicheModal(null)}
        />
      )}

      {/* Qty modal */}
      {qtyModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40">
          <div className="bg-white w-full max-w-sm rounded-t-2xl p-6 space-y-5">
            <div>
              <h3 className="font-semibold text-navy">{qtyModal.product_name_vi}</h3>
              <p className="text-sm text-ink-light mt-0.5">
                {lang === 'vi' ? 'Cần làm' : 'Target'}: {qtyModal.qty_to_produce}
              </p>
            </div>
            <div className="flex items-center justify-center gap-6">
              <button onClick={() => setQtyInput(q => Math.max(0, q - 1))}
                className="w-12 h-12 rounded-full bg-border-soft flex items-center justify-center text-navy active:scale-95 transition-transform">
                <Minus size={20} />
              </button>
              <span className="text-5xl font-bold text-navy w-16 text-center">{qtyInput}</span>
              <button onClick={() => setQtyInput(q => Math.min(qtyModal.qty_to_produce, q + 1))}
                className="w-12 h-12 rounded-full flex items-center justify-center text-white active:scale-95 transition-transform"
                style={{ backgroundColor: meta.color }}>
                <Plus size={20} />
              </button>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setQtyModal(null)} className="btn-secondary flex-1 py-3">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button onClick={savePartial}
                className="flex-1 py-3 rounded-xl font-semibold text-white transition-colors active:scale-95"
                style={{ backgroundColor: meta.color }}>
                {lang === 'vi' ? 'Xác nhận' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard({
  a, lang, updating, onAdvance, onPartial, onViewFiche, meta, isDone = false,
}: {
  a: Assignment; lang: 'vi' | 'en'; updating: string | null;
  onAdvance: (a: Assignment) => void; onPartial: () => void;
  onViewFiche: (() => void) | null;
  meta: typeof TEAM_LABELS[Team]; isDone?: boolean;
}) {
  const st = STATUS_META[a.status];
  const canAdvance = a.status === 'pending' || a.status === 'in_progress';
  const isUpdating = updating === a.id;

  const actionLabel = {
    pending: lang === 'vi' ? 'Bắt đầu' : 'Start',
    in_progress: lang === 'vi' ? 'Xong' : 'Mark done',
  }[a.status as string] ?? '';

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden border border-border-soft">
      <div className="flex items-center p-4 gap-4">
        {/* Image */}
        {a.image_url ? (
          <img src={a.image_url} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0 bg-cream" loading="lazy" />
        ) : (
          <div className="w-16 h-16 rounded-xl bg-cream shrink-0 flex items-center justify-center">
            <span className="text-3xl" style={{ color: meta.color }}>🥐</span>
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="font-bold text-navy text-base leading-tight truncate">{a.product_name_vi}</div>
          {a.variant_label !== 'Standard' && (
            <div className="text-sm text-ink-light">{a.variant_label}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-2xl font-black" style={{ color: meta.color }}>×{a.qty_to_produce}</span>
            {a.qty_produced > 0 && a.status !== 'done' && (
              <span className="text-sm text-ink-light">(✓ {a.qty_produced})</span>
            )}
            <span className="badge text-white text-[10px]" style={{ backgroundColor: st.color }}>
              {lang === 'vi' ? st.labelVi : st.labelEn}
            </span>
          </div>
        </div>

        {/* Actions */}
        {canAdvance && !isDone && (
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => onAdvance(a)}
              disabled={isUpdating}
              className="px-4 py-2.5 rounded-xl font-semibold text-white text-sm active:scale-95 transition-all"
              style={{ backgroundColor: meta.color }}
            >
              {isUpdating ? '…' : actionLabel}
            </button>
            {a.status === 'in_progress' && (
              <button onClick={onPartial}
                className="px-3 py-1.5 rounded-xl text-xs font-medium border border-border-soft text-ink-light hover:border-navy/30 transition-colors text-center">
                {lang === 'vi' ? 'Ghi số' : 'Enter qty'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Notes + View fiche */}
      {(a.notes || onViewFiche) && (
        <div className="px-4 pb-3 border-t border-border-soft pt-2 flex items-center justify-between gap-2">
          {a.notes ? (
            <span className="text-xs text-ink-light flex-1">{a.notes}</span>
          ) : <span />}
          {onViewFiche && (
            <button
              onClick={onViewFiche}
              className="flex items-center gap-1 text-xs font-medium text-navy/70 hover:text-navy transition-colors shrink-0"
            >
              <BookOpen size={13} />
              {lang === 'vi' ? 'Xem phiếu' : 'View recipe'}
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
      .order('step_number')
      .then(({ data }) => setSteps(data ?? []));
  }, [productId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white w-full max-w-lg rounded-t-2xl max-h-[80vh] flex flex-col shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-soft shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen size={18} className="text-navy" />
            <span className="font-semibold text-navy">{productName}</span>
          </div>
          <button onClick={onClose} className="p-1 text-ink-light hover:text-navy transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Steps */}
        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {steps === null ? (
            <p className="text-ink-light text-sm text-center py-10">
              {lang === 'vi' ? 'Đang tải…' : 'Loading…'}
            </p>
          ) : steps.length === 0 ? (
            <p className="text-ink-light text-sm text-center py-10">
              {lang === 'vi' ? 'Chưa có phiếu kỹ thuật cho sản phẩm này.' : 'No recipe steps added yet.'}
            </p>
          ) : steps.map(step => (
            <div key={step.step_number} className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-navy text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                {step.step_number}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-sm text-navy leading-relaxed">
                  {lang === 'vi'
                    ? step.description_vi
                    : (step.description_en || step.description_vi)}
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
