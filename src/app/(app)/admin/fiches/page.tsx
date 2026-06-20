import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Plus } from 'lucide-react';

export const revalidate = 0;

export default async function FichesPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  // Get all products that have at least one lab_assignment (i.e., they've been imported)
  // Plus all products from the catalogue for reference
  const { data: products } = await supabase
    .from('products')
    .select('id, name_vi, name_en, image_url, sku')
    .order('name_vi');

  // Count steps per product
  const { data: stepCounts } = await supabase
    .from('lab_fiche_steps')
    .select('product_id');

  const countByProduct: Record<string, number> = {};
  for (const s of stepCounts ?? []) {
    countByProduct[s.product_id] = (countByProduct[s.product_id] ?? 0) + 1;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl font-bold text-navy">Phiếu kỹ thuật / Recipe Cards</h1>
        <p className="text-sm text-ink-light mt-1">
          Tạo hướng dẫn sản xuất từng bước cho mỗi sản phẩm · Step-by-step production guides per product
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(products ?? []).map(product => {
          const steps = countByProduct[product.id] ?? 0;
          return (
            <Link
              key={product.id}
              href={`/admin/fiches/${product.id}`}
              className="card p-4 flex items-center gap-4 hover:bg-cream/60 transition-colors group"
            >
              {product.image_url ? (
                <img src={product.image_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
              ) : (
                <div className="w-12 h-12 rounded-lg bg-border-soft flex items-center justify-center shrink-0">
                  <BookOpen size={20} className="text-ink-light" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-navy truncate">{product.name_vi}</div>
                {product.name_en && <div className="text-xs text-ink-light truncate">{product.name_en}</div>}
                <div className="text-xs mt-1">
                  {steps === 0 ? (
                    <span className="text-ink-light">Chưa có phiếu · No recipe yet</span>
                  ) : (
                    <span className="text-emerald-600 font-medium">{steps} bước / steps</span>
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
        })}
      </div>

      {(products ?? []).length === 0 && (
        <div className="card p-12 text-center text-ink-light">
          Chưa có sản phẩm nào trong catalogue.
        </div>
      )}
    </div>
  );
}
