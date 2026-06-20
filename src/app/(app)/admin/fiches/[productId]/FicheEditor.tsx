'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, Save, Thermometer, Timer, BookOpen } from 'lucide-react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

interface Step {
  id?: string;
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
  image_url: string | null;
}

interface Product {
  id: string;
  name_vi: string;
  name_en: string | null;
  image_url: string | null;
  sku: string | null;
}

function emptyStep(num: number): Step {
  return {
    step_number: num,
    description_vi: '',
    description_en: '',
    duration_minutes: null,
    temperature_celsius: null,
    image_url: null,
  };
}

export default function FicheEditor({ product, steps: initialSteps }: { product: Product; steps: Step[] }) {
  const { lang } = useI18n();
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>(
    initialSteps.length > 0 ? initialSteps : [emptyStep(1)]
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addStep() {
    setSteps(prev => [...prev, emptyStep(prev.length + 1)]);
    setSaved(false);
  }

  function removeStep(idx: number) {
    setSteps(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 })));
    setSaved(false);
  }

  function updateStep(idx: number, patch: Partial<Step>) {
    setSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const supabase = createClient();

    // Delete all existing steps for this product, then re-insert
    const { error: delErr } = await supabase
      .from('lab_fiche_steps')
      .delete()
      .eq('product_id', product.id);

    if (delErr) { setError(delErr.message); setSaving(false); return; }

    const toInsert = steps
      .filter(s => s.description_vi.trim() || s.description_en.trim())
      .map(s => ({
        product_id: product.id,
        step_number: s.step_number,
        description_vi: s.description_vi,
        description_en: s.description_en,
        duration_minutes: s.duration_minutes,
        temperature_celsius: s.temperature_celsius,
        image_url: s.image_url,
      }));

    if (toInsert.length > 0) {
      const { error: insErr } = await supabase.from('lab_fiche_steps').insert(toInsert);
      if (insErr) { setError(insErr.message); setSaving(false); return; }
    }

    setSaving(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Link href="/admin/fiches" className="mt-1 p-1 rounded-lg hover:bg-border-soft transition-colors">
          <ArrowLeft size={20} className="text-ink-light" />
        </Link>
        <div className="flex-1 min-w-0 flex items-start gap-4">
          {product.image_url && (
            <img src={product.image_url} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" />
          )}
          <div>
            <h1 className="font-serif text-2xl font-bold text-navy">{product.name_vi}</h1>
            {product.name_en && <p className="text-sm text-ink-light">{product.name_en}</p>}
            {product.sku && <p className="text-xs text-ink-light font-mono mt-0.5">SKU: {product.sku}</p>}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-50 text-red-700 text-sm">{error}</div>
      )}

      {/* Steps */}
      <div className="space-y-4">
        {steps.map((step, idx) => (
          <div key={idx} className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-navy text-white flex items-center justify-center text-xs font-bold shrink-0">
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

            {/* Description */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label text-[10px]">Tiếng Việt</label>
                <textarea
                  value={step.description_vi}
                  onChange={e => updateStep(idx, { description_vi: e.target.value })}
                  placeholder="Hướng dẫn bằng tiếng Việt…"
                  rows={3}
                  className="input mt-1 w-full resize-none text-sm"
                />
              </div>
              <div>
                <label className="label text-[10px]">English</label>
                <textarea
                  value={step.description_en}
                  onChange={e => updateStep(idx, { description_en: e.target.value })}
                  placeholder="Instructions in English…"
                  rows={3}
                  className="input mt-1 w-full resize-none text-sm"
                />
              </div>
            </div>

            {/* Duration + Temp */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="label text-[10px] flex items-center gap-1">
                  <Timer size={11} /> {lang === 'vi' ? 'Thời gian (phút)' : 'Duration (min)'}
                </label>
                <input
                  type="number" min={0}
                  value={step.duration_minutes ?? ''}
                  onChange={e => updateStep(idx, { duration_minutes: e.target.value ? Number(e.target.value) : null })}
                  placeholder="—"
                  className="input mt-1 w-full text-sm"
                />
              </div>
              <div className="flex-1">
                <label className="label text-[10px] flex items-center gap-1">
                  <Thermometer size={11} /> {lang === 'vi' ? 'Nhiệt độ (°C)' : 'Temperature (°C)'}
                </label>
                <input
                  type="number"
                  value={step.temperature_celsius ?? ''}
                  onChange={e => updateStep(idx, { temperature_celsius: e.target.value ? Number(e.target.value) : null })}
                  placeholder="—"
                  className="input mt-1 w-full text-sm"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add step */}
      <button
        onClick={addStep}
        className="w-full py-3 border-2 border-dashed border-border-soft rounded-xl text-ink-light text-sm hover:border-gold/50 hover:text-gold transition-colors flex items-center justify-center gap-2"
      >
        <Plus size={16} />
        {lang === 'vi' ? 'Thêm bước' : 'Add step'}
      </button>

      {/* Save */}
      <div className="flex items-center justify-between pt-2">
        <Link href="/admin/fiches" className="btn-secondary text-sm">
          {lang === 'vi' ? 'Quay lại' : 'Back to list'}
        </Link>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-sm text-emerald-600 font-medium">
              {lang === 'vi' ? '✓ Đã lưu' : '✓ Saved'}
            </span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="btn-primary flex items-center gap-2"
          >
            <Save size={15} />
            {saving ? '…' : (lang === 'vi' ? 'Lưu phiếu' : 'Save recipe')}
          </button>
        </div>
      </div>
    </div>
  );
}
