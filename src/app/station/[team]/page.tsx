import { createClient } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import StationView from './StationView';
import type { Team } from '@/lib/types';
import { TEAMS } from '@/lib/types';

export const revalidate = 0; // Always fresh for chef station

export default async function StationPage({ params }: { params: { team: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let team = params.team as Team;

  // If team = 'me', resolve from lab_profiles
  if (params.team === 'me') {
    if (!user) redirect('/login');
    const { data: labProfile } = await supabase
      .from('lab_profiles')
      .select('team')
      .eq('id', user.id)
      .single();
    if (!labProfile?.team) redirect('/login');
    team = labProfile.team as Team;
  }

  if (!TEAMS.includes(team)) redirect('/login');

  const today = new Date().toISOString().split('T')[0];

  // Fetch today's published assignments for this team
  const { data: assignments } = await supabase
    .from('lab_assignments')
    .select(`
      id, product_id, product_name_vi, product_name_en, image_url,
      variant_label, total_qty, qty_to_produce, qty_produced,
      status, notes, sort_order, import_id,
      lab_imports!inner(delivery_date, order_number, type, status)
    `)
    .eq('team', team)
    .eq('lab_imports.status', 'published')
    .eq('lab_imports.delivery_date', today)
    .order('sort_order')
    .limit(120);

  const assignmentIds = (assignments ?? []).map((a: any) => a.id);

  // Breakdown is added by lab_v3.sql migration — fetch separately so main query
  // still works even if the migration hasn't been run yet
  const { data: breakdowns } = assignmentIds.length > 0
    ? await supabase.from('lab_assignments').select('id, breakdown').in('id', assignmentIds)
    : { data: [] as any[] };

  const breakdownMap: Record<string, any[]> = {};
  for (const b of breakdowns ?? []) {
    breakdownMap[b.id] = Array.isArray(b.breakdown) ? b.breakdown : [];
  }

  const normalised = (assignments ?? []).map((a: any) => ({
    ...a,
    breakdown: breakdownMap[a.id] ?? [],
    lab_imports: Array.isArray(a.lab_imports) ? a.lab_imports[0] : a.lab_imports,
  }));

  return <StationView team={team} assignments={normalised} today={today} />;
}
