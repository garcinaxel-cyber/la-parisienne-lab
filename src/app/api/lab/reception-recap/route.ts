import { NextRequest, NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { labDayUtcRange } from '@/lib/odoo';

// Consolidated reception recap for one SEND day (lab-local calendar day of the transfer note's
// created_at) — one row per product x team, with what's still missing a reception confirmation
// highlighted. Read-only. Admin / lab_manager / assistant only.
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const today = new Date().toISOString().split('T')[0];
  const date = (req.nextUrl.searchParams.get('date') || today).slice(0, 10);
  const { start, end } = labDayUtcRange(date);

  const { data: transfers } = await supabase
    .from('lab_stock_transfers')
    .select('id, team, status, created_at')
    .gte('created_at', start).lt('created_at', end);

  const ids = (transfers ?? []).map(t => t.id);
  const transferById: Record<string, { team: string; status: string }> = {};
  for (const t of transfers ?? []) transferById[t.id] = { team: t.team, status: t.status };

  const { data: lines } = ids.length
    ? await supabase.from('lab_stock_transfer_lines')
        .select('transfer_id, assignment_id, product_name_vi, product_name_en, sku, variant_label, qty_sent, qty_received')
        .in('transfer_id', ids)
    : { data: [] as any[] };
  // Only EXTRA production is received in this tab since 2026-10-24 (Axel): made-to-order lines
  // are received automatically when sent, so they are left out of the recap too.
  const aIds = Array.from(new Set((lines ?? []).map((l: any) => l.assignment_id).filter(Boolean)));
  const extraIds = new Set<string>();
  for (let i = 0; i < aIds.length; i += 200) {
    const { data: kinds } = await supabase.from('lab_assignments').select('id').in('id', aIds.slice(i, i + 200)).eq('is_extra', true);
    for (const k of kinds ?? []) extraIds.add(k.id);
  }

  type Row = {
    team: string; name: string; sku: string | null; variant: string | null;
    sent: number; received: number; pending: number;
  };
  const map = new Map<string, Row>();
  for (const l of lines ?? []) {
    const t = transferById[l.transfer_id];
    if (!t) continue;
    if (l.assignment_id && !extraIds.has(l.assignment_id)) continue;
    const key = `${t.team}||${l.sku ?? ''}||${l.variant_label ?? ''}||${l.product_name_vi}`;
    const r = map.get(key) ?? {
      team: t.team, name: l.product_name_vi, sku: l.sku ?? null, variant: l.variant_label ?? null,
      sent: 0, received: 0, pending: 0,
    };
    r.sent += l.qty_sent ?? 0;
    if (l.qty_received != null) r.received += l.qty_received;
    else if (t.status === 'received') r.received += l.qty_sent ?? 0; // received as a whole note
    else r.pending += l.qty_sent ?? 0;
    map.set(key, r);
  }

  const rows = Array.from(map.values()).sort((a, b) =>
    (b.pending > 0 ? 1 : 0) - (a.pending > 0 ? 1 : 0) || a.team.localeCompare(b.team) || a.name.localeCompare(b.name));

  return NextResponse.json({
    date,
    totalSent: rows.reduce((s, r) => s + r.sent, 0),
    totalReceived: rows.reduce((s, r) => s + r.received, 0),
    totalPending: rows.reduce((s, r) => s + r.pending, 0),
    notesCount: new Set((lines ?? []).filter((l: any) => !l.assignment_id || extraIds.has(l.assignment_id)).map((l: any) => l.transfer_id)).size,
    rows,
  });
}
