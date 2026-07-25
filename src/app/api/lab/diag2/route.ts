import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecute, odooConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMP diag — (1) mrp.production tagged for a Lab day (with state) to explain "already created";
// (2) station draft_odoo computation inputs for a team+date. Admin only. Delete after.
export async function GET(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || '2026-07-24';
  const team = url.searchParams.get('team') || 'hung';

  // (1) Odoo MOs tagged for this day — include state to spot cancelled ones
  let mos: any[] = [];
  if (odooConfigured()) {
    mos = await odooExecute<any[]>('mrp.production', 'search_read',
      [[['origin', '=', `Lab ${date}`]]], { fields: ['id', 'name', 'state', 'product_id', 'origin'], limit: 500 }).catch(() => []);
  }

  // (2) Station draft_odoo inputs: assignments (published, team, date) + their imports' order_states
  const { data: asg } = await supabase.from('lab_assignments')
    .select('id, product_name_vi, import_id, breakdown, lab_imports!inner(delivery_date, status)')
    .eq('team', team).eq('lab_imports.status', 'published').eq('lab_imports.delivery_date', date).limit(200);
  const importIds = Array.from(new Set((asg ?? []).map((a: any) => a.import_id)));
  const { data: impCR } = importIds.length
    ? await supabase.from('lab_imports').select('id, control_report').in('id', importIds)
    : { data: [] as any[] };
  const orderStates: Record<string, string> = {};
  const crShape: any = {};
  for (const imp of impCR ?? []) {
    const s = (imp as any).control_report?.order_states;
    crShape[(imp as any).id] = { has_control_report: !!(imp as any).control_report, has_order_states: !!s, sample: s ? Object.entries(s).slice(0, 3) : null };
    if (s) Object.assign(orderStates, s);
  }
  const cards = (asg ?? []).slice(0, 12).map((a: any) => {
    const refs = (Array.isArray(a.breakdown) ? a.breakdown : []).map((b: any) => b.order_ref);
    const draft = refs.some((r: string) => { const st = orderStates[r]; return !!st && st !== 'sale' && st !== 'approved'; });
    return { product: a.product_name_vi, refs, states: refs.map((r: string) => orderStates[r] ?? null), draft_odoo: draft };
  });

  return NextResponse.json({
    date, team,
    odoo_mos_for_day: mos.map(m => ({ name: m.name, state: m.state, product: m.product_id?.[1] })),
    odoo_mos_count: mos.length,
    order_states_keys: Object.keys(orderStates).length,
    control_report_shape: crShape,
    cards,
  });
}
