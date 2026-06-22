import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Plus, Tag } from 'lucide-react';

export const revalidate = 0;

export default async function FichesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [{ data: categories }, { data: products }, { data: stepCounts }] = await Promise.all([
    supabase.from('categories').select('id, name_vi, name_en').order('sort_order'),
    supabase
      .from('products')
      .select('id, name_vi, name_en, main_image_url, sku, is_lab_only, category_id, subcategory')
      .or('is_active.eq.true,is_lab_only.eq.true')
      .order('name_vi'),
    supabase.from('lab_fiche_steps').select('product_id'),
  ]);

  const countByProduct: Record<string, number> = {};
  for (const s of stepCounts ?? []) {
    countByProduct[s.product_id] = (countByProduct[s.product_id] ?? 0) + 1;
  }

  const allProducts = products ?? [];
  const catMap = new Map((categories ?? []).map(c => [c.id, c]));

  const catalogue = allProducts.filter((p: any) => !p.is_lab_only);
  const labOnly   = allProducts.filter((p: any) => p.is_lab_only);

  // Group a list of products by category → subcategory
  function groupByCatSub(items: typeof allProducts) {
    const catGroups = new Map<string, {
      catName_vi: string;
      catName_en: string;
      subGroups: Map<string, typeof allProducts>;
    }>();
    for (const p of items) {
      const cat = catMap.get((p as any).category_id ?? '') ?? { id: 'other', name_vi: 'Khác', name_en: 'Other' };
      const sub = (p as any).subcategory ?? '';
      if (!catGroups.has(cat.id)) {
        catGroups.set(cat.id, { catName_vi: cat.name_vi, catName_en: cat.name_en, subGroups: new Map() });
      }
      const sg = catGroups.get(cat.id)!.subGroups;
      if (!sg.has(sub)) sg.set(sub, []);
      sg.get(sub)!.push(p);
    }
    return catGroups;
  }

  const catCatalogue = groupByCatSub(catalogue);
  const catLabOnly   = groupByCatSub(labOnly);

  function renderGrouped(
    grouped: ReturnType<typeof groupByCatSub>,
    isLabOnly = false,
  ) {
    return Array.from(grouped.entries()).map(([catId, { catName_vi, catName_en, subGroups }]) => (
      <section key={catId} className="mt-6 first:mt-0">
        {/* Category divider */}
        <div className="flex items-center gap-3 mb-3">
          <div className="h-px flex-1 bg-border-soft" />
          <h2 className="text-xs font-bold uppercase tracking-widest text-ink-light px-1 shrink-0">
            {catName_vi} · {catName_en}
          </h2>
          <div className="h-px flex-1 bg-border-soft" />
        </div>

        {Array.from(subGroups.entries()).map(([sub, subProducts]) => (
          <div key={sub} className="mb-4">
            {sub && (
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-ink-light mb-2 ml-1">
                {sub}
              </h3>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {subProducts.map((product: any) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  steps={countByProduct[product.id] ?? 0}
                  isLabOnly={isLabOnly}
                />
              ))}
            </div>
          </div>
        ))}
      </section>
    ));
  }

  return (
    <div className="space-y-2 max-w-4xl">
      <div className="mb-6">
        <h1 className="font-serif text-3xl font-bold text-navy">Phiếu kỹ thuật / Recipe Cards</h1>
        <p className="text-sm text-ink-light mt-1">
          Tạo hướng dẫn sản xuất từng bước cho mỗi sản phẩm · Step-by-step production guides per product
        </p>
      </div>

      {/* Catalogue products — grouped by category/subcategory */}
      {catalogue.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-ink-light mb-1">
            Catalogue public · {catalogue.length} produits
          </p>
          {renderGrouped(catCatalogue, false)}
        </div>
      )}

      {/* Lab-only products — grouped by category/subcategory */}
      {labOnly.length > 0 && (
        <div className="mt-10">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#6D28D9' }}>
              Lab Only / B2B · {labOnly.length} produits
            </span>
            <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>
              Non visible sur catalogue
            </span>
          </div>
          {renderGrouped(catLabOnly, true)}
        </div>
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
