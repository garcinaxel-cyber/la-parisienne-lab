'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Package2, Tag, Building2, X, Save, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { createClient } from '@/lib/supabase-browser';

type Product = {
  id: string;
  name_vi: string;
  name_en: string | null;
  sku: string | null;
  main_image_url: string | null;
  is_lab_only: boolean;
  is_active: boolean;
  subcategory: string | null;
};

type Category = { id: string; name_vi: string; name_en: string };

const CHANNELS = [
  { value: 'b2b', label_vi: 'B2B (doanh nghiệp)', label_en: 'B2B (business)' },
  { value: 'wholesale', label_vi: 'Bán sỉ', label_en: 'Wholesale' },
  { value: 'internal', label_vi: 'Nội bộ', label_en: 'Internal use' },
  { value: 'other', label_vi: 'Khác', label_en: 'Other channel' },
];

export default function LabProductsView({ products: initial, categories }: {
  products: Product[]; categories: Category[];
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
    channel: 'b2b',
    subcategory: '',
    category_id: '',
    image_url: '',
  });

  function resetForm() {
    setForm({ name_vi: '', name_en: '', sku: '', channel: 'b2b', subcategory: '', category_id: '', image_url: '' });
    setError(null);
  }

  async function createProduct() {
    if (!form.name_vi.trim()) { setError(lang === 'vi' ? 'Cần có tên sản phẩm' : 'Product name is required'); return; }
    setSaving(true);
    setError(null);
    const supabase = createClient();

    const { data, error: err } = await supabase.from('products').insert({
      name_vi: form.name_vi.trim(),
      name_en: form.name_en.trim() || null,
      sku: form.sku.trim() || null,
      subcategory: form.subcategory.trim() || null,
      category_id: form.category_id || null,
      main_image_url: form.image_url.trim() || null,
      is_active: false,       // NOT visible on public catalogue
      is_lab_only: true,      // Lab-only flag
    }).select('id, name_vi, name_en, sku, main_image_url, is_lab_only, is_active, subcategory').single();

    if (err || !data) {
      setError(err?.message ?? 'Failed to create product');
      setSaving(false);
      return;
    }

    setProducts(prev => [data, ...prev]);
    resetForm();
    setShowForm(false);
    setSaving(false);
  }

  async function toggleActive(product: Product) {
    // Note: is_active=true would make it visible on the catalogue.
    // For lab-only products, we keep is_active=false always.
    // This button is intentionally not provided.
  }

  async function deleteProduct(id: string) {
    if (!confirm(lang === 'vi' ? 'Xóa sản phẩm này? Hành động này không thể hoàn tác.' : 'Delete this product? This cannot be undone.')) return;
    setDeleting(id);
    const supabase = createClient();
    await supabase.from('products').delete().eq('id', id).eq('is_lab_only', true);
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
        <Building2 size={18} className="shrink-0 mt-0.5" />
        <div>
          <strong>{lang === 'vi' ? 'Comment ça marche :' : 'How this works:'}</strong>
          {lang === 'vi'
            ? ' Các sản phẩm này được lưu trong cùng bảng products nhưng với is_active=false và is_lab_only=true. App catalogue chỉ hiển thị is_active=true, nên chúng sẽ không bao giờ xuất hiện cho khách hàng. Trong Lab, chúng hiển thị cho manager và đầu bếp.'
            : ' These products live in the shared products table but with is_active=false and is_lab_only=true. The catalogue app only shows is_active=true products, so they never appear to customers. In the Lab, they\'re visible to managers and chefs.'}
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
                {lang === 'vi' ? 'Tên sản phẩm (VI) *' : 'Product name (VI) *'}
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
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">SKU</label>
              <input value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. B2B-001" />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Kênh phân phối' : 'Channel'}
              </label>
              <select value={form.channel} onChange={e => setForm(f => ({ ...f, channel: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}>
                {CHANNELS.map(c => (
                  <option key={c.value} value={c.value}>
                    {lang === 'vi' ? c.label_vi : c.label_en}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Danh mục' : 'Category'}
              </label>
              <select value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}>
                <option value="">{lang === 'vi' ? '— Chọn danh mục —' : '— Select category —'}</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>
                    {lang === 'vi' ? c.name_vi : c.name_en}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-ink-light mb-1.5">
                {lang === 'vi' ? 'Danh mục con' : 'Subcategory'}
              </label>
              <input value={form.subcategory} onChange={e => setForm(f => ({ ...f, subcategory: e.target.value }))}
                className="w-full rounded-xl border px-3 py-2.5 text-sm focus:outline-none focus:ring-1"
                style={{ borderColor: '#E0D49A' }}
                placeholder="e.g. Gói hợp tác" />
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
            {lang === 'vi' ? 'Chưa có sản phẩm lab-only' : 'No lab-only products yet'}
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
              {p.main_image_url ? (
                <img src={p.main_image_url} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0"
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
                  <span className="text-[10px] font-bold rounded-full px-2 py-0.5"
                    style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>
                    Lab only
                  </span>
                </div>
              </div>
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
