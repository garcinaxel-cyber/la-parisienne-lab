import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooWriteConfigured, labDateOf } from '@/lib/odoo';
import { confirmDoneMOs, produceMOs } from '@/lib/odoo-mo-confirm';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily confirmation + full validation of the lab-day's MOs (called by pg_cron with
// ?secret=CRON_SECRET — see lab_v30_mo_confirm_cron.sql — once the hourly sync's active window
// closes for the day). Also callable by hand with an explicit ?date=YYYY-MM-DD for catch-up.
//
// 2026-08-21 — produceMOs() added after confirmDoneMOs() (Axel: "si il est possible de produire
// completement la prod", confirmed direct in the cron). Runs on whatever is in state='confirmed'
// for the day's origin, so it also catches MOs confirmed by an earlier/manual run, not just ones
// confirmDoneMOs just confirmed in this same call.
//
// ?mo=<id> and/or ?dryRun=1 (2026-08-21, Axel: "essayer sur 1 ligne pour voir si tout
// fonctionne") — manual single-MO test path. Either param skips confirmDoneMOs entirely (a test
// must not confirm the whole day's remaining drafts as a side effect) and scopes/limits
// produceMOs instead. Omit both for the normal nightly cron call — unchanged full-batch behavior.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured() || !odooWriteConfigured()) {
    return NextResponse.json({ error: 'ODOO_* / ODOO_WRITE_* not configured' }, { status: 503 });
  }
  const date = url.searchParams.get('date') || labDateOf(new Date().toISOString())!;
  const moParam = url.searchParams.get('mo');
  const onlyMoId = moParam ? parseInt(moParam, 10) : undefined;
  const dryRun = url.searchParams.get('dryRun') === '1';
  const isTestMode = onlyMoId !== undefined || dryRun;

  try {
    const confirmResult = isTestMode
      ? { date, origin: `Lab ${date}`, eligible: 0, bypassed: [], confirmed: [], errors: [] }
      : await confirmDoneMOs(date);
    const produceResult = await produceMOs(date, isTestMode ? { onlyMoId, dryRun } : undefined);
    // Surface failures the same way the rest of the Odoo sync already does (odoo-auto-sync.ts,
    // stock-actions.ts) — a confirm/produce that silently fails must not just sit there with no
    // one told.
    const allErrors = [
      ...confirmResult.errors.map(e => ({ ...e, phase: 'confirm' as const })),
      ...produceResult.errors.map(e => ({ ...e, phase: 'produce' as const })),
    ];
    if (allErrors.length && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await supabase.from('lab_odoo_changes').insert({
        order_ref: `mo-confirm:${date}`,
        cancelled: false,
        items: allErrors.map(e => ({ sku: e.name, name: e.name, reason: `[${e.phase}] ${e.error}` })),
        delivery_date: date,
        status: 'error',
      });
    }
    return NextResponse.json({ confirm: confirmResult, produce: produceResult });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'MO confirm/produce failed' }, { status: 502 });
  }
}
