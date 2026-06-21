import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Plus, Tag } from 'lucide-react';

export const revalidate = 0;

export default async function FichesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  // All products: active catalogue + lab-only
  const { data: products } = await supabase
    .from('products')
    .select('id, name_vi, name_en, main_image_url, sku, is_lab_only')
    .or('is_active.eq.true,is_lab_only.eq.true')
    .order('name_vi');

  // Count steps per product (step_type added in lab_fiche_v2)
  const { data: stepCounts } = await supabase
    .from('lab_fiche_steps')
    .select('product_id');

  const countByProduct: Record<string, number> = {};
  for (const s of stepCounts ?? []) {
    countByProduct[s.product_id] = (countByProduct[s.product_id] ?? 0) + 1;
  }

  const allProducts = products ?? [];
  const labOnly = allProducts.filter((p: any) => p.is_lab_only);
  const catalogue = allProducts.filter((p: any) => !p.is_lab_only);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl font-bold text-navy">Phiếu kỹ thuật / Recipe Cards</h1>
        <p className="text-sm text-ink-light mt-1">
          Tạo hướng dẫn sản xuất từng bước cho mỗi sản phẩm · Step-by-step production guides per product
        </p>
      </div>

      {/* Catalogue products */}
      <section>
        <h2 className="text-xs font-bold uppercase tracking-widest text-ink-light mb-3">
          Catalogue public · {catalogue.length} produits
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {catalogue.map((product: any) => <ProductCard key={product.id} product={product} steps={countByProduct[product.id] ?? 0} />)}
        </div>
        {catalogue.length === 0 && (
          <div className="card p-8 text-center text-ink-light text-sm">Aucun produit catalogue.</div>
        )}
      </section>

      {/* Lab-only (B2B) products */}
      {labOnly.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-bold uppercase tracking-widest" style={{ color: '#6D28D9' }}>
              Lab Only / B2B · {labOnly.length} produits
            </h2>
            <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>
              Non visible sur catalogue
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {labOnly.map((product: any) => <ProductCard key={product.id} product={product} steps={countByProduct[product.id] ?? 0} isLabOnly />)}
          </div>
        </section>
      )}

      {allProducts.length === 0 && (
        <div className="card p-12 text-center text-ink-light">
          Chưa có sản phẩm nào. · No products yet.
        </div>
      )}
    </div>
  );
}

function ProductCard({ product, steps, isLabOnly = false }: {
  product: { id: string; name_vi: string; name_en?: string | null; main_image_url?: string | null; sku?: string | null };
  steps: number;
  isLabOnly?: boolean;
}) {
  return (
    <Link
      href={`/admin/fiches/${product.id}`}
      className="card p-4 flex items-center gap-4 hover:bg-cream/60 transition-colors group"
      style={isLabOnly ? { borderColor: '#DDD6FE' } : undefined}
    >
      {product.main_image_url ? (
        <img src={product.main_image_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
      ) : (
        <div className="w-12 h-12 rounded-lg bg-border-soft flex items-center justify-center shrink-0">
          <BookOpen size={20} className="text-ink-light" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-navy truncate">{product.name_vi}</div>
        {product.name_en && <div className="text-xs text-ink-light truncate">{product.name_en}</div>}
        <div className="flex items-center gap-2 mt-1">
          {product.sku && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-light">
              <Tag size={9} />{product.sku}
            </span>
          )}
          {steps === 0 ? (
            <span className="text-xs text-ink-light">Chưa có phiếu · No recipe yet</span>
          ) : (
            <span className="text-xs text-emerald-600 font-medium">{steps} bước / steps</span>
          )}
        </div>
      </div>
      <div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {steps === 0 ? (
          <span className="flex items-center gap-1 text-xs text-gold"><Plus size={14} /> Add</span>
        ) : (
          <span className="text-xs text-ink-light">Edit →</span>
        )}
      </div>
    </Link>
  );
}
