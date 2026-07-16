import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import StationView from './StationView';
import type { Team } from '@/lib/types';
import { TEAMS } from '@/lib/types';
import { filterByPublished } from '@/lib/published-cards';

export const revalidate = 0;

export default async function StationPage({ params }: { params: { team: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  let team = params.team as Team;

  if (params.team === 'me') {
    if (!session) redirect('/login');
    const { data: labProfile } = await supabase
      .from('lab_profiles')
      .select('team')
      .eq('id', session.user.id)
      .single();
    if (!labProfile?.team) redirect('/login');
    team = labProfile.team as Team;
  }

  if (!TEAMS.includes(team)) redirect('/login');

  // Current user role (worker/viewer → read-only station mode) + name (for production traceability)
  let userRole: string | null = null;
  let userName: string | null = null;
  const userId: string | null = session?.user.id ?? null;
  if (session) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', session.user.id)
      .single();
    userRole = profile?.role ?? null;
    userName = profile?.full_name ?? null;
  }

  const today = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toISOString().split('T')[0];

  // Load a full day's production (assignments enriched with fiche/variant/breakdown).
  // Lab fiches are the ONLY product reference — zero reads from the B2C catalogue tables.
  async function loadDay(date: string) {
    const { data: assignments } = await supabase
      .from('lab_assignments')
      .select(`
        id, fiche_id, variant_id, product_name_vi, product_name_en, image_url,
        variant_label, total_qty, qty_to_produce, qty_produced,
        status, is_extra, produced_ahead, cancelled, transferred, notes, sort_order, import_id,
        produced_by_name, produced_at,
        lab_imports!inner(delivery_date, order_number, type, status)
      `)
      .eq('team', team)
      .eq('lab_imports.status', 'published')
      .eq('lab_imports.delivery_date', date)
      .order('sort_order')
      .limit(120);

    const assignmentIds = (assignments ?? []).map((a: any) => a.id);
    const { data: breakdowns } = assignmentIds.length > 0
      ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
      : { data: [] as any[] };
    const breakdownMap: Record<string, any[]> = {};
    for (const b of breakdowns ?? []) breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];

    const ficheIds = Array.from(new Set((assignments ?? []).map((a: any) => a.fiche_id).filter(Boolean))) as string[];
    const { data: ficheRows } = ficheIds.length > 0
      ? await supabase.from('lab_fiche_meta').select('id, category, weight_grams, image_url').in('id', ficheIds)
      : { data: [] as any[] };
    const ficheById: Record<string, any> = {};
    for (const f of ficheRows ?? []) ficheById[f.id] = { category: f.category ?? null, weight_grams: f.weight_grams ?? null, image_url: f.image_url ?? null };

    const variantIds = Array.from(new Set((assignments ?? []).map((a: any) => a.variant_id).filter(Boolean))) as string[];
    const { data: variantRows } = variantIds.length > 0
      ? await supabase.from('lab_fiche_variants').select('id, sku, weight_g, image_url').in('id', variantIds)
      : { data: [] as any[] };
    const variantById: Record<string, any> = {};
    for (const v of variantRows ?? []) variantById[v.id] = { sku: v.sku ?? null, weight_g: v.weight_g ?? null, image_url: v.image_url ?? null };

    const importIds = Array.from(new Set((assignments ?? []).map((a: any) => a.import_id).filter(Boolean))) as string[];
    const { data: orderLineDeliveries } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('order_ref, delivery_time').in('import_id', importIds)
          .not('delivery_time', 'is', null).not('order_ref', 'is', null)
      : { data: [] as any[] };
    const deliveryTimeByRef: Record<string, string> = {};
    for (const ol of orderLineDeliveries ?? []) if (ol.order_ref && ol.delivery_time) deliveryTimeByRef[ol.order_ref] = ol.delivery_time;

    // Birthday-cake complementary info (message + ready-by time) entered by assistants —
    // attached to this team's cards by product name. Read-only for chefs.
    const { data: teamLines } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('id, product_name_vi').in('import_id', importIds).eq('team', team)
      : { data: [] as any[] };
    const nameByLineId: Record<string, string> = {};
    for (const l of teamLines ?? []) nameByLineId[l.id] = l.product_name_vi;
    const teamLineIds = (teamLines ?? []).map((l: any) => l.id);
    const { data: bcDetails } = teamLineIds.length > 0
      ? await supabase.from('lab_birthday_details').select('order_line_id, message, ready_time').in('order_line_id', teamLineIds)
      : { data: [] as any[] };
    const bcByProduct: Record<string, { messages: string[]; ready: string | null }> = {};
    for (const d of bcDetails ?? []) {
      const pn = nameByLineId[d.order_line_id]; if (!pn) continue;
      const e = (bcByProduct[pn] ??= { messages: [], ready: null });
      if (d.message) e.messages.push(d.message);
      if (d.ready_time && (!e.ready || d.ready_time < e.ready)) e.ready = d.ready_time;
    }

    // Which client orders of this day are published — chefs only see published portions.
    const { data: pubRows } = importIds.length > 0
      ? await supabase.from('lab_order_lines').select('order_ref').eq('delivery_date', date).eq('published', true)
      : { data: [] as any[] };
    const publishedRefs = new Set((pubRows ?? []).map((r: any) => r.order_ref).filter(Boolean));

    const mapped = (assignments ?? []).map((a: any) => {
      const variant = a.variant_id ? variantById[a.variant_id] ?? null : null;
      const fiche = a.fiche_id ? ficheById[a.fiche_id] ?? null : null;
      return {
        ...a,
        sku: variant?.sku ?? null,
        image_url: variant?.image_url ?? fiche?.image_url ?? a.image_url ?? null,
        weight_grams: variant?.weight_g ?? fiche?.weight_grams ?? null,
        category_name_vi: fiche?.category ?? null,
        category_name_en: fiche?.category ?? null,
        bc_message: bcByProduct[a.product_name_vi]?.messages.join(' · ') || null,
        bc_ready_time: bcByProduct[a.product_name_vi]?.ready || null,
        breakdown: (breakdownMap[a.id] ?? []).map((b: any) => ({
          ...b,
          delivery_time: b.order_ref ? (deliveryTimeByRef[b.order_ref] ?? null) : null,
        })),
        lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
      };
    });
    return filterByPublished(mapped, publishedRefs);
  }

  const [todayAssignments, tomorrowAssignments] = await Promise.all([loadDay(today), loadDay(tomorrow)]);

  return <StationView team={team} teamSlug={params.team}
    assignments={todayAssignments} tomorrowAssignments={tomorrowAssignments}
    viewDate={today} today={today} tomorrow={tomorrow} isHistoryView={false} userRole={userRole} userId={userId} userName={userName} />;
}
