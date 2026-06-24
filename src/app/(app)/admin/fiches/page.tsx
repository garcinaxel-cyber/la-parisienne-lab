import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Plus, Tag } from 'lucide-react';

export const revalidate = 0;

async function createFiche() {
  'use server';
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');
  const { data } = await supabase
    .from('lab_fiche_meta')
    .insert({ name_vi: 'Nouveau produit / New product', is_active: true })
    .select('id')
    .single();
  if (data?.id) redirect(`/admin/fiches/${data.id}`);
}

export default async function FichesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const [{ data: fiches }, { data: stepCounts }] = await Promise.all([
    supabase
      .from('lab_fiche_meta')
      .select('id, name_vi, name_en, image_url, category, teams, b2c_sku_ref')
      .eq('is_active', true)
      .order('name_vi'),
    supabase.from('lab_fiche_steps').select('fiche_id'),
  ]);

  const countByFiche: Record<string, number> = {};
  for (const s of stepCounts ?? []) {
    countByFiche[s.fiche_id] = (countByFiche[s.fiche_id] ?? 0) + 1;
  }

  const allFiches = fiches ?? [];

  // Group by category text
  const catGroups = new Map<string, typeof allFiches>();
  for (const f of allFiches) {
    const cat = (f as any).category ?? 'Khác';
    if (!catGroups.has(cat)) catGroups.set(cat, []);
    catGroups.get(cat)!.push(f);
  }

  return (
    <div className="space-y-2 max-w-4xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-serif text-3xl font-bold text-navy">Phiếu kỹ thuật / Recipe Cards</h1>
          <p className="text-sm text-ink-light mt-1">
            {allFiches.length} fiches · Tạo hướng dẫn sản xuất từng bước · Step-by-step production guides
          </p>
        </div>
        <form action={createFiche}>
          <button type="submit"
            className="btn-primary flex items-center gap-2 shrink-0">
            <Plus size={15} /> Tạo mới · New
          </button>
        </form>
      </div>

      {Array.from(catGroups.entries()).map(([cat, items]) => (
        <section key={cat} className="mt-6 first:mt-0">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-px flex-1 bg-border-soft" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-light px-1 shrink-0">
              {cat}
            </h2>
            <div className="h-px flex-1 bg-border-soft" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((fiche: any) => (
              <FicheCard
                key={fiche.id}
                fiche={fiche}
                steps={countByFiche[fiche.id] ?? 0}
              />
            ))}
          </div>
        </section>
      ))}

      {allFiches.length === 0 && (
        <div className="card p-12 text-center text-ink-light">
          Chưa có fiche nào. · No recipe cards yet.
        </div>
      )}
    </div>
  );
}

function FicheCard({ fiche, steps }: {
  fiche: { id: string; name_vi: string; name_en?: string | null; image_url?: string | null; b2c_sku_ref?: string | null };
  steps: number;
}) {
  return (
    <Link
      href={`/admin/fiches/${fiche.id}`}
      className="card p-4 flex items-center gap-4 hover:bg-cream/60 transition-colors group"
    >
      {fiche.image_url ? (
        <img src={fiche.image_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
      ) : (
        <div className="w-12 h-12 rounded-lg bg-border-soft flex items-center justify-center shrink-0">
          <BookOpen size={20} className="text-ink-light" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-navy truncate">{fiche.name_vi}</div>
        {fiche.name_en && <div className="text-xs text-ink-light truncate">{fiche.name_en}</div>}
        <div className="flex items-center gap-2 mt-1">
          {fiche.b2c_sku_ref && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-light">
              <Tag size={9} />{fiche.b2c_sku_ref}
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
