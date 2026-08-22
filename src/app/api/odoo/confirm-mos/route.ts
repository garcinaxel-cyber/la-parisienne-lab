import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooConfigured, odooWriteConfigured, labDateOf } from '@/lib/odoo';
import { confirmDoneMOs, produceMOs, inspectMO, testOnchange } from '@/lib/odoo-mo-confirm';

export const dynamic = 'force-dynamic';
// 2026-08-22 — bumped from 60s: at current volume (~70+ MOs/day), produceMOs() alone needs 2
// sequential Odoo RPC calls per MO (write + button_mark_done), which no longer fits in 60s. Both
// the once-nightly cron AND the new hourly cron were confirmed timing out (net._http_response,
// error_msg "Timeout of 55000 ms reached") leaving MOs permanently stuck at "confirmed", never
// reaching "done" — this is what Axel saw as "production d'hier pas en Done" / "je vois
// seulement confirmed". Vercel plan is Pro (confirmed 2026-08-06), which allows well above 60s
// for a standard serverless function — raised to 270s. The pg_net timeout_milliseconds on the
// calling cron jobs (lab_v49b) is raised to match.
export const maxDuration = 270;

// Daily confirmation of the lab-day's remaining draft MOs (called by pg_cron with
// ?secret=CRON_SECRET — see lab_v30_mo_confirm_cron.sql — once the hourly sync's active window
// closes for the day). Also callable by hand with an explicit ?date=YYYY-MM-DD for catch-up.
//
// 2026-08-21 — produceMOs() (Axel: "si il est possible de produire completement la prod") is now
// RE-ENABLED in the automatic nightly path. Was paused for several hours today while the real
// mechanism was worked out (see odoo-mo-confirm.ts history) — root cause was writing the wrong
// field (qty_producing instead of product_qty) post-confirm; fixed and confirmed live on two
// separate MOs (38328 fresh, 38324 previously stuck) reaching state="done" cleanly.
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

  // Read-only diagnostic — ?inspect=<id> — introspects stock.move field names + move_raw_ids
  // values for one MO, no writes. Used to figure out the right field to force-set consumption
  // on before button_mark_done (Axel: "faut pas que tu te bases sur on hand quantity, on doit
  // pouvoir produire quand meme" — negative on-hand on semi-finished components is normal here
  // and must not block production).
  const inspectParam = url.searchParams.get('inspect');
  if (inspectParam) {
    try {
      return NextResponse.json(await inspectMO(parseInt(inspectParam, 10)));
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'Inspect failed' }, { status: 502 });
    }
  }

  // Read-only diagnostic — ?onchangeTest=<id>&qty=<n> — calls Odoo's generic 'onchange' RPC
  // method for mrp.production's qty_producing field, no writes. Axel confirmed via screen
  // recording that typing into the header Quantity field in the UI cascades the correct amount
  // onto every component (matching "To Consume", "Consumed" ticked) — that's a client-side
  // @api.onchange handler, which a plain write() never triggers server-side. Testing whether
  // calling Odoo's 'onchange' RPC method directly reproduces that cascade.
  const onchangeTestParam = url.searchParams.get('onchangeTest');
  if (onchangeTestParam) {
    const qty = parseFloat(url.searchParams.get('qty') ?? '0');
    try {
      return NextResponse.json(await testOnchange(parseInt(onchangeTestParam, 10), qty));
    } catch (e: any) {
      return NextResponse.json({ error: e?.message ?? 'onchange test failed' }, { status: 502 });
    }
  }

  try {
    const confirmResult = isTestMode
      ? { date, origin: `Lab ${date}`, eligible: 0, bypassed: [], confirmed: [], errors: [] }
      : await confirmDoneMOs(date);
    // produceMOs() now runs in both test mode (?mo= / ?dryRun=, scoped to one MO or listing
    // only) and the default automatic nightly path (full day's batch, right after confirm).
    const produceResult = isTestMode
      ? await produceMOs(date, { onlyMoId, dryRun })
      : await produceMOs(date);
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
