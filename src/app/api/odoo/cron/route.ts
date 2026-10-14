import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooAuthHealth } from '@/lib/odoo';
import { sendAdminPush } from '@/lib/push-notify';
import { runAutoOdooSync } from '@/lib/odoo-auto-sync';
import { syncOrderPackagingLines } from '@/lib/odoo-packaging-sync';

// Lab-local (Asia/Ho_Chi_Minh) rolling window for the packaging sync — matches the
// delivery-check feature's own scope (today + tomorrow only, kept tight for cost).
function labUpcomingDates(days: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
  const now = new Date();
  return Array.from({ length: days }, (_, i) => fmt.format(new Date(now.getTime() + i * 24 * 3600 * 1000)));
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Every-15-min auto-sync (called by pg_cron / external scheduler with ?secret=CRON_SECRET).
// AUTO mode: the app mirrors Odoo for today's and upcoming orders without a manual publish step.
//  - New orders are imported as PUBLISHED → the chefs see them immediately.
//  - Modifications & cancellations are auto-applied — qty adjusted, cancelled orders struck
//    through, produced quantities never erased.
// The actual work lives in runAutoOdooSync (shared with the on-demand "Sync Odoo" button on
// the station pages — same behaviour, just triggered by a chef instead of the clock).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (ODOO_* / SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  // Odoo keys expire (90 days by default): check both accounts every run. On failure: error log
  // every time, admin push at most 3 times a day (VN 8h, 13h, 18h runs) so it is seen, not spammed.
  let auth: Awaited<ReturnType<typeof odooAuthHealth>> | null = null;
  try {
    auth = await odooAuthHealth();
    if (!auth.read || !auth.write) {
      const bad = [!auth.read ? 'readonly (ODOO_API_KEY)' : null, !auth.write ? 'API-PRODUCTION (ODOO_WRITE_API_KEY)' : null].filter(Boolean).join(' + ');
      console.error(`[odoo-health] account rejected: ${bad} — read: ${auth.readError ?? 'ok'} · write: ${auth.writeError ?? 'ok'}`);
      const vn = new Date(Date.now() + 7 * 3600_000);
      if ([8, 13, 18].includes(vn.getUTCHours()) && vn.getUTCMinutes() < 15) {
        await sendAdminPush(supabase as any,
          { title: 'Odoo', body: `⚠ Khoá API Odoo bị từ chối: ${bad}. Cần tạo khoá mới.`, url: '/dashboard', tag: 'odoo-auth' },
          { title: 'Odoo', body: `⚠ Odoo API key rejected: ${bad}. Renew it.`, url: '/dashboard', tag: 'odoo-auth' });
      }
    }
  } catch { /* the health check must never block the sync */ }

  try {
    const result = await runAutoOdooSync(supabase as any);
    if (result.error) return NextResponse.json({ error: result.error }, { status: 502 });

    // Best-effort — packaging sync must never fail the main order sync response.
    let packaging: any = null;
    try { packaging = await syncOrderPackagingLines(supabase as any, labUpcomingDates(2)); }
    catch (e: any) { packaging = { ok: false, error: String(e?.message ?? e) }; }

    return NextResponse.json({ ...result, packaging, odooAuth: auth ? { read: auth.read, write: auth.write } : null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Cron sync failed' }, { status: 502 });
  }
}
