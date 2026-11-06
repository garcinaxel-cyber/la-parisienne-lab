// HR pilot — server-only helpers shared by the leader actions (station "Nhóm" tab) and the employee
// actions ("Của tôi" tab / personal link). Service-role client: hr_* tables have RLS on, no policies.
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  HR_DEFAULT_RULES, HR_OFF_CODES, addDays, dayStr, daysInMonth, dow, hrRequestCode, monthEnd, monthStart,
  offAllowance, scheduleCode, weekStart, type HrEmployee, type HrRules,
} from '@/lib/hr';
import { awaitPush, sendUsersPush } from '@/lib/push-notify';

export function hrService(): SupabaseClient {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export async function hrRules(db: SupabaseClient, team: string): Promise<HrRules> {
  const { data } = await db.from('hr_team_rules').select('max_off_weekday, max_off_weekend, max_sat_month, max_sun_month').eq('team', team).maybeSingle();
  return (data as HrRules) ?? HR_DEFAULT_RULES;
}

export type HrMonthData = {
  month: string; days: string[]; // Monday of the month's first week → Sunday of its last week
  weeks: { start: string; published: boolean }[];
  allowance: number; employees: HrEmployee[]; stored: Record<string, string>; wishes: string[]; rules: HrRules;
  monthOff: Record<string, number>; monthSat: Record<string, number>; monthSun: Record<string, number>;
};

// A whole month as one continuous strip of full weeks (Hưng, 2026-11-06: scroll right through the
// month instead of jumping week by week). Publication stays per week.
export async function hrLoadMonth(db: SupabaseClient, team: string, month: string, withTokens = false): Promise<HrMonthData | { error: string }> {
  const m = monthStart(month);
  const from = weekStart(m);
  const to = addDays(weekStart(monthEnd(m)), 6);
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const starts = days.filter((_, i) => i % 7 === 0);
  const cols = withTokens ? '*' : 'id, team, full_name, position, base_shift, clock_id, is_leader, is_casual, sort_order, profile_id';
  const { data: emps, error } = await db.from('hr_employees').select(cols).eq('team', team).eq('active', true).order('sort_order');
  if (error) return { error: error.message.includes('does not exist') ? 'HR_NOT_INSTALLED' : error.message };
  const employees = (emps ?? []) as unknown as HrEmployee[];
  const ids = employees.map((e) => e.id);
  const [st, wi, wk, rules] = await Promise.all([
    ids.length ? db.from('hr_schedule_days').select('employee_id, day, code').in('employee_id', ids).gte('day', from).lte('day', to) : Promise.resolve({ data: [] as any[] }),
    ids.length ? db.from('hr_off_wishes').select('employee_id, day').in('employee_id', ids).gte('day', from).lte('day', to) : Promise.resolve({ data: [] as any[] }),
    db.from('hr_schedule_weeks').select('week_start, status').eq('team', team).in('week_start', starts),
    hrRules(db, team),
  ]);
  const stored: Record<string, string> = {};
  for (const r of (st as any).data ?? []) stored[r.employee_id + '|' + r.day] = r.code;
  const wishes = ((wi as any).data ?? []).map((w: any) => w.employee_id + '|' + w.day);
  const wset = new Set<string>(wishes);
  const pub = new Set(((wk as any).data ?? []).filter((w: any) => w.status === 'published').map((w: any) => w.week_start));
  const monthOff: Record<string, number> = {}, monthSat: Record<string, number> = {}, monthSun: Record<string, number> = {};
  const n = daysInMonth(m);
  for (const e of employees) {
    let o = 0, sa = 0, su = 0;
    for (let d = 1; d <= n; d++) {
      const day = dayStr(m, d);
      if (scheduleCode(e, day, stored, wset) === 'O') { o++; if (dow(day) === 6) sa++; if (dow(day) === 0) su++; }
    }
    monthOff[e.id] = o; monthSat[e.id] = sa; monthSun[e.id] = su;
  }
  return {
    month: m, days, weeks: starts.map((start) => ({ start, published: pub.has(start) })),
    allowance: offAllowance(m), employees, stored, wishes, rules, monthOff, monthSat, monthSun,
  };
}

// People off on a day (casual staff excluded), optionally ignoring one employee.
export async function hrOffCount(db: SupabaseClient, team: string, day: string, exceptId?: string): Promise<number> {
  const { data: emps } = await db.from('hr_employees').select('id, base_shift').eq('team', team).eq('active', true).eq('is_casual', false);
  const list = (emps ?? []).filter((e: any) => e.id !== exceptId);
  const ids = list.map((e: any) => e.id);
  if (!ids.length) return 0;
  const [st, wi] = await Promise.all([
    db.from('hr_schedule_days').select('employee_id, day, code').in('employee_id', ids).eq('day', day),
    db.from('hr_off_wishes').select('employee_id, day').in('employee_id', ids).eq('day', day),
  ]);
  const stored: Record<string, string> = {};
  for (const r of st.data ?? []) stored[r.employee_id + '|' + r.day] = r.code;
  const wset = new Set<string>((wi.data ?? []).map((w: any) => w.employee_id + '|' + w.day));
  return list.filter((e: any) => HR_OFF_CODES.includes(scheduleCode(e, day, stored, wset))).length;
}

// Days covered by a request (inclusive), capped at 62 days.
export function hrRequestDays(r: { day_from: string; day_to: string | null }): string[] {
  const out: string[] = [];
  const end = r.day_to && r.day_to >= r.day_from ? r.day_to : r.day_from;
  for (let d = r.day_from; d <= end && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}

// Approved by the leader → the leave code goes into the schedule (and replaces a day-off request).
export async function hrApplyRequest(db: SupabaseClient, r: { employee_id: string; type: string; day_from: string; day_to: string | null }, by: string) {
  const code = hrRequestCode(r.type);
  if (!code) return;
  const days = hrRequestDays(r);
  await db.from('hr_schedule_days').upsert(days.map((day) => ({ employee_id: r.employee_id, day, code, updated_by: by, updated_at: new Date().toISOString() })));
  await db.from('hr_off_wishes').delete().eq('employee_id', r.employee_id).in('day', days);
}
// Undo: remove the leave code again (only where it is still the code we wrote).
export async function hrUnapplyRequest(db: SupabaseClient, r: { employee_id: string; type: string; day_from: string; day_to: string | null }) {
  const code = hrRequestCode(r.type);
  if (!code) return;
  await db.from('hr_schedule_days').delete().eq('employee_id', r.employee_id).eq('code', code).in('day', hrRequestDays(r));
}

// Push helpers — best effort, never break the action.
export async function hrPushLeader(db: SupabaseClient, team: string, vi: string, en: string) {
  const { data } = await db.from('hr_employees').select('profile_id').eq('team', team).eq('is_leader', true).eq('active', true);
  const ids = (data ?? []).map((x: any) => x.profile_id).filter(Boolean);
  if (!ids.length) return;
  await awaitPush(sendUsersPush(db, ids, { title: 'Nhóm · Nhân sự', body: vi, url: `/station/${team}`, tag: 'hr-' + team },
    { title: 'Team · HR', body: en, url: `/station/${team}`, tag: 'hr-' + team }));
}
export async function hrPushEmployees(db: SupabaseClient, team: string, employeeIds: string[] | 'all', vi: string, en: string) {
  let q = db.from('hr_employees').select('profile_id').eq('team', team).eq('active', true);
  if (employeeIds !== 'all') q = q.in('id', employeeIds);
  const { data } = await q;
  const ids = (data ?? []).map((x: any) => x.profile_id).filter(Boolean);
  if (!ids.length) return;
  await awaitPush(sendUsersPush(db, ids, { title: 'Của tôi · Nhân sự', body: vi, url: `/station/${team}`, tag: 'hr-me' },
    { title: 'Me · HR', body: en, url: `/station/${team}`, tag: 'hr-me' }));
}

export { monthStart };
