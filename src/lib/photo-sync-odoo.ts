// Website photos → Odoo (Axel, 2026-10-28: "les photos du site sont des photos officielles, faut
// pas que ce soit les photos lab app ou odoo qui prennent le dessus").
// One-way: the website tables (products / product_variants) are only READ. Matching is by SKU:
// every SKU of a website product (product + all its variants) gets that product's single photo,
// so e.g. Nappa (1 website photo, 25 SKUs) lands on its 5 Odoo templates (one per size).
// The photo is written on product.template.image_1920; a variant's own photo
// (image_variant_1920) is cleared so the variant shows the template's. Before replacing, the
// previous photo is kept as an ir.attachment on the same record (rollback). Archived Odoo
// products are ignored (Axel, 2026-10-28). Only changed photos are sent (lab_odoo_photo_sync).
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { odooExecute, odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

const NO_MAIL = { tracking_disable: true, mail_notrack: true, mail_create_nolog: true, mail_notify_force_send: false };

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export type PhotoSyncItem = {
  tmplId: number; tmplName: string; skus: string[]; webUrl: string;
  action: 'update' | 'unchanged' | 'conflict';
  hadPhoto?: boolean; variantPhotosCleared?: number; backupAttachmentId?: number | null; error?: string;
};
export type PhotoSyncResult = { ok: boolean; commit: boolean; error?: string; items: PhotoSyncItem[]; webSkus: number; notInOdoo: number };

function chunks<T>(a: T[], n: number): T[][] { const out: T[][] = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

// Converted to JPEG (max 1200 px) before sending: Odoo 18 stores a webp as-is and does not
// derive its small thumbnails from it (checked 28/10: image_128 = 100 KB), which would slow
// down Odoo's product lists. From a JPEG Odoo builds light 128/256/512 versions itself.
async function fetchBase64(url: string): Promise<{ b64: string; mime: string }> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`photo ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8_000_000) throw new Error('photo > 8 MB');
  const sharp = (await import('sharp')).default;
  const jpg = await sharp(buf).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { b64: jpg.toString('base64'), mime: 'image/jpeg' };
}

export async function syncWebsitePhotosToOdoo(opts: { skus?: string[]; commit: boolean; by: string; force?: boolean; budgetMs?: number }): Promise<PhotoSyncResult> {
  const db = service();
  if (!db) return { ok: false, commit: opts.commit, error: 'Server not configured', items: [], webSkus: 0, notInOdoo: 0 };
  if (opts.commit && !odooWriteConfigured()) return { ok: false, commit: true, error: 'Odoo write not configured', items: [], webSkus: 0, notInOdoo: 0 };

  // 1. Website SKU → photo (read-only).
  const { data: prods } = await db.from('products').select('id, sku, main_image_url');
  const { data: vars } = await db.from('product_variants').select('product_id, sku');
  const imgByProduct = new Map<string, string | null>((prods ?? []).map((p: any) => [p.id, p.main_image_url ?? null]));
  const web = new Map<string, string>();
  for (const p of prods ?? []) if (p.sku?.trim() && p.main_image_url) web.set(p.sku.trim(), p.main_image_url);
  for (const v of vars ?? []) { const img = imgByProduct.get(v.product_id); if (v.sku?.trim() && img) web.set(v.sku.trim(), img); }
  const wanted = opts.skus?.length ? new Set(opts.skus.map(s => s.trim())) : null;
  const skus = Array.from(web.keys()).filter(s => !wanted || wanted.has(s));

  // 2. Active Odoo variants for those SKUs, grouped by template.
  const variants: any[] = [];
  for (const c of chunks(skus, 200)) {
    variants.push(...await odooExecute<any[]>('product.product', 'search_read', [[['default_code', 'in', c]]], { fields: ['id', 'default_code', 'product_tmpl_id'] }));
  }
  const withOwn = new Set<number>();
  for (const c of chunks(variants.map(v => v.id), 300)) {
    const rows = await odooExecute<any[]>('product.product', 'search_read', [[['id', 'in', c], ['image_variant_128', '!=', false]]], { fields: ['id'] });
    for (const r of rows) withOwn.add(r.id);
  }
  const byTmpl = new Map<number, { name: string; skus: string[]; urls: Set<string>; variantIds: number[] }>();
  for (const v of variants) {
    const t = v.product_tmpl_id?.[0]; if (!t) continue;
    const g = byTmpl.get(t) ?? { name: String(v.product_tmpl_id[1]), skus: [] as string[], urls: new Set<string>(), variantIds: [] as number[] };
    g.skus.push(v.default_code); g.urls.add(web.get(v.default_code)!); g.variantIds.push(v.id);
    byTmpl.set(t, g);
  }
  const tmplIds = Array.from(byTmpl.keys());
  const { data: done } = tmplIds.length ? await db.from('lab_odoo_photo_sync').select('tmpl_id, web_url').in('tmpl_id', tmplIds) : { data: [] as any[] };
  const lastUrl = new Map<number, string>((done ?? []).map((r: any) => [r.tmpl_id, r.web_url]));
  const hasPhoto = new Set<number>();
  for (const c of chunks(tmplIds, 300)) {
    const rows = await odooExecute<any[]>('product.template', 'search_read', [[['id', 'in', c], ['image_128', '!=', false]]], { fields: ['id'] });
    for (const r of rows) hasPhoto.add(r.id);
  }

  const items: PhotoSyncItem[] = [];
  for (const [tmplId, g] of Array.from(byTmpl.entries())) {
    const urls = Array.from(g.urls);
    const ownVariants = g.variantIds.filter(id => withOwn.has(id));
    if (urls.length > 1) { items.push({ tmplId, tmplName: g.name, skus: g.skus, webUrl: urls.join(' | '), action: 'conflict' }); continue; }
    const webUrl = urls[0];
    const unchanged = !opts.force && lastUrl.get(tmplId) === webUrl && ownVariants.length === 0;
    items.push({ tmplId, tmplName: g.name, skus: g.skus.sort(), webUrl, action: unchanged ? 'unchanged' : 'update', hadPhoto: hasPhoto.has(tmplId), variantPhotosCleared: ownVariants.length });
  }

  if (opts.commit) {
    const today = new Date().toISOString().slice(0, 10);
    const t0 = Date.now();
    for (const it of items.filter(i => i.action === 'update')) {
      // Time budget (weekly cron): what is left is simply done on the next run.
      if (opts.budgetMs && Date.now() - t0 > opts.budgetMs) { it.error = 'reporté (budget de temps)'; continue; }
      try {
        const g = byTmpl.get(it.tmplId)!;
        // Rollback copy of the template's current photo.
        let backupId: number | null = null;
        if (it.hadPhoto && !lastUrl.has(it.tmplId)) {
          const [cur] = await odooExecute<any[]>('product.template', 'read', [[it.tmplId]], { fields: ['image_1920'] });
          if (cur?.image_1920) backupId = await odooExecuteWrite<number>('ir.attachment', 'create', [{ name: `photo-avant-synchro-site-${today}`, res_model: 'product.template', res_id: it.tmplId, datas: cur.image_1920, type: 'binary' }], { context: NO_MAIL });
        }
        const variantBackups: { variantId: number; attachmentId: number }[] = [];
        for (const vid of g.variantIds.filter(id => withOwn.has(id))) {
          const [cur] = await odooExecute<any[]>('product.product', 'read', [[vid]], { fields: ['image_variant_1920'] });
          if (cur?.image_variant_1920) {
            const aid = await odooExecuteWrite<number>('ir.attachment', 'create', [{ name: `photo-variante-avant-synchro-site-${today}`, res_model: 'product.product', res_id: vid, datas: cur.image_variant_1920, type: 'binary' }], { context: NO_MAIL });
            variantBackups.push({ variantId: vid, attachmentId: aid });
          }
          await odooExecuteWrite('product.product', 'write', [[vid], { image_variant_1920: false }], { context: NO_MAIL });
        }
        const { b64 } = await fetchBase64(it.webUrl);
        await odooExecuteWrite('product.template', 'write', [[it.tmplId], { image_1920: b64 }], { context: NO_MAIL });
        await odooExecuteWrite('product.template', 'message_post', [[it.tmplId]], {
          body: `Photo remplacée par la photo officielle du site (synchro lab-app) — ancienne photo gardée en pièce jointe — demandé par Axel le ${today.split('-').reverse().join('/')}.`,
          message_type: 'comment', subtype_xmlid: 'mail.mt_note',
        });
        await db.from('lab_odoo_photo_sync').upsert({ tmpl_id: it.tmplId, skus: it.skus, web_url: it.webUrl, ...(backupId ? { backup_attachment_id: backupId } : {}), ...(variantBackups.length ? { variant_backups: variantBackups } : {}), synced_at: new Date().toISOString(), synced_by: opts.by }, { onConflict: 'tmpl_id' });
        it.backupAttachmentId = backupId;
      } catch (e: any) {
        it.error = String(e?.message ?? e).slice(0, 300);
      }
    }
  }
  const odooSkus = new Set(variants.map(v => v.default_code));
  return { ok: true, commit: opts.commit, items, webSkus: skus.length, notInOdoo: skus.filter(s => !odooSkus.has(s)).length };
}

// Website photos → lab-app recipe cards (same weekly run). A card (lab_fiche_meta) whose active
// variants all point to one website photo gets that photo on the card and no per-variant override;
// otherwise each matched variant carries its own website photo. Cards/variants not on the website
// keep their app photo. Website tables are only read.
export async function syncWebsitePhotosToApp(opts: { commit: boolean }): Promise<{ ok: boolean; error?: string; fiches: number; variants: number; changes: string[] }> {
  const db = service();
  if (!db) return { ok: false, error: 'Server not configured', fiches: 0, variants: 0, changes: [] };
  const { data: prods } = await db.from('products').select('id, sku, main_image_url');
  const { data: wvars } = await db.from('product_variants').select('product_id, sku');
  const imgByProduct = new Map<string, string | null>((prods ?? []).map((p: any) => [p.id, p.main_image_url ?? null]));
  const web = new Map<string, string>();
  for (const p of prods ?? []) if (p.sku?.trim() && p.main_image_url) web.set(p.sku.trim().toUpperCase(), p.main_image_url);
  for (const v of wvars ?? []) { const img = imgByProduct.get(v.product_id); if (v.sku?.trim() && img) web.set(v.sku.trim().toUpperCase(), img); }

  const { data: fiches } = await db.from('lab_fiche_meta').select('id, image_url').eq('is_active', true);
  const { data: vars } = await db.from('lab_fiche_variants').select('id, fiche_id, sku, image_url').eq('is_active', true);
  const byFiche = new Map<string, any[]>();
  for (const v of vars ?? []) { const a = byFiche.get(v.fiche_id) ?? []; a.push(v); byFiche.set(v.fiche_id, a); }
  const changes: string[] = []; let fc = 0, vc = 0;
  for (const f of fiches ?? []) {
    const vs = byFiche.get(f.id) ?? [];
    const matched = vs.filter(v => v.sku && web.has(String(v.sku).trim().toUpperCase()));
    if (!matched.length) continue;
    const imgs = new Set(matched.map(v => web.get(String(v.sku).trim().toUpperCase())!));
    if (imgs.size === 1 && matched.length === vs.length) {
      const img = Array.from(imgs)[0];
      if (f.image_url !== img) { changes.push(`fiche ${f.id}`); fc++; if (opts.commit) await db.from('lab_fiche_meta').update({ image_url: img }).eq('id', f.id); }
      for (const v of vs) if (v.image_url) { changes.push(`variant ${v.sku} → photo fiche`); vc++; if (opts.commit) await db.from('lab_fiche_variants').update({ image_url: null }).eq('id', v.id); }
    } else {
      for (const v of matched) {
        const img = web.get(String(v.sku).trim().toUpperCase())!;
        const shown = v.image_url ?? f.image_url;
        if (shown !== img) { changes.push(`variant ${v.sku}`); vc++; if (opts.commit) await db.from('lab_fiche_variants').update({ image_url: img === f.image_url ? null : img }).eq('id', v.id); }
      }
    }
  }
  return { ok: true, fiches: fc, variants: vc, changes: changes.slice(0, 200) };
}
