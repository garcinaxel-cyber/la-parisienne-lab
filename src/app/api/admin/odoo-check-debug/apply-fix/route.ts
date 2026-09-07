import { NextResponse } from 'next/server';
import { getLabStockLevels, applyInventoryPush } from '@/lib/odoo-inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMPORARY — Axel, 2026-09-07: one-off correction for the double-counted Chum Cafe transfer
// (REP/2026/01354, LAB/OUT/03676 validated 2026-09-07 09:42 UTC, already absorbed by the
// 2026-09-04 physical inventory). Adds back exactly what that move just subtracted a second time.
const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';

// Deltas = exactly what LAB/OUT/03676 moved (confirmed via Odoo stock.move read).
const CORRECTIONS: Record<string, number> = {
  BQLMT140: 5, BQLMMC140: 5, BQLMS140: 5, BMC: 5, BMX: 5,
  BLDFGTBT: 5, BLDFGCP: 7, BMM: 5, BLDFGSCL: 3, BLDFGVN: 5,
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  const dryRun = url.searchParams.get('dry') === '1';

  const skus = Object.keys(CORRECTIONS);
  const levels = await getLabStockLevels(skus);
  const targets = levels.map(l => ({ sku: l.sku, before: l.qty, delta: CORRECTIONS[l.sku], after: l.qty + CORRECTIONS[l.sku], found: l.found }));

  if (dryRun) return NextResponse.json({ dryRun: true, targets });

  const today = new Date().toISOString().slice(0, 10);
  const res = await applyInventoryPush(targets.map(t => ({ sku: t.sku, qtyCounted: t.after })), today);
  return NextResponse.json({ targets, res });
}
