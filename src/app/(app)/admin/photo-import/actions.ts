'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';

// One-time import of the website's product photos (bucket product-images) into the lab app's own
// bucket (lab-images). The list of what goes where is NOT computed here: it was frozen in
// lab_photo_import (supabase/lab_v99_photo_import.sql) at the moment Axel validated the preview,
// so what is imported is exactly what he saw. This file only (1) copies the files and (2) asks
// the database to switch each recipe card to its copy, which it does only when the copy really
// exists in storage and the card still shows the photo it had when the list was validated.
const SRC_BUCKET = 'product-images';
const DEST_BUCKET = 'lab-images';

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Forbidden' };
  return { userId: session.user.id };
}

export type PhotoImportRow = {
  id: string; grp: string; nameVi: string; sku: string | null;
  status: string; error: string | null; oldUrl: string | null; newUrl: string;
};
export type PhotoImportStatus = {
  error?: string;
  total: number; pending: number; copied: number; applied: number; skipped: number; failed: number;
  rows: PhotoImportRow[];
};

const EMPTY: PhotoImportStatus = { total: 0, pending: 0, copied: 0, applied: 0, skipped: 0, failed: 0, rows: [] };

export async function getPhotoImportStatusAction(): Promise<PhotoImportStatus> {
  const auth = await requireAdmin();
  if ('error' in auth) return { ...EMPTY, error: auth.error };
  const sb = service();
  if (!sb) return { ...EMPTY, error: 'Server is not configured for this action' };
  const { data, error } = await sb.from('lab_photo_import')
    .select('id, grp, name_vi, sku, status, error, old_url, new_url')
    .order('grp').order('name_vi').order('id').limit(1000);
  if (error) return { ...EMPTY, error: error.message };
  const rows: PhotoImportRow[] = (data ?? []).map((r: any) => ({
    id: r.id, grp: r.grp, nameVi: (r.name_vi ?? '').trim(), sku: r.sku ?? null,
    status: r.status, error: r.error ?? null, oldUrl: r.old_url ?? null, newUrl: r.new_url,
  }));
  const count = (s: string) => rows.filter(r => r.status === s).length;
  return {
    total: rows.length, pending: count('pending'), copied: count('copied'), applied: count('applied'),
    skipped: count('skipped'), failed: count('error'), rows,
  };
}

export type PhotoImportBatchResult = {
  error?: string; done: boolean; remaining: number;
  copied: number; failed: number; applied: number; skipped: number;
};

// Copies up to `limit` photos, then switches the recipe cards whose copy is confirmed in storage.
// Safe to call again at any time: a file that was already copied is simply recognised as such.
export async function runPhotoImportBatchAction(limit = 15): Promise<PhotoImportBatchResult> {
  const none: PhotoImportBatchResult = { done: false, remaining: 0, copied: 0, failed: 0, applied: 0, skipped: 0 };
  const auth = await requireAdmin();
  if ('error' in auth) return { ...none, error: auth.error };
  const sb = service();
  if (!sb) return { ...none, error: 'Server is not configured for this action' };
  const n = Math.max(1, Math.min(25, Math.floor(Number(limit) || 15)));

  const { data: rows, error: selErr } = await sb.from('lab_photo_import')
    .select('id, src_path, dest_path').eq('status', 'pending').order('created_at').order('id').limit(n);
  if (selErr) return { ...none, error: selErr.message };

  let copied = 0, failed = 0;
  const list = (rows ?? []) as { id: string; src_path: string; dest_path: string }[];
  const CHUNK = 5;
  for (let i = 0; i < list.length; i += CHUNK) {
    await Promise.all(list.slice(i, i + CHUNK).map(async r => {
      let problem: string | null = null;
      try {
        const { error } = await sb.storage.from(SRC_BUCKET).copy(r.src_path, r.dest_path, { destinationBucket: DEST_BUCKET });
        // "already exists" = this very file was copied by an earlier, interrupted run.
        if (error && !/already exists|duplicate/i.test(error.message ?? '')) problem = error.message || 'Copy failed';
      } catch (e) {
        problem = e instanceof Error ? e.message : 'Copy failed';
      }
      if (problem) {
        failed++;
        await sb.from('lab_photo_import').update({ status: 'error', error: problem.slice(0, 300) }).eq('id', r.id).eq('status', 'pending');
      } else {
        copied++;
        await sb.from('lab_photo_import').update({ status: 'copied', copied_at: new Date().toISOString(), error: null }).eq('id', r.id).eq('status', 'pending');
      }
    }));
  }

  const { data: ap, error: apErr } = await sb.rpc('lab_photo_import_apply');
  const first = Array.isArray(ap) ? ap[0] : ap;
  const applied = Number(first?.applied ?? 0), skipped = Number(first?.skipped ?? 0);

  const { count } = await sb.from('lab_photo_import').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  const remaining = count ?? 0;
  return { done: remaining === 0, remaining, copied, failed, applied, skipped, error: apErr?.message };
}

// Puts failed rows (and rows copied but not yet confirmed in storage) back in the queue.
export async function retryPhotoImportAction(): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const sb = service();
  if (!sb) return { error: 'Server is not configured for this action' };
  const { error } = await sb.from('lab_photo_import').update({ status: 'pending', error: null }).in('status', ['error', 'copied']);
  if (error) return { error: error.message };
  return { ok: true };
}
