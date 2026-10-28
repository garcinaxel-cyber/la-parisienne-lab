import { NextResponse } from 'next/server';
import { syncWebsitePhotosToOdoo, syncWebsitePhotosToApp } from '@/lib/photo-sync-odoo';
import { syncOdooItemPhotos } from '@/lib/item-photos';

// Weekly website → Odoo photo sync (Axel, 2026-10-28: "une synchro par semaine"). Sunday 2h
// Hanoi (Sat 19:00 UTC). Reads the website tables only; sends only photos changed since the last
// run (lab_odoo_photo_sync). Called by the Vercel cron (Authorization: Bearer CRON_SECRET).
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const app = await syncWebsitePhotosToApp({ commit: true });
  const res = await syncWebsitePhotosToOdoo({ commit: true, by: 'synchro hebdo', budgetMs: 150_000 });
  // Raw materials & packaging: Odoo photo → app copy (only products changed since last week).
  const items = await syncOdooItemPhotos({ commit: true, budgetMs: 90_000 }).catch((e: any) => ({ ok: false, error: String(e?.message ?? e), copied: 0, failed: [] as string[] }));
  const summary = {
    ok: res.ok, error: res.error, app: { fiches: app.fiches, variants: app.variants, error: app.error },
    updated: res.items.filter(i => i.action === 'update' && !i.error).map(i => i.tmplName),
    failed: res.items.filter(i => i.error).map(i => `${i.tmplName}: ${i.error}`),
    items: { copied: (items as any).copied, failed: (items as any).failed, error: (items as any).error },
    unchanged: res.items.filter(i => i.action === 'unchanged').length,
    conflicts: res.items.filter(i => i.action === 'conflict').map(i => i.tmplName),
  };
  console.log('[photo-sync-weekly]', JSON.stringify(summary));
  return NextResponse.json(summary, { status: res.ok ? 200 : 500 });
}
