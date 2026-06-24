'use client';
import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, Save, Thermometer, Timer, Eye, Upload } from 'lucide-react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

// ─── Types ───────────────────────────────────────────────────────────────────

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'] as const;
type Team = typeof TEAMS[number];

interface FicheIdentity {
  name_vi: string;
  name_en: string;
  category: string;
  teams: Team[];
  image_url: string;
}

interface FicheTechnique {
  doc_code: string;
  weight_grams: string;
  tolerance_pct: string;
  sensory_vi: string;
  sensory_en: string;
  warning_vi: string;
  warning_en: string;
}

interface Variant {
  id?: string;
  label: string;
  sku: string;
  weight_g: string;
  is_default: boolean;
  sort_order: number;
}

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyIngredient(num: number): Ingredient {
  return { step_number: num, description_vi: '', description_en: '', quantity_grams: null, percentage: null };
}

function emptyStep(num: number): AssemblyStep {
  return { step_number: num, description_vi: '', description_en: '', duration_minutes: null, temperature_celsius: null };
}

function emptyVariant(sortOrder: number): Variant {
  return { label: '', sku: '', weight_g: '', is_default: false, sort_order: sortOrder };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FicheEditor({
  ficheId,
  identity: initIdentity,
  technique: initTechnique,
  variants: initVariants,
  ingredients: initIngredients,
  assemblySteps: initSteps,
}: {
  ficheId: string;
  identity: FicheIdentity;
  technique: FicheTechnique | null;
  variants: Variant[];
  ingredients: Ingredient[];
  assemblySteps: AssemblyStep[];
}) {
  const { lang } = useI18n();
  const router = useRouter();

  const [identity, setIdentity] = useState<FicheIdentity>(initIdentity);
  const [technique, setTechnique] = useState<FicheTechnique>(initTechnique ?? {
    doc_code: '', weight_grams: '', tolerance_pct: '3',
    sensory_vi: '', sensory_en: '', warning_vi: '', warning_en: '',
  });
  const [variants, setVariants] = useState<Variant[]>(
    initVariants.length > 0
      ? initVariants
      : [{ label: 'Standard', sku: '', weight_g: '', is_default: true, sort_order: 0 }]
  );
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    initIngredients.length > 0 ? initIngredients : [emptyIngredient(1)]
  );
  const [steps, setSteps] = useState<AssemblyStep[]>(
    initSteps.length > 0 ? initSteps : [emptyStep(1)]
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'produit' | 'technique' | 'ingredients' | 'steps'>('produit');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // ── Identity ──
  function toggleTeam(team: Team) {
    setIdentity(p => ({
      ...p,
      teams: p.teams.includes(team) ? p.teams.filter(t => t !== team) : [...p.teams, team],
    }));
    setSaved(false);
  }

  // ── Variants ──
  function addVariant() { setVariants(p => [...p, emptyVariant(p.length)]); setSaved(false); }
  function removeVariant(idx: number) {
    setVariants(p => p.filter((_, i) => i !== idx).map((v, i) => ({ ...v, sort_order: i })));
    setSaved(false);
  }
  function updateVariant(idx: number, patch: Partial<Variant>) {
    setVariants(p => p.map((v, i) => i === idx ? { ...v, ...patch } : v));
    setSaved(false);
  }
  function setDefaultVariant(idx: number) {
    setVariants(p => p.map((v, i) => ({ ...v, is_default: i === idx })));
    setSaved(false);
  }

  // ── Ingredients ──
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

  // ── Steps ──
  function addStep() { setSteps(p => [...p, emptyStep(p.length + 1)]); setSaved(false); }
  function removeStep(idx: number) {
    setSteps(p => p.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_number: i + 1 })));
    setSaved(false);
  }
  function updateStep(idx: number, patch: Partial<AssemblyStep>) {
    setSteps(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s)); setSaved(false);
  }

  // ── Image upload ──
  async function handleImageFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    setUploadingImage(true);
    const supabase = createClient();
    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `fiches/${ficheId}.${ext}`;
    const { error } = await supabase.storage.from('lab-images').upload(path, file, { upsert: true });
    if (!error) {
      const { data: urlData } = supabase.storage.from('lab-images').getPublicUrl(path);
      setIdentity(p => ({ ...p, image_url: urlData.publicUrl }));
      setSaved(false);
    }
    setUploadingImage(false);
  }

  // ── Delete ──
  async function deleteFiche() {
    if (!confirm(lang === 'vi'
      ? 'Xoá fiche này? Hành động này không thể hoàn tác.'
      : 'Delete this recipe card? This cannot be undone.')) return;
    setDeleting(true);
    const supabase = createClient();
    await supabase.from('lab_fiche_meta').update({ is_active: false }).eq('id', ficheId);
    router.push('/admin/fiches');
  }

  // ── Save ──
  async function save() {
    setSaving(true); setError(null);
    const supabase = createClient();

    // 1. Update lab_fiche_meta
    const { error: metaErr } = await supabase.from('lab_fiche_meta').update({
      name_vi: identity.name_vi,
      name_en: identity.name_en || null,
      category: identity.category || null,
      teams: identity.teams,
      image_url: identity.image_url || null,
      doc_code: technique.doc_code || null,
      weight_grams: technique.weight_grams ? Number(technique.weight_grams) : null,
      tolerance_pct: technique.tolerance_pct ? Number(technique.tolerance_pct) : 3,
      sensory_vi: technique.sensory_vi || null,
      sensory_en: technique.sensory_en || null,
      warning_vi: technique.warning_vi || null,
      warning_en: technique.warning_en || null,
      updated_at: new Date().toISOString(),
    }).eq('id', ficheId);
    if (metaErr) { setError(metaErr.message); setSaving(false); return; }

    // 2. Variants — delete removed, update existing, insert new
    const currentIds = variants.filter(v => v.id).map(v => v.id!);
    const removedIds = initVariants.filter(v => v.id && !currentIds.includes(v.id)).map(v => v.id!);
    if (removedIds.length > 0) {
      const { error: delVErr } = await supabase.from('lab_fiche_variants').delete().in('id', removedIds);
      if (delVErr) { setError(delVErr.message); setSaving(false); return; }
    }
    const updateResults = await Promise.all(
      variants.filter(v => v.id).map(v =>
        supabase.from('lab_fiche_variants').update({
          label: v.label,
          sku: v.sku || null,
          weight_g: v.weight_g ? Number(v.weight_g) : null,
          is_default: v.is_default,
          sort_order: v.sort_order,
        }).eq('id', v.id!)
      )
    );
    const updateErr = updateResults.find(r => r.error)?.error;
    if (updateErr) { setError(updateErr.message); setSaving(false); return; }

    const newVariants = variants.filter(v => !v.id).map(v => ({
      fiche_id: ficheId,
      label: v.label,
      sku: v.sku || null,
      weight_g: v.weight_g ? Number(v.weight_g) : null,
      is_default: v.is_default,
      sort_order: v.sort_order,
    }));
    if (newVariants.length > 0) {
      const { error: insVErr } = await supabase.from('lab_fiche_variants').insert(newVariants);
      if (insVErr) { setError(insVErr.message); setSaving(false); return; }
    }

    // 3. Steps — delete all + re-insert
    const { error: delErr } = await supabase.from('lab_fiche_steps').delete().eq('fiche_id', ficheId);
    if (delErr) { setError(delErr.message); setSaving(false); return; }

    const rows = [
      ...ingredients
        .filter(i => i.description_vi.trim() || i.description_en.trim())
        .map(i => ({
          fiche_id: ficheId, step_type: 'ingredient', step_number: i.step_number,
          description_vi: i.description_vi, description_en: i.description_en,
          quantity_grams: i.quantity_grams, percentage: i.percentage,
          duration_minutes: null, temperature_celsius: null,
        })),
      ...steps
        .filter(s => s.description_vi.trim() || s.description_en.trim())
        .map(s => ({
          fiche_id: ficheId, step_type: 'step', step_number: s.step_number,
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
    { key: 'produit',     label: lang === 'vi' ? '① Sản phẩm' : '① Product' },
    { key: 'technique',   label: lang === 'vi' ? '② Fiche technique' : '② Technical sheet' },
    { key: 'ingredients', label: lang === 'vi' ? '③ Nguyên liệu' : '③ Ingredients' },
    { key: 'steps',       label: lang === 'vi' ? '④ Quy trình' : '④ Assembly' },
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
            {identity.image_url && (
              <img src={identity.image_url} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" />
            )}
            <div>
              <h1 className="font-serif text-2xl font-bold text-navy">{identity.name_vi || '…'}</h1>
              {identity.name_en && <p className="text-sm text-ink-light">{identity.name_en}</p>}
            </div>
          </div>
          <Link
            href={`/station/fiche/${ficheId}?back=/admin/fiches/${ficheId}`}
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

      {/* ── Tab: Sản phẩm ── */}
      {activeTab === 'produit' && (
        <div className="space-y-5">
          <div className="card p-5 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label text-[10px]">Tên sản phẩm (Tiếng Việt) *</label>
                <input value={identity.name_vi}
                  onChange={e => { setIdentity(p => ({ ...p, name_vi: e.target.value })); setSaved(false); }}
                  placeholder="Bánh mì bơ tỏi…" className="input mt-1 w-full text-sm font-medium" />
              </div>
              <div>
                <label className="label text-[10px]">Product name (English)</label>
                <input value={identity.name_en}
                  onChange={e => { setIdentity(p => ({ ...p, name_en: e.target.value })); setSaved(false); }}
                  placeholder="Garlic butter bread…" className="input mt-1 w-full text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label text-[10px]">{lang === 'vi' ? 'Danh mục' : 'Category'}</label>
                <input value={identity.category}
                  onChange={e => { setIdentity(p => ({ ...p, category: e.target.value })); setSaved(false); }}
                  placeholder="Bread / Entremets…" className="input mt-1 w-full text-sm" />
              </div>
              <div>
                <label className="label text-[10px]">{lang === 'vi' ? 'Hình ảnh' : 'Photo'}</label>
                <div
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => {
                    e.preventDefault(); setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) handleImageFile(file);
                  }}
                  onClick={() => imageInputRef.current?.click()}
                  className={`mt-1 relative flex items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-colors overflow-hidden ${
                    dragOver ? 'border-gold bg-gold/5' : 'border-border-soft hover:border-gold/40'
                  } ${identity.image_url ? 'h-28' : 'h-20'}`}
                >
                  {identity.image_url ? (
                    <>
                      <img src={identity.image_url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                        <span className="text-white text-xs font-medium flex items-center gap-1.5">
                          <Upload size={12} /> {lang === 'vi' ? 'Đổi ảnh' : 'Change'}
                        </span>
                      </div>
                      <button type="button"
                        onClick={e => { e.stopPropagation(); setIdentity(p => ({ ...p, image_url: '' })); setSaved(false); }}
                        className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-red-500 transition-colors text-xs leading-none">
                        ×
                      </button>
                    </>
                  ) : uploadingImage ? (
                    <span className="text-ink-light text-xs">⏳ {lang === 'vi' ? 'Đang tải lên…' : 'Uploading…'}</span>
                  ) : (
                    <span className="text-ink-light text-xs flex items-center gap-1.5">
                      <Upload size={13} /> {lang === 'vi' ? 'Kéo thả hoặc click để chọn ảnh' : 'Drop or click to browse'}
                    </span>
                  )}
                </div>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value = ''; }} />
              </div>
            </div>

            {/* Teams multi-select */}
            <div>
              <label className="label text-[10px] mb-2 block">
                {lang === 'vi' ? 'Đội sản xuất' : 'Production teams'}
              </label>
              <div className="flex flex-wrap gap-2">
                {TEAMS.map(team => (
                  <button
                    key={team}
                    type="button"
                    onClick={() => toggleTeam(team)}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
                      identity.teams.includes(team)
                        ? 'bg-navy text-white border-navy'
                        : 'bg-white text-ink-light border-border-soft hover:border-navy/30'
                    }`}
                  >
                    {team}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Variants / SKUs block */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-navy">
                {lang === 'vi' ? 'Kích thước / Formats (SKUs)' : 'Sizes / Formats (SKUs)'}
              </h3>
              <button onClick={addVariant}
                className="flex items-center gap-1 text-xs font-medium text-gold border border-gold/40 rounded-lg px-3 py-1.5 hover:bg-gold/5 transition-colors">
                <Plus size={12} /> {lang === 'vi' ? 'Thêm format' : 'Add size'}
              </button>
            </div>
            <div className="card overflow-hidden">
              <div className="grid grid-cols-12 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/60">
                <div className="col-span-3">Label</div>
                <div className="col-span-4">SKU</div>
                <div className="col-span-2 text-center">{lang === 'vi' ? 'Khối lượng' : 'Weight'} (gr)</div>
                <div className="col-span-2 text-center">{lang === 'vi' ? 'Mặc định' : 'Default'}</div>
                <div className="col-span-1" />
              </div>
              <div className="divide-y divide-border-soft">
                {variants.map((v, idx) => (
                  <div key={idx} className="grid grid-cols-12 items-center px-4 py-2.5 gap-2">
                    <div className="col-span-3">
                      <input value={v.label}
                        onChange={e => updateVariant(idx, { label: e.target.value })}
                        placeholder="Standard, D14…" className="input w-full text-sm py-1.5" />
                    </div>
                    <div className="col-span-4">
                      <input value={v.sku}
                        onChange={e => updateVariant(idx, { sku: e.target.value })}
                        placeholder="BCMD14…" className="input w-full text-sm py-1.5 font-mono text-xs" />
                    </div>
                    <div className="col-span-2">
                      <input type="number" min={0} step={1} value={v.weight_g}
                        onChange={e => updateVariant(idx, { weight_g: e.target.value })}
                        placeholder="—" className="input w-full text-sm py-1.5 text-center" />
                    </div>
                    <div className="col-span-2 flex justify-center">
                      <input type="radio" name="default_variant" checked={v.is_default}
                        onChange={() => setDefaultVariant(idx)}
                        className="accent-navy w-4 h-4 cursor-pointer" />
                    </div>
                    <div className="col-span-1 flex justify-center">
                      {variants.length > 1 && (
                        <button onClick={() => removeVariant(idx)}
                          className="p-1 text-ink-light hover:text-red-500 transition-colors">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab: Fiche technique ── */}
      {activeTab === 'technique' && (
        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Mã tài liệu' : 'Document code'}</label>
              <input value={technique.doc_code} onChange={e => setTechnique(m => ({ ...m, doc_code: e.target.value }))}
                placeholder="QT-SX-CBP05" className="input mt-1 w-full text-sm font-mono" />
            </div>
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Trọng lượng chuẩn (gr)' : 'Standard weight (gr)'}</label>
              <input type="number" min={0} value={technique.weight_grams}
                onChange={e => setTechnique(m => ({ ...m, weight_grams: e.target.value }))}
                placeholder="170" className="input mt-1 w-full text-sm" />
            </div>
            <div>
              <label className="label text-[10px]">{lang === 'vi' ? 'Sai số (%)' : 'Tolerance (%)'}</label>
              <input type="number" min={0} max={20} step={0.5} value={technique.tolerance_pct}
                onChange={e => setTechnique(m => ({ ...m, tolerance_pct: e.target.value }))}
                placeholder="3" className="input mt-1 w-full text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label text-[10px]">Tiêu chuẩn cảm quan — Tiếng Việt</label>
              <p className="text-[10px] text-ink-light mt-0.5 mb-1">Mỗi dòng = 1 tiêu chí. Dùng **Tiêu đề:** để in đậm.</p>
              <textarea value={technique.sensory_vi}
                onChange={e => setTechnique(m => ({ ...m, sensory_vi: e.target.value }))}
                placeholder={"**Hình dáng:** Oval thuôn dài đều đặn\n**Màu sắc:** Vàng nâu óng\n**Bề mặt:** Sốt zíc-zắc sắc nét\n**Cấu trúc:** Ruột mềm xốp, ẩm"}
                rows={6} className="input mt-1 w-full resize-none text-sm font-mono" />
            </div>
            <div>
              <label className="label text-[10px]">Quality standards — English</label>
              <p className="text-[10px] text-ink-light mt-0.5 mb-1">One line = one criterion. Use **Title:** for bold.</p>
              <textarea value={technique.sensory_en}
                onChange={e => setTechnique(m => ({ ...m, sensory_en: e.target.value }))}
                placeholder={"**Shape:** Elongated oval, uniform\n**Color:** Golden brown crust\n**Surface:** Precise zigzag sauce\n**Texture:** Soft, moist crumb"}
                rows={6} className="input mt-1 w-full resize-none text-sm font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label text-[10px]">Lưu ý nghiêm ngặt — Tiếng Việt</label>
              <textarea value={technique.warning_vi}
                onChange={e => setTechnique(m => ({ ...m, warning_vi: e.target.value }))}
                placeholder="Toàn bộ thợ bánh bắt buộc phải cân đong chính xác…"
                rows={3} className="input mt-1 w-full resize-none text-sm" />
            </div>
            <div>
              <label className="label text-[10px]">Strict note — English</label>
              <textarea value={technique.warning_en}
                onChange={e => setTechnique(m => ({ ...m, warning_en: e.target.value }))}
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
                  <label className="label text-[10px] flex items-center gap-1">
                    <Timer size={11} /> {lang === 'vi' ? 'Thời gian (phút)' : 'Duration (min)'}
                  </label>
                  <input type="number" min={0} value={step.duration_minutes ?? ''}
                    onChange={e => updateStep(idx, { duration_minutes: e.target.value ? Number(e.target.value) : null })}
                    placeholder="—" className="input mt-1 w-full text-sm" />
                </div>
                <div className="flex-1">
                  <label className="label text-[10px] flex items-center gap-1">
                    <Thermometer size={11} /> {lang === 'vi' ? 'Nhiệt độ (°C)' : 'Temperature (°C)'}
                  </label>
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
        <div className="flex items-center gap-2">
          <Link href="/admin/fiches" className="btn-secondary text-sm">
            {lang === 'vi' ? 'Quay lại danh sách' : 'Back to list'}
          </Link>
          <button onClick={deleteFiche} disabled={deleting}
            className="text-sm text-red-500 hover:text-red-700 border border-red-200 hover:border-red-300 rounded-xl px-3 py-2 transition-colors">
            {deleting ? '…' : (lang === 'vi' ? 'Xoá fiche' : 'Delete')}
          </button>
        </div>
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
