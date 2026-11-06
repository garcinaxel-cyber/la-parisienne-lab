'use server';
// HR pilot — team leader side (station "Team" tab). Axel, 2026-11-06.
// Session = who clicked; writes go through the service-role client (hr_* tables: RLS on, no policies).
// Allowed: admin / lab_manager on any team, chef only on his own team (lab_profiles.team).
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { HR_PILOT_TEAMS, HR_CYCLE, addMonths, daysInMonth, dayStr, hoursBetween, hrNeedsGiang, type HrEmployee, type HrOt, type HrRequest } from '@/lib/hr';

function service() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function isHrLeader(team: string, userId: string): Promise<boolean> {
  const { data } = await service().from('hr_employees').select('id')
    .eq('team', team).eq('is_leader', true).eq('active', true).eq('profile_id', userId).limit(1);
  return !!data?.length;
}

async function guard(team: string): Promise<{ name: string } | { error: string }> {
  if (!HR_PILOT_TEAMS.includes(team)) return { error: 'Team not in the HR pilot' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Not configured' };
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  const role = profile?.role ?? '';
  if (role === 'admin' || role === 'lab_manager') return { name: profile?.full_name ?? 'Admin' };
  // Most team members have a 'chef' station account: only the employee flagged leader (v146) manages.
  if (role === 'chef' && (await isHrLeader(team, session.user.id))) return { name: profile?.full_name ?? 'Chef' };
  return { error: 'Not allowed' };
}

export type TeamHrData = {
  month: string; employees: HrEmployee[]; stored: Record<string, string>; wishes: string[]; wishSubmitted: string[];
  monthStatus: 'draft' | 'published'; requests: HrRequest[]; ots: HrOt[]; otHours: Record<string, number>;
  nextMonth: string; nextWishes: string[]; nextSubmitted: string[];
};

export async function loadTeamHrAction(team: string, month: string): Promise<{ data?: TeamHrData; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const start = month, end = dayStr(month, daysInMonth(month));
  const next = addMonths(month, 1);
  const nextEnd = dayStr(next, daysInMonth(next));
  const { data: emps, error: e1 } = await db.from('hr_employees').select('*').eq('team', team).eq('active', true).order('sort_order');
  if (e1) return { error: e1.message.includes('does not exist') ? 'HR_NOT_INSTALLED' : e1.message };
  const ids = (emps ?? []).map((e: any) => e.id);
  if (!ids.length) return { data: { month, employees: [], stored: {}, wishes: [], wishSubmitted: [], monthStatus: 'draft', requests: [], ots: [], otHours: {}, nextMonth: next, nextWishes: [], nextSubmitted: [] } };
  const [days, wishes, submits, mstat, reqs, ots] = await Promise.all([
    db.from('hr_schedule_days').select('employee_id, day, code').in('employee_id', ids).gte('day', start).lte('day', end),
    db.from('hr_off_wishes').select('employee_id, day').in('employee_id', ids).gte('day', start).lte('day', nextEnd),
    db.from('hr_off_wish_submits').select('employee_id, month').in('employee_id', ids).in('month', [month, next]),
    db.from('hr_schedule_months').select('status').eq('team', team).eq('month', month).maybeSingle(),
    db.from('hr_requests').select('*').eq('team', team).order('created_at', { ascending: false }).limit(80),
    db.from('hr_ot_requests').select('*, hr_ot_lines(employee_id, confirm)').eq('team', team).gte('day', start).lte('day', end).order('day', { ascending: false }),
  ]);
  const stored: Record<string, string> = {};
  for (const r of days.data ?? []) stored[r.employee_id + '|' + r.day] = r.code;
  const otList: HrOt[] = (ots.data ?? []).map((o: any) => ({ ...o, hours: Number(o.hours), lines: o.hr_ot_lines ?? [] }));
  const otHours: Record<string, number> = {};
  for (const o of otList) {
    if (o.status === 'rejected' || o.status === 'cancelled') continue;
    for (const l of o.lines) if (l.confirm !== 'no') otHours[l.employee_id] = (otHours[l.employee_id] ?? 0) + o.hours;
  }
  const w = (wishes.data ?? []);
  return {
    data: {
      month, employees: (emps ?? []) as HrEmployee[], stored,
      wishes: w.filter((x: any) => x.day <= end).map((x: any) => x.employee_id + '|' + x.day),
      wishSubmitted: (submits.data ?? []).filter((s: any) => s.month === month).map((s: any) => s.employee_id),
      monthStatus: (mstat.data?.status as any) ?? 'draft',
      requests: (reqs.data ?? []) as HrRequest[], ots: otList, otHours,
      nextMonth: next,
      nextWishes: w.filter((x: any) => x.day > end).map((x: any) => x.employee_id + '|' + x.day),
      nextSubmitted: (submits.data ?? []).filter((s: any) => s.month === next).map((s: any) => s.employee_id),
    },
  };
}

export async function setScheduleCodeAction(team: string, employeeId: string, day: string, code: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  if (!HR_CYCLE.includes(code as any)) return { error: 'Bad code' };
  const db = service();
  const { data: emp } = await db.from('hr_employees').select('team').eq('id', employeeId).single();
  if (emp?.team !== team) return { error: 'Not allowed' };
  const { error } = await db.from('hr_schedule_days').upsert({ employee_id: employeeId, day, code, updated_by: g.name, updated_at: new Date().toISOString() });
  return error ? { error: error.message } : { ok: true };
}

export async function setMonthStatusAction(team: string, month: string, status: 'draft' | 'published'): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const { error } = await service().from('hr_schedule_months').upsert({
    team, month, status, published_at: status === 'published' ? new Date().toISOString() : null, published_by: status === 'published' ? g.name : null,
  });
  return error ? { error: error.message } : { ok: true };
}

export async function decideRequestAction(team: string, id: string, decision: 'ok' | 'reject' | 'undo'): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: r } = await db.from('hr_requests').select('team, type, status').eq('id', id).single();
  if (!r || r.team !== team) return { error: 'Not found' };
  let patch: Record<string, unknown>;
  if (decision === 'undo') {
    // Only while Mr Giang has not decided yet.
    if (!['pending_giang', 'rejected', 'approved'].includes(r.status) || (r.status === 'approved' && hrNeedsGiang(r.type))) return { error: 'Too late to undo' };
    patch = { status: 'pending_leader', leader_name: null, leader_at: null };
  } else {
    if (r.status !== 'pending_leader') return { error: 'Already decided' };
    patch = {
      status: decision === 'reject' ? 'rejected' : hrNeedsGiang(r.type) ? 'pending_giang' : 'approved',
      leader_name: g.name, leader_at: new Date().toISOString(),
    };
  }
  const { error } = await db.from('hr_requests').update(patch).eq('id', id);
  return error ? { error: error.message } : { ok: true };
}

export async function createOtAction(team: string, input: { day: string; time_from: string; time_to: string; reason: string; employeeIds: string[] }): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  if (!input.employeeIds.length) return { error: 'No employee' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !/^\d{2}:\d{2}$/.test(input.time_from) || !/^\d{2}:\d{2}$/.test(input.time_to)) return { error: 'Bad date or time' };
  const hours = hoursBetween(input.time_from, input.time_to);
  if (hours <= 0) return { error: 'End must be after start' };
  const db = service();
  const { data: emps } = await db.from('hr_employees').select('id').eq('team', team).in('id', input.employeeIds);
  if ((emps ?? []).length !== input.employeeIds.length) return { error: 'Not allowed' };
  const { data: ot, error } = await db.from('hr_ot_requests').insert({
    team, day: input.day, time_from: input.time_from, time_to: input.time_to, hours, reason: input.reason || null, created_by_name: g.name,
  }).select('id').single();
  if (error || !ot) return { error: error?.message ?? 'Insert failed' };
  const { error: e2 } = await db.from('hr_ot_lines').insert(input.employeeIds.map((employee_id) => ({ ot_id: ot.id, employee_id })));
  return e2 ? { error: e2.message } : { ok: true };
}

export async function cancelOtAction(team: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: o } = await db.from('hr_ot_requests').select('team, status').eq('id', id).single();
  if (!o || o.team !== team) return { error: 'Not found' };
  if (o.status !== 'pending_giang') return { error: 'Already decided by Mr Giang' };
  const { error } = await db.from('hr_ot_requests').update({ status: 'cancelled' }).eq('id', id);
  return error ? { error: error.message } : { ok: true };
}
