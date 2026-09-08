import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEBUG_KEY = '4ik7FDJYSbKV1nVwwv1sXpvLe2afgxgE';

// Candidate (team, lab-day) windows flagged by the earlier signature scan.
const CANDIDATES = [
  { team: 'hung', date: '2026-09-07' },
  { team: 'baby_mama', date: '2026-09-08' },
  { team: 'entremet', date: '2026-08-02' },
  { team: 'hung', date: '2026-07-15' },
  { team: 'hung', date: '2026-07-26' },
  { team: 'baby_mama', date: '2026-08-24' },
];

function labDayUtcRange(date: string) {
  const start = new Date(`${date}T02:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== DEBUG_KEY) return NextResponse.json({ error: 'nope' }, { status: 401 });
  if (!odooConfigured()) return NextResponse.json({ error: 'odoo not configured' }, { status: 503 });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const out: any[] = [];

  for (const c of CANDIDATES) {
    const { start, end } = labDayUtcRange(c.date);
    const { data: transfers, error: tErr } = await supabase.from('lab_stock_transfers')
      .select('id, team, created_at, created_by_name, status')
      .eq('team', c.team).gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: true });
    if (tErr) { out.push({ ...c, error: tErr.message }); continue; }
    const tids = (transfers ?? []).map((t: any) => t.id);
    let lines: any[] = [];
    if (tids.length) {
      const { data: l } = await supabase.from('lab_stock_transfer_lines')
        .select('transfer_id, sku, qty_sent, product_name_vi').in('transfer_id', tids);
      lines = l ?? [];
    }
    const linesByTransfer: Record<string, any[]> = {};
    for (const l of lines) (linesByTransfer[l.transfer_id] ??= []).push(l);
    const withSig = (transfers ?? []).map((t: any) => {
      const ls = (linesByTransfer[t.id] ?? []).filter((l: any) => l.qty_sent > 0 && l.sku);
      const sig = ls.map((l: any) => `${l.sku}:${l.qty_sent}`).sort().join('|');
      return { ...t, lines: ls, sig };
    });
    const bySig: Record<string, any[]> = {};
    for (const t of withSig) if (t.sig) (bySig[t.sig] ??= []).push(t);
    const dupGroups = Object.entries(bySig).filter(([, arr]) => arr.length > 1);

    const correctBySku: Record<string, number> = {};
    const actualSentBySku: Record<string, number> = {};
    for (const t of withSig) {
      for (const l of t.lines) actualSentBySku[l.sku] = (actualSentBySku[l.sku] ?? 0) + l.qty_sent;
    }
    // Count each distinct signature ONCE regardless of how many times it was submitted
    // (a real duplicate has the exact same sku:qty lines re-sent) — this is the correct total.
    for (const [sig, arr] of Object.entries(bySig)) {
      const first = arr[0];
      for (const l of first.lines) correctBySku[l.sku] = (correctBySku[l.sku] ?? 0) + l.qty_sent;
    }

    const skus = Array.from(new Set(lines.map((l: any) => l.sku).filter(Boolean)));
    let odooBySku: Record<string, { done: number; names: string[] }> = {};
    if (skus.length) {
      const origin = `Lab ${c.date}`;
      const prods = await odooExecute<any[]>('product.product', 'search_read',
        [[['default_code', 'in', skus]]], { fields: ['id', 'default_code', 'name'], limit: 500 });
      const prodIdToSku: Record<number, string> = {};
      const prodIds: number[] = [];
      for (const p of prods) { prodIdToSku[p.id] = p.default_code; prodIds.push(p.id); }
      const mos = prodIds.length ? await odooExecute<any[]>('mrp.production', 'search_read',
        [[['origin', '=', origin], ['product_id', 'in', prodIds], ['state', '!=', 'cancel']]],
        { fields: ['id', 'name', 'product_id', 'product_qty', 'qty_producing', 'state'], limit: 500 }) : [];
      for (const m of mos) {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
        const sku = prodIdToSku[pid];
        if (!sku) continue;
        const qty = m.state === 'done' ? (m.qty_producing || m.product_qty) : m.product_qty;
        if (!odooBySku[sku]) odooBySku[sku] = { done: 0, names: [] };
        odooBySku[sku].done += qty;
        odooBySku[sku].names.push(`${m.name}(${m.state},${qty})`);
      }
    }

    const skuComparison = skus.map(sku => {
      const correct = correctBySku[sku] ?? 0;
      const actualSent = actualSentBySku[sku] ?? 0;
      const odoo = odooBySku[sku]?.done ?? 0;
      return {
        sku,
        correctQtyShouldHaveBeenSent: correct,
        actualQtySentInSupabase: actualSent,
        actualOdooProducedQty: odoo,
        overageVsCorrect: odoo - correct,
        odooMos: odooBySku[sku]?.names ?? [],
      };
    });
    const debugAll = url.searchParams.get('all') === '1' ? skuComparison : skuComparison.filter(x => x.actualQtySentInSupabase > x.correctQtyShouldHaveBeenSent || x.overageVsCorrect > 0);

    out.push({
      team: c.team, date: c.date,
      transferCount: transfers?.length ?? 0,
      duplicateGroups: dupGroups.map(([sig, arr]) => ({
        sig, count: arr.length,
        transfers: arr.map((t: any) => ({ id: t.id, created_at: t.created_at, created_by_name: t.created_by_name, status: t.status })),
      })),
      skuComparison: debugAll,
    });
  }

  return NextResponse.json({ results: out });
}
