'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, Save, Thermometer, Timer, Eye } from 'lucide-react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Ingredient {
  id?: string;
  step_number: number;
  description_vi: string;
  description_en: string;
  quantity_grams: number | null;
  percentage: number | null;
}

interface AssemblyStep {
  id?: string;
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
}

interface FicheMeta {
  doc_code: string;
  weight_grams: string;
  tolerance_pct: string;
  sensory_vi: string;
  sensory_en: string;
  warning_vi: string;
  warning_en: string;
}

interface Product {
  id: string;
  name_vi: string;
  name_en: string | null;
  image_url: string | null;
  sku: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyIngredient(num: number): Ingredient {
  return { step_number: num, description_vi: '', description_en: '', quantity_grams: null, percentage: null };
}

function emptyStep(num: number): AssemblyStep {
  return { step_number: num, description_vi: '', description_en: '', duration_minutes: null, temperature_celsius: null };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function FicheEditor({
  product,
  ingredients: initIngredients,
  assemblySteps: initSteps,
  meta: initMeta,
}: {
  product: Product;
  ingredients: Ingredient[];
  assemblySteps: AssemblyStep[];
  meta: FicheMeta | null;
}) {
  const { lang } = useI18n();
  const router = useRouter();

  const [meta, setMeta] = useState<FicheMeta>(initMeta ?? {
    doc_code: '', weight_grams: '', tolerance_pct: '3',
    sensory_vi: '', sensory_en: '', warning_vi: '', warning_en: '',
  });
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    initIngredients.length > 0 ? initIngredients : [emptyIngredient(1)]
  );
  const [steps, setSteps] = useState<AssemblyStep[]>(
    initSteps.length > 0 ? initSteps : [emptyStep(1)]
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'meta' | 'ingredients' | 'steps'>('meta');

  // ── Ingredient actions ──
  function addIngredient() { setIngredients(p => [...p, emptyIngredient(p.length + 1)]); setSaved(false); }
  function removeIngredient(idx: number) {
    setIngredients(p => p.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 })));
    setSaved(false);
  }
  function updateIngredient(idx: number, patch: Partial<Ingredient>) {
    setIngredients(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s)); setSaved(false);
  }
  function recalcPercentages() {
    const total = ingredients.reduce((s, i) => s + (i.quantity_grams ?? 0), 0);
    if (total <= 0) return;
    setIngredients(p => p.map(ing => ({
      ...ing,
      percentage: ing.quantity_grams != null ? Math.round((ing.quantity_grams / total) * 1000) / 10 : null,
    })));
  }

  // ── Step actions ──
  function addStep() { setSteps(p => [...p, emptyStep(p.length + 1)]); setSaved(false); }
  function removeStep(idx: number) {
    setSteps(p => p.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 })));
    setSaved(false);
  }
  function updateStep(idx: number, patch: Partial<AssemblyStep>) {
    setSteps(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s)); setSaved(false);
  }

  // ── Save ──
  async function save() {
    setSaving(true); setError(null);
    const supabase = createClient();

    // 1. Upsert fiche meta
    const { error: metaErr } = await supabase.from('lab_fiche_meta').upsert({
      product_id: product.id,
      doc_code: meta.doc_code || null,
      weight_grams: meta.weight_grams ? Number(meta.weight_grams) : null,
      tolerance_pct: meta.tolerance_pct ? Number(meta.tolerance_pct) : 3,
      sensory_vi: meta.sensory_vi,
      sensory_en: meta.sensory_en,
      warning_vi: meta.warning_vi,
      warning_en: meta.warning_en,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'product_id' });
    if (metaErr) { setError(metaErr.message); setSaving(false); return; }

    // 2. Delete all existing steps
    const { error: delErr } = await supabase.from('lab_fiche_steps').delete().eq('product_id', product.id);
    if (delErr) { setError(delErr.message); setSaving(false); return; }

    // 3. Re-insert ingredients + assembly steps
    const rows = [
      ...ingredients
        .filter(i => i.description_vi.trim() || i.description_en.trim())
        .map(i => ({
          product_id: product.id, step_type: 'ingredient', step_number: i.step_number,
          description_vi: i.description_vi, description_en: i.description_en,
          quantity_grams: i.quantity_grams, percentage: i.percentage,
          duration_minutes: null, temperature_celsius: null,
        })),
      ...steps
        .filter(s => s.description_vi.trim() || s.description_en.trim())
        .map(s => ({
          product_id: product.id, step_type: 'step', step_number: s.step_number,
          description_vi: s.description_vi, description_en: s.description_en,
          quantity_grams: null, percentage: null,
          duration_minutes: s.duration_minutes, temperature_celsius: s.temperature_celsius,
        })),
    ];
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('lab_fiche_steps').insert(rows);
      if (insErr) { setError(insErr.message); setSaving(false); return; }
    }

    setSaving(false); setSaved(true); router.refresh();
  }

  const totalWeight = ingredients.reduce((s, i) => s + (i.quantity_grams ?? 0), 0);

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'meta',        label: lang === 'vi' ? '① Thông tin chung' : '① General info' },
    { key: 'ingredients', label: lang === 'vi' ? '② Nguyên liệu / Layers' : '② Ingredients / Layers' },
    { key: 'steps',       label: lang === 'vi' ? '③ Quy trình lắp ráp' : '③ Assembly guide' },
  ];

  return (
    <div className="space-y-6 max-w-4xl">

      {/* Header */}
      <div className="flex items-start gap-3">
        <Link href="/admin/fiches" className="mt-1 p-1 rounded-lg hover:bg-border-soft transition-colors">
          <ArrowLeft size={20} className="text-ink-light" />
        </Link>
        <div className="flex-1 min-w-0 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            {product.image_url && (
              <img src={product.image_url} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" />
            )}
            <div>
              <h1 className="font-serif text-2xl font-bold text-navy">{product.name_vi}</h1>
              {product.name_en && <p className="text-sm text-ink-light">{product.name_en}</p>}
              {product.sku && <p className="text-xs text-ink-light font-mono mt-0.5">SKU: {product.sku}</p>}
            </div>
          </div>
          <Link
            href={`/station/fiche/${product.id}?back=/admin/fiches/${product.id}`}
            target="_blank"
            className="flex items-center gap-1.5 text-xs font-medium text-navy/60 border border-border-soft rounded-xl px-3 py-1.5 hover:bg-cream hover:text-navy transition-colors shrink-0"
          >
            <Eye size={13} /> {lang === 'vi' ? 'Xem phiếu' : 'Preview'}
          </Link>
        </div>
      </div>

      {error && <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-soft">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors -mb-px ${
              activeTab === t.key
                ? 'bg-white border border-border-soft border-b-white text-navy'
                : 'text-ink-light hover:text-navy'
            }`}>{t.label}</button>
        ))}
      </div>

      {/* ── Tab: Metadata ── */}
      {activeTab === 'meta' && (
        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Mã tài liệu' : 'Document code'}</label>
              <input value={meta.doc_code} onChange={e => setMeta(m => ({ ...m, doc_code: e.target.value }))}
                placeholder="QT-SX-CBP05" className="input mt-1 w-full text-sm font-mono" />
            </div>
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Trọng lượng chuẩn (gr)' : 'Standard weight (gr)'}</label>
              <input type="number" min={0} value={meta.weight_grams}
                onChange={e => setMeta(m => ({ ...m, weight_grams: e.target.value }))}
                placeholder="170" className="input mt-1 w-full text-sm" />
            </div>
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Sai số (%)' : 'Tolerance (%)'}</label>
              <input type="number" min={0} max={20} step={0.5} value={meta.tolerance_pct}
                onChange={e => setMeta(m => ({ ...m, tolerance_pct: e.target.value }))}
                placeholder="3" className="input mt-1 w-full text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label text-[10px]">Tiêu chuẩn cảm quan — Tiếng Việt</label>
              <p className="text-[10px] text-ink-light mt-0.5 mb-1">Mỗi dòng = 1 tiêu chí. Dùng **Tiêu đề:** để in đậm.</p>
              <textarea value={meta.sensory_vi}
                onChange={e => setMeta(m => ({ ...m, sensory_vi: e.target.value }))}
                placeholder={"**Hình dáng:** Oval thuôn dài đều đặn\n**Màu sắc:** Vàng nâu óng\n**Bề mặt:** Sốt zíc-zắc sắc nét\n**Cấu trúc:** Ruột mềm xốp, ẩm"}
                rows={6} className="input mt-1 w-full resize-none text-sm font-mono" />
            </div>
            <div>
              <label className="label text-[10px]">Quality standards — English</label>
              <p className="text-[10px] text-ink-light mt-0.5 mb-1">One line = one criterion. Use **Title:** for bold.</p>
              <textarea value={meta.sensory_en}
                onChange={e => setMeta(m => ({ ...m, sensory_en: e.target.value }))}
                placeholder={"**Shape:** Elongated oval, uniform\n**Color:** Golden brown crust\n**Surface:** Precise zigzag sauce\n**Texture:** Soft, moist crumb"}
                rows={6} className="input mt-1 w-full resize-none text-sm font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label text-[10px]">Lưu ý nghiêm ngặt — Tiếng Việt</label>
              <textarea value={meta.warning_vi}
                onChange={e => setMeta(m => ({ ...m, warning_vi: e.target.value }))}
                placeholder="Toàn bộ thợ bánh bắt buộc phải cân đong chính xác…"
                rows={3} className="input mt-1 w-full resize-none text-sm" />
            </div>
            <div>
              <label className="label text-[10px]">Strict note — English</label>
              <textarea value={meta.warning_en}
                onChange={e => setMeta(m => ({ ...m, warning_en: e.target.value }))}
                placeholder="All bakers must weigh each layer precisely…"
                rows={3} className="input mt-1 w-full resize-none text-sm" />
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Ingredients ── */}
      {activeTab === 'ingredients' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-light">
              {lang === 'vi' ? 'Liệt kê theo thứ tự lắp ráp' : 'List in assembly order'}
            </p>
            <button onClick={recalcPercentages}
              className="text-xs font-medium text-gold border border-gold/40 rounded-lg px-3 py-1.5 hover:bg-gold/5 transition-colors">
              {lang === 'vi' ? '⟳ Tính % tự động' : '⟳ Auto-calc %'}
            </button>
          </div>

          <div className="card overflow-hidden">
            <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/60">
              <div className="col-span-1 text-center">STT</div>
              <div className="col-span-4">Tên nguyên liệu (VI)</div>
              <div className="col-span-3">Ingredient (EN)</div>
              <div className="col-span-2 text-center">Qty (gr)</div>
              <div className="col-span-1 text-center">%</div>
              <div className="col-span-1" />
            </div>

            <div className="divide-y divide-border-soft">
              {ingredients.map((ing, idx) => (
                <div key={idx} className="grid grid-cols-12 items-center px-4 py-2.5 gap-2">
                  <div className="col-span-1 flex justify-center">
                    <div className="w-6 h-6 rounded-full bg-navy text-white flex items-center justify-center text-xs font-bold">
                      {ing.step_number}
                    </div>
                  </div>
                  <div className="col-span-4">
                    <input value={ing.description_vi}
                      onChange={e => updateIngredient(idx, { description_vi: e.target.value })}
                      placeholder="Đế bánh brioche…" className="input w-full text-sm py-1.5" />
                  </div>
                  <div className="col-span-3">
                    <input value={ing.description_en}
                      onChange={e => updateIngredient(idx, { description_en: e.target.value })}
                      placeholder="Brioche base…" className="input w-full text-sm py-1.5" />
                  </div>
                  <div className="col-span-2">
                    <input type="number" min={0} step={0.1} value={ing.quantity_grams ?? ''}
                      onChange={e => updateIngredient(idx, { quantity_grams: e.target.value ? Number(e.target.value) : null })}
                      placeholder="—" className="input w-full text-sm py-1.5 text-center" />
                  </div>
                  <div className="col-span-1">
                    <input type="number" min={0} max={100} step={0.1} value={ing.percentage ?? ''}
                      onChange={e => updateIngredient(idx, { percentage: e.target.value ? Number(e.target.value) : null })}
                      placeholder="—" className="input w-full text-sm py-1.5 text-center" />
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {ingredients.length > 1 && (
                      <button onClick={() => removeIngredient(idx)} className="p-1 text-ink-light hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Total row */}
            <div className="grid grid-cols-12 items-center px-4 py-2.5 gap-2 bg-amber-50 border-t-2 border-amber-200">
              <div className="col-span-1" />
              <div className="col-span-7 text-xs font-bold text-amber-800 uppercase text-right pr-2">
                {lang === 'vi' ? 'Tổng trọng lượng thành phẩm:' : 'Total finished product:'}
              </div>
              <div className="col-span-2 text-center text-sm font-black text-amber-700">
                {totalWeight > 0 ? `${totalWeight} gr` : '—'}
              </div>
              <div className="col-span-1 text-center text-sm font-black text-amber-700">
                {totalWeight > 0 ? '100%' : '—'}
              </div>
              <div className="col-span-1" />
            </div>
          </div>

          <button onClick={addIngredient}
            className="w-full py-3 border-2 border-dashed border-border-soft rounded-xl text-ink-light text-sm hover:border-gold/50 hover:text-gold transition-colors flex items-center justify-center gap-2">
            <Plus size={16} />
            {lang === 'vi' ? 'Thêm nguyên liệu' : 'Add ingredient'}
          </button>
        </div>
      )}

      {/* ── Tab: Assembly steps ── */}
      {activeTab === 'steps' && (
        <div className="space-y-4">
          {steps.map((step, idx) => (
            <div key={idx} className="card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-navy text-white flex items-center justify-center text-xs font-bold">
                    {step.step_number}
                  </div>
                  <span className="text-sm font-medium text-navy">
                    {lang === 'vi' ? 'Bước' : 'Step'} {step.step_number}
                  </span>
                </div>
                {steps.length > 1 && (
                  <button onClick={() => removeStep(idx)} className="p-1 text-ink-light hover:text-red-500 transition-colors">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label text-[10px]">Tiếng Việt</label>
                  <textarea value={step.description_vi}
                    onChange={e => updateStep(idx, { description_vi: e.target.value })}
                    placeholder="Hướng dẫn…" rows={3} className="input mt-1 w-full resize-none text-sm" />
                </div>
                <div>
                  <label className="label text-[10px]">English</label>
                  <textarea value={step.description_en}
                    onChange={e => updateStep(idx, { description_en: e.target.value })}
                    placeholder="Instructions…" rows={3} className="input mt-1 w-full resize-none text-sm" />
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label text-[10px] flex items-center gap-1"><Timer size={11} /> {lang === 'vi' ? 'Thời gian (phút)' : 'Duration (min)'}</label>
                  <input type="number" min={0} value={step.duration_minutes ?? ''}
                    onChange={e => updateStep(idx, { duration_minutes: e.target.value ? Number(e.target.value) : null })}
                    placeholder="—" className="input mt-1 w-full text-sm" />
                </div>
                <div className="flex-1">
                  <label className="label text-[10px] flex items-center gap-1"><Thermometer size={11} /> {lang === 'vi' ? 'Nhiệt độ (°C)' : 'Temperature (°C)'}</label>
                  <input type="number" value={step.temperature_celsius ?? ''}
                    onChange={e => updateStep(idx, { temperature_celsius: e.target.value ? Number(e.target.value) : null })}
                    placeholder="—" className="input mt-1 w-full text-sm" />
                </div>
              </div>
            </div>
          ))}
          <button onClick={addStep}
            className="w-full py-3 border-2 border-dashed border-border-soft rounded-xl text-ink-light text-sm hover:border-gold/50 hover:text-gold transition-colors flex items-center justify-center gap-2">
            <Plus size={16} />
            {lang === 'vi' ? 'Thêm bước' : 'Add step'}
          </button>
        </div>
      )}

      {/* Save bar */}
      <div className="flex items-center justify-between pt-2 border-t border-border-soft">
        <Link href="/admin/fiches" className="btn-secondary text-sm">
          {lang === 'vi' ? 'Quay lại danh sách' : 'Back to list'}
        </Link>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm text-emerald-600 font-medium">{lang === 'vi' ? '✓ Đã lưu' : '✓ Saved'}</span>}
          <button onClick={save} disabled={saving} className="btn-primary flex items-center gap-2">
            <Save size={15} />
            {saving ? '…' : (lang === 'vi' ? 'Lưu phiếu' : 'Save recipe')}
          </button>
        </div>
      </div>
    </div>
  );
}
