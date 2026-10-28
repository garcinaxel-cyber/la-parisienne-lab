// Raw material & packaging photos (Axel, 2026-10-28: "mettre les photos raw materials et
// packaging odoo sur la lab app … inventaires, réceptions, packaging des shops").
// Source = the Odoo product photo, copied into storage as a light JPEG (lab_item_photos), so the
// app shows a plain image URL and never calls Odoo on screen. Refreshed by the weekly job when the
// Odoo product changed. Staff can add a photo where there is none (addItemPhoto) — it goes to the
// app at once and to Odoo in the background. Finished products are NOT handled here: their photo
// is the website's (photo-sync-odoo.ts).
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

const BUCKET = 'lab-images';
const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

export function itemPhotoService() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
type Db = NonNullable<ReturnType<typeof itemPhotoService>>;

function chunks<T>(a: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

async function toJpeg(buf: Buffer, size: number): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  return sharp(buf).rotate().resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
}

async function store(db: Db, tmplId: number, jpg: Buffer): Promise<string> {
  const path = `items/${tmplId}-${Date.now()}.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(path, jpg, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(error.message);
  return db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Template ids in scope: every raw material + every packaging item the shops can order. */
async function scopeTemplates(db: Db): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  const { data: raw } = await db.from('lab_raw_materials').select('tmpl_id, sku');
  for (const r of raw ?? []) if (r.tmpl_id) out.set(Number(r.tmpl_id), r.sku ?? null);
  const { data: pk } = await db.from('lab_excluded_skus').select('sku');
  const skus = (pk ?? []).map((r: any) => r.sku).filter(Boolean);
  for (const c of chunks(skus, 200)) {
    const rows = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', c]]], { fields: ['default_code', 'product_tmpl_id'] });
    for (const r of rows) if (r.product_tmpl_id?.[0]) out.set(r.product_tmpl_id[0], r.default_code);
  }
  return out;
}

export async function syncOdooItemPhotos(opts: { commit: boolean; budgetMs?: number }): Promise<{ ok: boolean; error?: string; scope: number; withOdooPhoto: number; toCopy: number; copied: number; failed: string[] }> {
  const db = itemPhotoService();
  if (!db) return { ok: false, error: 'Server not configured', scope: 0, withOdooPhoto: 0, toCopy: 0, copied: 0, failed: [] };
  const scope = await scopeTemplates(db);
  const ids = Array.from(scope.keys());
  const withPhoto: any[] = [];
  for (const c of chunks(ids, 300)) {
    withPhoto.push(...await odooExecute<any[]>('product.template', 'search_read', [[['id', 'in', c], ['image_128', '!=', false]]], { fields: ['id', 'default_code', 'write_date'] }));
  }
  const { data: existing } = await db.from('lab_item_photos').select('tmpl_id, odoo_write_date');
  const known = new Map<number, string | null>((existing ?? []).map((r: any) => [Number(r.tmpl_id), r.odoo_write_date ?? null]));
  const todo = withPhoto.filter(t => known.get(t.id) !== t.write_date);
  let copied = 0; const failed: string[] = [];
  if (opts.commit) {
    const t0 = Date.now();
    for (const c of chunks(todo, 10)) {
      if (opts.budgetMs && Date.now() - t0 > opts.budgetMs) break;
      const imgs = await odooExecute<any[]>('product.template', 'read', [c.map(t => t.id)], { fields: ['id', 'image_512', 'write_date'] });
      for (const im of imgs) {
        try {
          if (!im.image_512) continue;
          const jpg = await toJpeg(Buffer.from(im.image_512, 'base64'), 400);
          const url = await store(db, im.id, jpg);
          await db.from('lab_item_photos').upsert({ tmpl_id: im.id, sku: scope.get(im.id) ?? null, image_url: url, source: 'odoo', odoo_write_date: im.write_date, uploaded_at: new Date().toISOString() }, { onConflict: 'tmpl_id' });
          copied++;
        } catch (e: any) { failed.push(`${im.id}: ${String(e?.message ?? e).slice(0, 120)}`); }
      }
    }
  }
  return { ok: true, scope: ids.length, withOdooPhoto: withPhoto.length, toCopy: todo.length, copied, failed };
}

/** Staff photo for an item that has none (app first, Odoo in the background by the caller). */
export async function addItemPhoto(input: { tmplId: number; sku: string | null; data: Buffer; byName: string }): Promise<{ ok: true; url: string; odoo: () => Promise<void> } | { ok: false; error: string }> {
  const db = itemPhotoService();
  if (!db) return { ok: false, error: 'Server not configured' };
  const { data: row } = await db.from('lab_item_photos').select('tmpl_id').eq('tmpl_id', input.tmplId).maybeSingle();
  if (row) return { ok: false, error: 'Đã có ảnh · A photo already exists' };
  const small = await toJpeg(input.data, 400);
  const url = await store(db, input.tmplId, small);
  await db.from('lab_item_photos').insert({ tmpl_id: input.tmplId, sku: input.sku, image_url: url, source: 'staff', uploaded_by_name: input.byName });
  const big = await toJpeg(input.data, 1200);
  const odoo = async () => {
    if (!odooWriteConfigured()) return;
    try {
      // Odoo is only filled when it has no photo yet — never overwrites one.
      const [t] = await odooExecute<any[]>('product.template', 'search_read', [[['id', '=', input.tmplId], ['image_128', '=', false]]], { fields: ['id'] });
      if (!t) return;
      await odooExecuteWrite('product.template', 'write', [[input.tmplId], { image_1920: big.toString('base64') }], { context: NO_MAIL });
      await odooExecuteWrite('product.template', 'message_post', [[input.tmplId]], {
        body: `Photo ajoutée depuis la lab-app par ${input.byName} (aucune photo avant).`, message_type: 'comment', subtype_xmlid: 'mail.mt_note',
      });
      const [w] = await odooExecute<any[]>('product.template', 'read', [[input.tmplId]], { fields: ['write_date'] });
      await db.from('lab_item_photos').update({ odoo_write_date: w?.write_date ?? null }).eq('tmpl_id', input.tmplId);
    } catch (e) { console.error('[item-photo] odoo push failed', input.tmplId, e); }
  };
  return { ok: true, url, odoo };
}

/** tmpl_id → photo URL and SKU → photo URL, for screens. One small query (~500 rows). */
export async function loadItemPhotoMaps(db: Db): Promise<{ byTmpl: Map<number, string>; bySku: Map<string, string> }> {
  const { data } = await db.from('lab_item_photos').select('tmpl_id, sku, image_url');
  const byTmpl = new Map<number, string>(); const bySku = new Map<string, string>();
  for (const r of data ?? []) { byTmpl.set(Number(r.tmpl_id), r.image_url); if (r.sku) bySku.set(r.sku, r.image_url); }
  return { byTmpl, bySku };
}
