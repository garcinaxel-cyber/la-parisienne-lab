import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, Plus, Tag, Users } from 'lucide-react';
import { TEAMS, TEAM_LABELS, type Team } from '@/lib/types';

const hasTeam = (f: any) => Array.isArray(f.teams) && f.teams.length > 0;

// Builds a list URL preserving both filter axes (category + team) — used both for the filter
// chips themselves and for the ?back= param on each fiche link, so returning from a fiche
// (2026-08-26, Axel: "ça me remet à la page de début au lieu de la catégorie que j'avais
// sélectionné") lands back on the exact same filtered view instead of the bare unfiltered list.
function listHref(params: { cat?: string; team?: string }) {
  const sp = new URLSearchParams();
  if (params.cat) sp.set('cat', params.cat);
  if (params.team) sp.set('team', params.team);
  const qs = sp.toString();
  return `/admin/fiches${qs ? `?${qs}` : ''}`;
}

export const revalidate = 0;

async function createFiche(formData: FormData) {
  'use server';
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data } = await supabase
    .from('lab_fiche_meta')
    .insert({ name_vi: 'Nouveau produit / New product', is_active: true })
    .select('id')
    .single();
  const back = formData.get('back');
  if (data?.id) redirect(`/admin/fiches/${data.id}${back ? `?back=${encodeURIComponent(String(back))}` : ''}`);
}

export default async function FichesPage({ searchParams }: { searchParams?: { cat?: string; team?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
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
  const selectedCat = searchParams?.cat ?? '';
  // 'team' is either a real Team value, the literal 'none' (no team assigned at all), or empty (all)
  const selectedTeam = searchParams?.team ?? '';
  const noTeamCount = allFiches.filter((f: any) => !hasTeam(f)).length;
  const teamCounts: Record<Team, number> = TEAMS.reduce((acc, t) => {
    acc[t] = allFiches.filter((f: any) => (f.teams ?? []).includes(t)).length;
    return acc;
  }, {} as Record<Team, number>);

  // All unique categories for filter chips
  const allCats = Array.from(new Set(allFiches.map((f: any) => f.category ?? 'Khác'))).sort() as string[];

  // Filter then group
  let filtered = selectedCat ? allFiches.filter((f: any) => (f.category ?? 'Khác') === selectedCat) : allFiches;
  if (selectedTeam === 'none') filtered = filtered.filter((f: any) => !hasTeam(f));
  else if (selectedTeam) filtered = filtered.filter((f: any) => (f.teams ?? []).includes(selectedTeam));

  // Current filtered-list URL — passed as ?back= on every fiche link so coming back preserves it
  const currentListUrl = listHref({ cat: selectedCat, team: selectedTeam });

  const catGroups = new Map<string, typeof allFiches>();
  for (const f of filtered) {
    const cat = (f as any).category ?? 'Khác';
    if (!catGroups.has(cat)) catGroups.set(cat, []);
    catGroups.get(cat)!.push(f);
  }

  return (
    <div className="space-y-2 max-w-4xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-bold text-navy">Phiếu kỹ thuật / Recipe Cards</h1>
          <p className="text-sm text-ink-light mt-1">
            {allFiches.length} fiches · Tạo hướng dẫn sản xuất từng bước · Step-by-step production guides
          </p>
        </div>
        <form action={createFiche}>
          <input type="hidden" name="back" value={currentListUrl} />
          <button type="submit" className="btn-primary flex items-center gap-2 shrink-0">
            <Plus size={15} /> Tạo mới · New
          </button>
        </form>
      </div>

      {/* Team filter chips — filter by a specific team, or isolate fiches with no team at all
          (2026-08-26, Axel: "filtrer by team et récupérer si y a pas des produits sans équipes") */}
      <div className="flex gap-2 flex-wrap pb-2">
        <Link href={listHref({ cat: selectedCat })}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors border ${
            !selectedTeam ? 'bg-navy text-white border-navy' : 'bg-cream text-ink-light border-border-soft hover:border-navy/30'
          }`}>
          <Users size={12} /> Tất cả đội · All teams
        </Link>
        {TEAMS.map(t => {
          const meta = TEAM_LABELS[t];
          const active = selectedTeam === t;
          return (
            <Link key={t} href={listHref({ cat: selectedCat, team: t })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors border"
              style={active ? { backgroundColor: meta.color, borderColor: meta.color, color: '#fff' } : { backgroundColor: meta.bg, borderColor: meta.bg, color: meta.color }}>
              {meta.en} ({teamCounts[t]})
            </Link>
          );
        })}
        {noTeamCount > 0 && (
          <Link href={listHref({ cat: selectedCat, team: 'none' })}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-colors border ${
              selectedTeam === 'none' ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-400'
            }`}>
            <Users size={12} /> Chưa gán đội · No team ({noTeamCount})
          </Link>
        )}
      </div>

      {/* Category filter chips */}
      {allCats.length > 1 && (
        <div className="flex gap-2 flex-wrap pb-2">
          <Link href={listHref({ team: selectedTeam })}
            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${!selectedCat ? 'bg-navy text-white' : 'bg-cream text-ink-light border border-border-soft hover:border-navy/30'}`}>
            Tất cả · All ({allFiches.length})
          </Link>
          {allCats.map(cat => (
            <Link key={cat}
              href={listHref({ cat, team: selectedTeam })}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${selectedCat === cat ? 'bg-navy text-white' : 'bg-cream text-ink-light border border-border-soft hover:border-navy/30'}`}>
              {cat} ({allFiches.filter((f: any) => (f.category ?? 'Khác') === cat).length})
            </Link>
          ))}
        </div>
      )}

      {Array.from(catGroups.entries()).map(([cat, items]) => (
        <section key={cat} className="mt-4 first:mt-0">
          <div className="flex items-center gap-3 mb-3">
            <div className="h-px flex-1 bg-border-soft" />
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-light px-1 shrink-0">{cat}</h2>
            <div className="h-px flex-1 bg-border-soft" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((fiche: any) => (
              <FicheCard key={fiche.id} fiche={fiche} steps={countByFiche[fiche.id] ?? 0} backUrl={currentListUrl} />
            ))}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <div className="card p-12 text-center text-ink-light">
          {selectedTeam === 'none' ? 'Toutes les fiches ont une équipe assignée.'
            : selectedCat ? `Aucune fiche dans "${selectedCat}".` : 'Chưa có fiche nào. · No recipe cards yet.'}
        </div>
      )}
    </div>
  );
}

function FicheCard({ fiche, steps, backUrl }: {
  fiche: { id: string; name_vi: string; name_en?: string | null; image_url?: string | null; b2c_sku_ref?: string | null; teams?: string[] | null };
  steps: number;
  backUrl: string;
}) {
  const teams = Array.isArray(fiche.teams) ? fiche.teams : [];
  return (
    <Link
      href={`/admin/fiches/${fiche.id}?back=${encodeURIComponent(backUrl)}`}
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
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {fiche.b2c_sku_ref && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-ink-light">
              <Tag size={9} />{fiche.b2c_sku_ref}
            </span>
          )}
          {/* Teams — or a clear warning when none assigned */}
          {teams.length > 0 ? (
            teams.map(t => {
              const meta = TEAM_LABELS[t as Team];
              return (
                <span key={t} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                  style={{ backgroundColor: meta?.bg ?? '#F1EFE8', color: meta?.color ?? '#5F5E5A' }}>
                  {meta ? meta.en.replace('Team ', '') : t}
                </span>
              );
            })
          ) : (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
              <Users size={9} /> Chưa gán đội · No team
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
