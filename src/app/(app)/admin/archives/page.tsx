import { createClient as createServiceClient } from '@supabase/supabase-js';
import { redirect } from 'next/navigation';
import { FolderArchive, Download, ShieldCheck } from 'lucide-react';
import { createClient, getSafeSession } from '@/lib/supabase-server';

export const revalidate = 0;

// Archives (Axel, 2026-09-19) — page de téléchargement des exports mensuels et des sauvegardes
// hebdo déposés dans le bucket privé `lab-archives` par /api/lab/archive-monthly, plus l'état de
// la rétention (horizons par table, derniers runs de purge). Lecture seule, admin/lab_manager.
// Les liens sont des URLs signées valables 1 h (le bucket n'est pas public).

type FileRow = { path: string; name: string; size: number; updated: string | null; url: string | null };
type MonthGroup = { month: string; files: FileRow[] };

const THEME_LABEL: Record<string, string> = {
  'production-equipes': 'Production par équipe (cartes chef + résumé quotidien)',
  'commandes-speciales': 'Commandes spéciales (gâteaux manuels, anniversaires, en ligne lab)',
  'ventes-en-ligne': 'Ventes en ligne (commandes + lignes)',
  'ecarts-livraison': 'Écarts de livraison (contrôle lab + réception boutique)',
  'pertes': 'Pertes (boutiques + lab)',
  'inventaires-lab': 'Inventaires lab (une feuille par session)',
};

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}
function vn(v: string | null | undefined): string {
  if (!v) return '';
  return new Date(new Date(v).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export default async function ArchivesPage() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) redirect('/dashboard');

  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

  const months: MonthGroup[] = [];
  const backups: { day: string; files: FileRow[] }[] = [];
  let storageError: string | null = null;

  if (service) {
    const bucket = service.storage.from('lab-archives');
    const sign = async (paths: string[]) => {
      if (!paths.length) return new Map<string, string>();
      const { data } = await bucket.createSignedUrls(paths, 3600);
      return new Map((data ?? []).filter(d => d.signedUrl && d.path).map(d => [d.path as string, d.signedUrl]));
    };
    const { data: years, error } = await bucket.list('', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
    if (error) storageError = error.message;
    for (const y of years ?? []) {
      if (!/^\d{4}$/.test(y.name)) continue;
      const { data: ms } = await bucket.list(y.name, { limit: 100, sortBy: { column: 'name', order: 'desc' } });
      for (const m of ms ?? []) {
        if (!/^\d{4}-\d{2}$/.test(m.name)) continue;
        const { data: fs } = await bucket.list(`${y.name}/${m.name}`, { limit: 100, sortBy: { column: 'name', order: 'asc' } });
        const paths = (fs ?? []).map(f => `${y.name}/${m.name}/${f.name}`);
        const urls = await sign(paths);
        months.push({
          month: m.name,
          files: (fs ?? []).map(f => ({
            path: `${y.name}/${m.name}/${f.name}`, name: f.name,
            size: Number((f.metadata as any)?.size ?? 0), updated: f.updated_at ?? null,
            url: urls.get(`${y.name}/${m.name}/${f.name}`) ?? null,
          })),
        });
      }
    }
    const { data: days } = await bucket.list('sauvegarde', { limit: 20, sortBy: { column: 'name', order: 'desc' } });
    for (const d of (days ?? []).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 8)) {
      const { data: fs } = await bucket.list(`sauvegarde/${d.name}`, { limit: 50 });
      const paths = (fs ?? []).map(f => `sauvegarde/${d.name}/${f.name}`);
      const urls = await sign(paths);
      backups.push({
        day: d.name,
        files: (fs ?? []).map(f => ({ path: `sauvegarde/${d.name}/${f.name}`, name: f.name, size: Number((f.metadata as any)?.size ?? 0), updated: f.updated_at ?? null, url: urls.get(`sauvegarde/${d.name}/${f.name}`) ?? null })),
      });
    }
  }

  const [{ data: policy }, { data: runs }] = await Promise.all([
    supabase.from('lab_retention_policy').select('table_name, date_column, horizon_days, enabled, note').order('horizon_days', { ascending: false }),
    supabase.from('lab_retention_runs').select('run_at, dry_run, deleted, error').order('run_at', { ascending: false }).limit(5),
  ]);

  months.sort((a, b) => b.month.localeCompare(a.month));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl text-navy flex items-center gap-2"><FolderArchive size={22} /> Archives</h1>
          <p className="text-sm text-gray-500 mt-1">
            Exports mensuels générés le 1er de chaque mois (mois précédent, un fichier par thème) et sauvegardes hebdomadaires des données conservées à vie. Liens valables 1 h.
          </p>
        </div>
      </div>

      {storageError && <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm p-3">Bucket illisible : {storageError}</div>}

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Exports mensuels</h2>
        {months.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-500">
            Aucun export encore. Le premier fichier apparaîtra le 1er du mois prochain (ou après un lancement manuel de <code>/api/lab/archive-monthly?month=YYYY-MM</code>).
          </div>
        )}
        {months.map(g => (
          <details key={g.month} open={g === months[0]} className="rounded-xl border border-gray-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 font-medium flex items-center justify-between">
              <span>{g.month}</span>
              <span className="text-xs text-gray-400">{g.files.length} fichier{g.files.length > 1 ? 's' : ''}</span>
            </summary>
            <ul className="divide-y divide-gray-100">
              {g.files.map(f => {
                const theme = f.name.replace(/^\d{4}-\d{2}_/, '').replace(/\.xlsx$/, '');
                return (
                  <li key={f.path} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{f.name}</div>
                      <div className="text-xs text-gray-500">{THEME_LABEL[theme] ?? theme}{f.updated ? ` · ${vn(f.updated)}` : ''}{f.size ? ` · ${fmtSize(f.size)}` : ''}</div>
                    </div>
                    {f.url ? (
                      <a href={f.url} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium hover:bg-cream" download={f.name}>
                        <Download size={14} /> Télécharger
                      </a>
                    ) : <span className="text-xs text-gray-400">lien indisponible</span>}
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Sauvegardes hebdomadaires (8 dernières)</h2>
        {backups.length === 0 && <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-500">Aucune sauvegarde encore (dimanche soir).</div>}
        {backups.map(b => (
          <details key={b.day} className="rounded-xl border border-gray-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium flex items-center justify-between">
              <span>{b.day}</span><span className="text-xs text-gray-400">{b.files.length} fichiers</span>
            </summary>
            <ul className="divide-y divide-gray-100">
              {b.files.map(f => (
                <li key={f.path} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <span className="flex-1 truncate">{f.name} <span className="text-xs text-gray-400">{fmtSize(f.size)}</span></span>
                  {f.url && <a href={f.url} className="text-xs font-medium underline" download={f.name}>Télécharger</a>}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 flex items-center gap-2"><ShieldCheck size={16} /> Rétention (purge quotidienne glissante, 03:00)</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase tracking-wide">
              <tr><th className="text-left px-3 py-2">Table</th><th className="text-left px-3 py-2">Horizon</th><th className="text-left px-3 py-2">Note</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(policy ?? []).map(p => (
                <tr key={p.table_name} className={p.enabled ? '' : 'opacity-50'}>
                  <td className="px-3 py-2 font-mono text-xs">{p.table_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{p.horizon_days >= 30 ? `${Math.round(p.horizon_days / 30)} mois` : `${p.horizon_days} j`}{p.enabled ? '' : ' (désactivé)'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500">
          Jamais purgé : fiches techniques, résumé quotidien de production, ventes en ligne (commandes, lignes, ledger des gâteaux), base client, comptages de stock boutique, produits hors production, seuils, configuration.
        </p>
        {(runs ?? []).length > 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-3 text-xs space-y-1">
            <div className="font-medium text-gray-700">Derniers runs</div>
            {(runs ?? []).map((r, i) => (
              <div key={i} className="font-mono text-gray-600">
                {vn(r.run_at)}{r.dry_run ? ' (simulation)' : ''}{r.error ? ` — ERREUR ${r.error}` : ''} · {Object.entries((r.deleted ?? {}) as Record<string, unknown>).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k.replace(/^lab_/, '')}=${v}`).join(' ') || 'rien à supprimer'}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
