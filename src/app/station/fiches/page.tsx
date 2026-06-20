import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, ChevronRight } from 'lucide-react';

export const revalidate = 30;

export default async function StationFichesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Fetch categories + products + step counts
  const [{ data: categories }, { data: products }, { data: stepCounts }] = await Promise.all([
    supabase.from('categories').select('id, name_vi, name_en').order('sort_order'),
    supabase.from('products').select('id, name_vi, name_en, main_image_url, sku, category_id, subcategory').eq('is_active', true).order('name_vi'),
    supabase.from('lab_fiche_steps').select('product_id'),
  ]);

  // Count steps per product
  const countByProduct: Record<string, number> = {};
  for (const s of stepCounts ?? []) {
    countByProduct[s.product_id] = (countByProduct[s.product_id] ?? 0) + 1;
  }

  // Only show products that have at least one fiche step
  const productsWithFiche = (products ?? []).filter(p => (countByProduct[p.id] ?? 0) > 0);

  // Group by category
  const catMap = new Map((categories ?? []).map(c => [c.id, c]));
  const grouped: Map<string, { catName_vi: string; catName_en: string; products: typeof productsWithFiche }> = new Map();

  for (const p of productsWithFiche) {
    const cat = catMap.get(p.category_id ?? '') ?? { id: 'other', name_vi: 'Khác', name_en: 'Other' };
    if (!grouped.has(cat.id)) {
      grouped.set(cat.id, { catName_vi: cat.name_vi, catName_en: cat.name_en, products: [] });
    }
    grouped.get(cat.id)!.products.push(p);
  }

  // Group by subcategory within each category
  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <header className="bg-navy text-white px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gold flex items-center justify-center shrink-0">
            <BookOpen size={16} className="text-navy" />
          </div>
          <div>
            <div className="font-serif font-bold text-sm">Phiếu Kỹ Thuật</div>
            <div className="text-white/60 text-[11px]">Recipe Cards — La Parisienne</div>
          </div>
        </div>
        <Link href="/station/me" className="text-white/70 text-xs hover:text-white transition-colors">
          ← {`Ma station`}
        </Link>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-8 pb-16">
        {grouped.size === 0 && (
          <div className="card p-12 text-center text-ink-light">
            <BookOpen size={40} className="mx-auto mb-3 text-border-soft" />
            <p className="font-medium">Chưa có phiếu kỹ thuật nào.</p>
            <p className="text-sm mt-1">Aucune fiche technique disponible.</p>
          </div>
        )}

        {Array.from(grouped.entries()).map(([catId, { catName_vi, catName_en, products: catProducts }]) => {
          // Group by subcategory
          const subMap = new Map<string, typeof catProducts>();
          for (const p of catProducts) {
            const sub = p.subcategory ?? '';
            if (!subMap.has(sub)) subMap.set(sub, []);
            subMap.get(sub)!.push(p);
          }

          return (
            <section key={catId}>
              {/* Category header */}
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-border-soft" />
                <h2 className="text-xs font-bold uppercase tracking-widest text-ink-light px-2 shrink-0">
                  {catName_vi} · {catName_en}
                </h2>
                <div className="h-px flex-1 bg-border-soft" />
              </div>

              {Array.from(subMap.entries()).map(([sub, subProducts]) => (
                <div key={sub} className="mb-5">
                  {sub && (
                    <h3 className="text-xs font-semibold text-ink-light mb-2 ml-1 uppercase tracking-wide">
                      {sub}
                    </h3>
                  )}
                  <div className="space-y-2">
                    {subProducts.map(product => {
                      const steps = countByProduct[product.id] ?? 0;
                      return (
                        <Link
                          key={product.id}
                          href={`/station/fiche/${product.id}?back=/station/fiches`}
                          className="flex items-center gap-4 bg-white rounded-2xl px-4 py-3 shadow-sm border border-border-soft hover:border-gold/30 hover:shadow-md transition-all group"
                        >
                          {(product as any).main_image_url ? (
                            <img src={(product as any).main_image_url} alt=""
                              className="w-12 h-12 rounded-xl object-cover shrink-0" loading="lazy" />
                          ) : (
                            <div className="w-12 h-12 rounded-xl bg-cream flex items-center justify-center shrink-0">
                              <span className="text-2xl">🥐</span>
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-navy text-sm truncate">{product.name_vi}</div>
                            {product.name_en && <div className="text-xs text-ink-light truncate">{product.name_en}</div>}
                            <div className="text-xs text-emerald-600 font-medium mt-0.5">
                              {steps} {steps === 1 ? 'étape' : 'étapes'} · {steps} bước
                            </div>
                          </div>
                          <ChevronRight size={16} className="text-ink-light group-hover:text-navy transition-colors shrink-0" />
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
