'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Package2, Tag, FlaskConical, X, Save, Trash2, PenLine } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

type Fiche = {
  id: string;
  name_vi: string;
  name_en: string | null;
  image_url: string | null;
  category: string | null;
  is_active: boolean;
  sku: string | null; // SKU from default variant
};

type Category = { id: string; name_vi: string; name_en: string };

const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'] as const;

export default function LabProductsView({ products: initial, categories }: {
  products: Fiche[]; categories: Category[];
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const [products, setProducts] = useState(initial);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [form, setForm] = useState({
    name_vi: '',
    name_en: '',
    sku: '',
    category: '',
    teams: [] as string[],
    image_url: '',
  });

  function resetForm() {
    setForm({ name_vi: '', name_en: '', sku: '', category: '', teams: [], image_url: '' });
    setError(null);
  }

  function toggleTeam(team: string) {
    setForm(f => ({
      ...f,
      teams: f.teams.includes(team) ? f.teams.filter(t => t !== team) : [...f.teams, team],
    }));
  }

  async function createProduct() {
    if (!form.name_vi.trim()) { setError(lang === 'vi' ? 'Cần có tên sản phẩm' : 'Product name is required'); return; }
    setSaving(true);
    setError(null);
    const supabase = createClient();

    // 1) Create the fiche in lab_fiche_meta
    const { data: fiche, error: ficheErr } = await supabase
      .from('lab_fiche_meta')
      .insert({
        name_vi: form.name_vi.trim(),
        name_en: form.name_en.trim() || null,
        category: form.category.trim() || null,
        teams: form.teams.length > 0 ? form.teams : null,
        image_url: form.image_url.trim() || null,
        is_active: true,
      })
      .select('id, name_vi, name_en, image_url, category, is_active')
      .single();

    if (ficheErr || !fiche) {
      setError(ficheErr?.message ?? 'Failed to create fiche');
      setSaving(false);
      return;
    }

    // 2) Create a default "Standard" variant with the given SKU
    const sku = form.sku.trim() || null;
    await supabase.from('lab_fiche_variants').insert({
      fiche_id: fiche.id,
      label: 'Standard',
      sku,
      is_default: true,
      sort_order: 0,
    });

    setProducts(prev => [{ ...fiche, sku }, ...prev]);
    resetForm();
    setShowForm(false);
    setSaving(false);
  }

  async function deleteProduct(id: string) {
    if (!confirm(lang === 'vi' ? 'Xóa fiche này? Hành động này không thể hoàn tác.' : 'Delete this fiche? This cannot be undone.')) return;
    setDeleting(id);
    const supabase = createClient();
    await supabase.from('lab_fiche_meta').delete().eq('id', id);
    setProducts(prev => prev.filter(p => p.id !== id));
    setDeleting(null);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold" style={{ color: '#1A4731' }}>
            {lang === 'vi' ? 'Sản phẩm Lab Only' : 'Lab-Only Products'}
          </h1>
          <p className="text-sm text-ink-light mt-1">
            {lang === 'vi'
              ? 'Sản phẩm B2B hoặc kênh khác — không hiển thị trên catalogue công khai'
              : 'B2B or other-channel products — not visible on the public catalogue'}
          </p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true); }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white shrink-0"
          style={{ backgroundColor: '#1A4731' }}>
          <Plus size={16} />
          {lang === 'vi' ? 'Thêm sản phẩm' : 'Add product'}
        </button>
      </div>

      {/* Info box */}
      <div className="rounded-xl p-4 text-sm flex gap-3"
        style={{ backgroundColor: '#F0F9F4', border: '1px solid #A7D4B8', color: '#2D6A4F' }}>
        <FlaskConical size={18} className="shrink-0 mt-0.5" />
        <div>
          <strong>{lang === 'vi' ? 'Fiches kỹ thuật Lab :' : 'Lab recipe fiches:'}</strong>
          {lang === 'vi'
            ? ' Mỗi fiche được lưu trong lab_fiche_meta — hoàn toàn tách biệt với catalogue B2C. Tạo fiche tại đây, sau đó chỉnh sửa chi tiết (nguyên liệu, bước làm, variants) trong trình chỉnh sửa fiche.'
            : ' Each fiche lives in lab_fiche_meta — completely separate from the B2C catalogue. Create a fiche here, then edit details (ingredients, steps, variants) in the fiche editor.'}
        </div>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-2xl p-6 space-y-4"
          style={{ backgroundColor: 'white', border: '1px solid #E0D49A', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
          <div className="flex items-center justify-between">
            <h2 className="font-bold" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? 'Thêm sản phẩm lab-only mới' : 'Add new lab-only product'}
            </h2>
            <button onClick={() => setShowForm(false)} className="text-ink-light hover:text-ink">
              <X size={18} />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Tên sản phẩm (VI) *'}
              </label>
              <input value={form.name_vi} onChange={e => setForm(f => ({ ...f, name_vi: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. Bánh mì B2B" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Tên (EN)' : 'Name (EN)'}
              </label>
              <input value={form.name_en} onChange={e => setForm(f => ({ ...f, name_en: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. B2B Bread" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'SKU (variant Standard)' : 'SKU (Standard variant)'}
              </label>
              <input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. LP-B2B-001" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Danh mục' : 'Category'}
              </label>
              <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. Bánh ngọt" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Đội sản xuất' : 'Production teams'}
              </label>
              <div className="flex gap-2 flex-wrap">
                {TEAMS.map(team => (
                  <button key={team} type="button" onClick={() => toggleTeam(team)}
                    className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
                    style={form.teams.includes(team)
                      ? { backgroundColor: '#1A4731', color: 'white' }
                      : { backgroundColor: '#F3F4F6', color: '#6B7280', border: '1px solid #E0D49A' }}>
                    {team}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'URL ảnh sản phẩm' : 'Product image URL'}
              </label>
              <input value={form.image_url} onChange={e => setForm(f => ({ ...f, image_url: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="https://..." />
            </div>
          </div>

          {error && (
            <div className="rounded-xl px-4 py-3 text-sm" style={{ backgroundColor: '#FEF2F2', color: '#DC2626' }}>
              {error}
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button onClick={() => setShowForm(false)} className="px-4 py-2.5 rounded-xl border text-sm font-medium text-ink-light"
              style={{ borderColor: '#E0D49A' }}>
              {lang === 'vi' ? 'Hủy' : 'Cancel'}
            </button>
            <button onClick={createProduct} disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
              style={{ backgroundColor: '#1A4731' }}>
              <Save size={14} />
              {saving ? (lang === 'vi' ? 'Đang lưu…' : 'Saving…') : (lang === 'vi' ? 'Tạo sản phẩm' : 'Create product')}
            </button>
          </div>
        </div>
      )}

      {/* Products list */}
      {products.length === 0 && !showForm && (
        <div className="text-center py-16 rounded-2xl"
          style={{ backgroundColor: 'white', border: '1px solid #E0D49A' }}>
          <Package2 size={40} className="mx-auto mb-3 text-ink-light" />
          <p className="font-semibold text-ink-light">
            {lang === 'vi' ? 'Chůa có sản phẩm lab-only' : 'No lab-only products yet'}
          </p>
          <p className="text-sm text-ink-light mt-1">
            {lang === 'vi' ? 'Thêm sản phẩm B2B hoặc các kênh khác tại đây' : 'Add B2B or other-channel products here'}
          </p>
        </div>
      )}

      {products.length > 0 && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid #E0D49A', backgroundColor: 'white' }}>
          {products.map((p, i) => (
            <div key={p.id} className="flex items-center gap-4 px-5 py-4"
              style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined }}>
              {p.image_url ? (
                <img src={p.image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
                  style={{ border: '1px solid #E0D49A' }} />
              ) : (
                <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-xl"
                  style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>
                  {p.name_vi}
                </div>
                {p.name_en && <div className="text-xs text-ink-light truncate">{p.name_en}</div>}
                <div className="flex items-center gap-2 mt-0.5">
                  {p.sku && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-2 py-0.5"
                      style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                      <Tag size={9} />{p.sku}
                    </span>
                  )}
                  {p.category && (
                    <span className="text-[10px] font-semibold rounded-full px-2 py-0.5"
                      style={{ backgroundColor: '#FFF4CC', color: '#92600A' }}>
                      {p.category}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => router.push(`/admin/fiches/${p.id}`)}
                className="p-2 rounded-lg transition-colors"
                style={{ color: '#2D6A4F' }}
                title={lang === 'vi' ? 'Chỉnh sửa fiche' : 'Edit fiche'}>
                <PenLine size={15} />
              </button>
              <button
                onClick={() => deleteProduct(p.id)}
                disabled={deleting === p.id}
                className="p-2 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                title={lang === 'vi' ? 'Xóa' : 'Delete'}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
