import type { SupabaseClient } from '@supabase/supabase-js';

// Photos of "new product" suggestions (bucket lab-design-photos, raw-requests/<day>/<uuid>.jpg) that no
// purchase request line points to any more: the request was deleted, or the chef uploaded a photo and
// never sent the request (Axel, 2026-10-09: "enlève les 2 photos aussi"). Only files older than
// `minAgeMin` minutes, so a photo a chef is about to send is never touched.
export async function cleanupRawRequestPhotos(db: SupabaseClient, opts: { dry?: boolean; minAgeMin?: number } = {}) {
  const minAge = Date.now() - (opts.minAgeMin ?? 60) * 60000;
  const bucket = db.storage.from('lab-design-photos');
  const { data: days, error } = await bucket.list('raw-requests', { limit: 1000 });
  if (error) return { error: error.message, candidates: 0, deleted: 0 };
  const files: string[] = [];
  for (const d of days ?? []) {
    if (d.id) continue; // a file at the top level, not a day folder
    const { data: fs } = await bucket.list(`raw-requests/${d.name}`, { limit: 1000 });
    for (const f of fs ?? []) {
      const t = new Date((f as any).created_at ?? 0).getTime();
      if (f.id && t && t < minAge) files.push(`raw-requests/${d.name}/${f.name}`);
    }
  }
  if (!files.length) return { candidates: 0, deleted: 0 };
  const { data: used } = await db.from('lab_purchase_request_lines').select('photo_url').not('photo_url', 'is', null).limit(10000);
  const usedSet = new Set((used ?? []).map(u => {
    const m = String(u.photo_url ?? '').match(/\/lab-design-photos\/(.+?)(\?.*)?$/);
    return m?.[1] ? decodeURIComponent(m[1]) : '';
  }));
  const orphans = files.filter(p => !usedSet.has(p));
  if (opts.dry || !orphans.length) return { candidates: orphans.length, deleted: 0, paths: orphans };
  let deleted = 0; const errors: string[] = [];
  for (let i = 0; i < orphans.length; i += 100) {
    const { error: e } = await bucket.remove(orphans.slice(i, i + 100));
    if (e) errors.push(e.message); else deleted += orphans.slice(i, i + 100).length;
  }
  return { candidates: orphans.length, deleted, errors, paths: orphans };
}
