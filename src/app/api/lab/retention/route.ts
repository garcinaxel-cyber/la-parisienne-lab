import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Rétention v2 (Axel, 2026-09-19) — purge quotidienne GLISSANTE, appelée par pg_cron
// (`lab-retention-daily`, 20:00 UTC = 03:00 VN) avec ?secret=CRON_SECRET, même pattern que
// stock-count-recap. Remplace l'ancien `lab_purge_old(60)` hebdomadaire (job lab-purge,
// désactivé le 2026-09-19).
//
// Ce que fait UNE exécution :
//   1. supprime dans le bucket `lab-design-photos` la photo de design des gâteaux manuels qui
//      vont être purgés (Axel : "l'image des design particuliers doit se purger aussi") — le
//      SQL ne peut pas toucher aux fichiers du storage, d'où ce passage côté Vercel ;
//   2. appelle `lab_purge_rolling()` : un horizon par table, lu dans `lab_retention_policy`
//      (modifiable en SQL, sans redéploiement). La fonction (ré)agrège lab_daily_stats avant de
//      supprimer une journée de lab_imports, et pose le flag `lab.purging` pour que le trigger du
//      ledger MARQUE (source_deleted_at) au lieu de supprimer la copie permanente.
//
// ?dry=1 → ne supprime rien, renvoie ce qui SERAIT supprimé (photos + comptes par table).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const dry = url.searchParams.get('dry') === '1';
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const startedAt = Date.now();

  // ── 1. Photos de design des gâteaux manuels sur le point d'être purgés ──
  const { data: policy } = await supabase.from('lab_retention_policy')
    .select('horizon_days, enabled').eq('table_name', 'lab_manual_cakes').maybeSingle();
  const photos = { candidates: 0, deleted: 0, errors: [] as string[] };
  if (policy?.enabled) {
    const cutoff = new Date(Date.now() - policy.horizon_days * 86400_000).toISOString().slice(0, 10);
    const { data: cakes } = await supabase.from('lab_manual_cakes')
      .select('id, design_photo_url').lt('delivery_date', cutoff).not('design_photo_url', 'is', null).limit(2000);
    const paths: { id: string; path: string }[] = [];
    for (const c of cakes ?? []) {
      // URL publique Supabase : .../storage/v1/object/public/lab-design-photos/<path>
      const m = String(c.design_photo_url ?? '').match(/\/lab-design-photos\/(.+?)(\?.*)?$/);
      if (m?.[1]) paths.push({ id: c.id, path: decodeURIComponent(m[1]) });
    }
    photos.candidates = paths.length;
    if (!dry && paths.length) {
      // Par lots de 100 (limite raisonnable de storage.remove)
      for (let i = 0; i < paths.length; i += 100) {
        const chunk = paths.slice(i, i + 100);
        const { error } = await supabase.storage.from('lab-design-photos').remove(chunk.map(p => p.path));
        if (error) { photos.errors.push(error.message); continue; }
        photos.deleted += chunk.length;
        await supabase.from('lab_manual_cake_ledger')
          .update({ design_photo_deleted_at: new Date().toISOString() })
          .in('id', chunk.map(p => p.id));
      }
    }
  }

  // ── 2. Purge SQL glissante ──
  const { data: deleted, error } = await supabase.rpc('lab_purge_rolling', { p_dry_run: dry });
  if (error) {
    console.error('[retention] lab_purge_rolling failed', error.message);
    return NextResponse.json({ ok: false, dry, photos, error: error.message }, { status: 502 });
  }
  const res = { ok: true, dry, photos, deleted, ms: Date.now() - startedAt };
  console.log('[retention]', JSON.stringify(res));
  return NextResponse.json(res);
}
