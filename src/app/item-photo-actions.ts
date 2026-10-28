'use server';
// Raw material / packaging photos for app screens (Axel, 2026-10-28). See lib/item-photos.ts.
import { waitUntil } from '@vercel/functions';
import { unstable_cache, revalidateTag } from 'next/cache';
import { rawActor } from '@/lib/raw-materials-db';
import { itemPhotoService, addItemPhoto } from '@/lib/item-photos';

// One light list (tmpl_id, sku, url) for the whole session — cached server-side 10 min, so the
// screens never wait on Odoo and the database is hit at most a few times an hour.
const cachedPhotos = unstable_cache(async () => {
  const db = itemPhotoService();
  if (!db) return [] as [number, string | null, string][];
  const { data } = await db.from('lab_item_photos').select('tmpl_id, sku, image_url');
  return (data ?? []).map((r: any) => [Number(r.tmpl_id), r.sku ?? null, r.image_url] as [number, string | null, string]);
}, ['item-photos-v1'], { revalidate: 600, tags: ['item-photos'] });

export async function getItemPhotosAction(): Promise<{ rows?: [number, string | null, string][]; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  return { rows: await cachedPhotos() };
}

// Staff photo where there is none (Axel: "s'il n'y a pas de photo, laisser la possibilité au
// staff de prendre une photo ou en importer une pour que ça actualise l'app et Odoo").
// Adding only — replacing an existing photo is not offered here.
export async function addItemPhotoAction(form: FormData): Promise<{ url?: string; error?: string }> {
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' };
  const tmplId = Number(form.get('tmplId'));
  const sku = String(form.get('sku') ?? '') || null;
  const file = form.get('file');
  if (!Number.isInteger(tmplId) || tmplId <= 0 || !(file instanceof Blob)) return { error: 'Bad request' };
  if (file.size > 6_000_000) return { error: 'Ảnh quá lớn · Photo too large' };
  if (!/^image\//.test(file.type || 'image/jpeg')) return { error: 'Không phải ảnh · Not an image' };
  try {
    const res = await addItemPhoto({ tmplId, sku, data: Buffer.from(await file.arrayBuffer()), byName: a.name || 'staff' });
    if (!res.ok) return { error: res.error };
    revalidateTag('item-photos');
    const p = res.odoo();
    try { waitUntil(p); } catch { await p; }
    return { url: res.url };
  } catch (e: any) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}
