'use client';
export const dynamic = 'force-dynamic';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BookOpen, ChevronRight, AlertCircle } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';

type Fiche = {
  id: string;
  name_vi: string;
  name_en: string | null;
  image_url: string | null;
  category: string | null;
  teams: string[] | null;
  stepCount: number;
};

export default function StationFichesPage() {
  const [fiches, setFiches] = useState<Fiche[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCat, setSelectedCat] = useState('');
  const [lang, setLang] = useState<'vi' | 'en'>('vi');
  const searchParams = useSearchParams();
  const teamParam = searchParams.get('team');
  const [isReadOnly, setIsReadOnly] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setLang((localStorage.getItem('lab-lang') as 'vi' | 'en') || 'vi');
    }
  }, []);

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { window.location.href = '/login'; return; }

      const [{ data: profile }, { data: labProfile }] = await Promise.all([
        supabase.from('profiles').select('role').eq('id', session.user.id).single(),
        supabase.from('lab_profiles').select('team').eq('id', session.user.id).single(),
      ]);

      const role = profile?.role ?? '';
      const isAdmin = ['admin', 'lab_manager'].includes(role);
      // Workers can see fiches but cannot edit them
      const isWorker = role === 'worker';
      setIsReadOnly(isWorker);
      const userTeam = labProfile?.team;

      let query = supabase
        .from('lab_fiche_meta')
        .select('id, name_vi, name_en, image_url, category, teams')
        .eq('is_active', true);

      const filterTeam = teamParam ?? (!isAdmin ? userTeam : null);
      if (filterTeam) {
        query = query.contains('teams', [filterTeam]);
      }

      const { data: fichesRaw, error } = await query.order('name_vi');
      if (error) console.error('fiches query error:', error);
      const allFiches = fichesRaw ?? [];
      const ficheIds = allFiches.map(f => f.id);

      const { data: stepRows } = ficheIds.length > 0
        ? await supabase.from('lab_fiche_steps').select('fiche_id').in('fiche_id', ficheIds)
        : { data: [] as { fiche_id: string }[] };

      const countByFiche: Record<string, number> = {};
      for (const s of stepRows ?? []) {
        countByFiche[s.fiche_id] = (countByFiche[s.fiche_id] ?? 0) + 1;
      }

      setFiches(allFiches.map(f => ({ ...f, stepCount: countByFiche[f.id] ?? 0 })));
      setLoading(false);
    }
    load();
  }, []);

  const categories = Array.from(new Set(fiches.map(f => f.category ?? 'Khác'))).sort();
  const filtered = selectedCat ? fiches.filter(f => (f.category ?? 'Khác') === selectedCat) : fiches;

  const catGroups = new Map<string, Fiche[]>();
  for (const f of filtered) {
    const cat = f.category ?? 'Khác';
    if (!catGroups.has(cat)) catGroups.set(cat, []);
    catGroups.get(cat)!.push(f);
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#FFF4CC' }}>
      <header style={{ backgroundColor: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}
        className="sticky top-0 z-10 px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'rgba(201,168,76,0.25)' }}>
            <BookOpen size={16} className="text-white" />
          </div>
          <div>
            <div className="font-bold text-sm text-white flex items-center gap-2">
              Phiếu Kỹ Thuật
            </div>
            <div className="text-white/60 text-[11px]">Recipe Cards — La Parisienne</div>
          </div>
        </div>
        <Link href={teamParam ? `/station/${teamParam}` : '/station/me'} className="text-white/70 text-xs hover:text-white transition-colors">
          ← {lang === 'vi' ? 'Trạm' : 'Station'}
        </Link>
      </header>

      {categories.length > 1 && (
        <div className="px-4 pt-4 flex gap-2 flex-wrap">
          <button onClick={() => setSelectedCat('')}
            className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
            style={selectedCat === ''
              ? { backgroundColor: '#1A4731', color: 'white' }
              : { backgroundColor: 'white', color: '#1A4731', border: '1px solid #C9A84C' }}>
            {lang === 'vi' ? 'Tất cả' : 'All'} ({fiches.length})
          </button>
          {categories.map(cat => (
            <button key={cat} onClick={() => setSelectedCat(cat === selectedCat ? '' : cat)}
              className="px-3 py-1.5 rounded-full text-xs font-bold transition-colors"
              style={selectedCat === cat
                ? { backgroundColor: '#1A4731', color: 'white' }
                : { backgroundColor: 'white', color: '#1A4731', border: '1px solid #C9A84C' }}>
              {cat} ({fiches.filter(f => (f.category ?? 'Khác') === cat).length})
            </button>
          ))}
        </div>
      )}

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-8 pb-16">
        {loading && (
          <div className="text-center py-20 text-sm font-semibold" style={{ color: '#1A4731' }}>
            {lang === 'vi' ? 'Đang tải…' : 'Loading…'}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="rounded-2xl p-12 text-center bg-white" style={{ border: '1px solid #E0D49A' }}>
            <BookOpen size={40} className="mx-auto mb-3" style={{ color: '#C9A84C' }} />
            <p className="font-semibold" style={{ color: '#1A4731' }}>
              {lang === 'vi' ? 'Chưa có phiếu kỹ thuật.' : 'No recipe cards yet.'}
            </p>
            <p className="text-sm mt-1 text-gray-400">
              {lang === 'vi'
                ? 'Admin cần gán sản phẩm vào đội của bạn trong mục Phiếu Kỹ Thuật.'
                : 'Admin needs to assign products to your team in the Recipe Cards section.'}
            </p>
          </div>
        )}

        {Array.from(catGroups.entries()).map(([cat, items]) => (
          <section key={cat}>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1" style={{ backgroundColor: '#C9A84C', opacity: 0.3 }} />
              <h2 className="text-xs font-bold uppercase tracking-widest px-2 shrink-0" style={{ color: '#1A4731' }}>
                {cat}
              </h2>
              <div className="h-px flex-1" style={{ backgroundColor: '#C9A84C', opacity: 0.3 }} />
            </div>
            <div className="space-y-2">
              {items.map(fiche => (
                <Link
                  key={fiche.id}
                  href={`/station/fiche/${fiche.id}?back=/station/fiches`}
                  className="flex items-center gap-4 bg-white rounded-2xl px-4 py-3 group transition-all"
                  style={{ border: '1px solid #E0D49A', boxShadow: '0 1px 4px rgba(26,71,49,0.07)' }}
                >
                  {fiche.image_url ? (
                    <img src={fiche.image_url} alt=""
                      className="w-12 h-12 rounded-xl object-cover shrink-0"
                      style={{ border: '1px solid #E0D49A' }} loading="lazy" />
                  ) : (
                    <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-2xl"
                      style={{ backgroundColor: '#FFF4CC' }}>🥐</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate" style={{ color: '#1A4731' }}>
                      {lang === 'vi' ? fiche.name_vi : (fiche.name_en || fiche.name_vi)}
                    </div>
                    {fiche.name_en && lang === 'vi' && (
                      <div className="text-xs truncate" style={{ color: '#8a8a8a' }}>{fiche.name_en}</div>
                    )}
                    <div className="text-xs font-medium mt-0.5" style={{ color: fiche.stepCount > 0 ? '#2D6A4F' : '#aaa' }}>
                      {fiche.stepCount > 0
                        ? `${fiche.stepCount} ${lang === 'vi' ? 'bước' : 'steps'}`
                        : (lang === 'vi' ? 'Chưa có phiếu' : 'No recipe yet')}
                    </div>
                  </div>
                  <ChevronRight size={16} style={{ color: '#C9A84C' }} />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
