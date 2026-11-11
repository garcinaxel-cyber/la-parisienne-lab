import { NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { odooConfigured, odooExecute, labDateOf, vnTodayStr } from '@/lib/odoo';

// Nightly safety net for the station Analytics › "This month" tab (lab_v152, Axel 2026-11-11).
//  1. Rebuilds lab_analytics_daily from the source rows for the previous + current month (the
//     triggers keep it current during the day; this catches anything a trigger may have missed).
//  2. Copies OEM production (Team Hưng, MM-/OEM- products, kg) from the done Odoo MOs into
//     lab_analytics_oem_daily, by lab day of the MO start date.
// Called by the Vercel cron (Authorization: Bearer CRON_SECRET). ?from=YYYY-MM-DD overrides the
// start date (backfill).
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function prevMonthStart(today: string) {
  const [y, m] = today.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'Service role not configured' }, { status: 500 });
  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const today = vnTodayStr();
  const fromParam = url.searchParams.get('from');
  const from = fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : prevMonthStart(today);
  const summary: Record<string, unknown> = { from, to: today };

  // Made-to-order production counts on its DELIVERY day (lab_v153), which can be a few days ahead.
  const [ty, tm, td] = today.split('-').map(Number);
  const ahead = new Date(Date.UTC(ty, tm - 1, td + 3)).toISOString().slice(0, 10);
  const { data: rebuilt, error: rbErr } = await sb.rpc('lab_analytics_rebuild', { p_from: from, p_to: ahead });
  summary.rebuilt = rebuilt; if (rbErr) summary.rebuildError = rbErr.message;

  if (odooConfigured()) {
    try {
      // Lab day starts at 00:00 Hanoi = 17:00 UTC the day before.
      const [y, m, d] = from.split('-').map(Number);
      const startUtc = new Date(Date.UTC(y, m - 1, d) - 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const mos: any[] = await odooExecute('mrp.production', 'search_read', [[
        ['state', '=', 'done'], ['date_start', '>=', startUtc],
        '|', ['product_id.default_code', '=like', 'MM-%'], ['product_id.default_code', '=like', 'OEM-%'],
      ]], { fields: ['product_id', 'product_qty', 'qty_produced', 'date_start'], limit: 5000 });
      const acc = new Map<string, { day: string; code: string; name: string; kg: number }>();
      for (const mo of mos) {
        const day = labDateOf(String(mo.date_start).replace(' ', 'T') + 'Z');
        const disp = String(mo.product_id?.[1] ?? '');
        const code = disp.match(/^\[([^\]]+)\]/)?.[1] ?? String(mo.product_id?.[0] ?? '');
        const full = disp.replace(/^\[[^\]]+\]\s*/, '').replace(/\s*\(kg\)\s*$/i, '').trim();
        // "Bánh quy socola nho khô (Chocolate Grape Cookie)" → the English name in brackets, if any
        // (not a size like "(6 g)").
        const en = full.match(/\(([^()]*[A-Za-z][^()]*)\)\s*$/)?.[1];
        const name = en && !/^\d/.test(en.trim()) ? en.trim() : full;
        if (!day || !code) continue;
        const k = `${day}|${code}`;
        const a = acc.get(k) ?? { day, code, name, kg: 0 };
        a.kg += Number(mo.qty_produced || mo.product_qty) || 0;
        acc.set(k, a);
      }
      await sb.from('lab_analytics_oem_daily').delete().gte('day', from).lte('day', today);
      const rows = Array.from(acc.values()).map(r => ({ ...r, kg: Math.round(r.kg * 1000) / 1000, updated_at: new Date().toISOString() }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('lab_analytics_oem_daily').insert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      summary.oemRows = rows.length; summary.oemMos = mos.length;
    } catch (e: any) {
      summary.oemError = String(e?.message ?? e);
    }
  } else summary.oemError = 'Odoo not configured';

  console.log('[analytics-sync]', JSON.stringify(summary));
  return NextResponse.json(summary, { status: summary.rebuildError || summary.oemError ? 500 : 200 });
}
