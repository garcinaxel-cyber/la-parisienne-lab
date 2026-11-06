'use server';
// HR pilot — team leader side (station "Nhóm" tab). Axel, 2026-11-06 (round 2 after Hưng's review:
// weekly schedule + publication, team holidays, leave written into the schedule, proof papers,
// employees without the app managed by the leader).
// Session = who clicked; writes go through the service-role client (hr_* tables: RLS on, no policies).
// Allowed: admin / lab_manager, or the hr_employees row flagged leader whose profile_id is the user.
import { createClient, getSafeSession } from '@/lib/supabase-server';
import {
  HR_PICK, HR_PILOT_TEAMS, addDays, dm, hoursBetween, hrNeedsGiang, hrTypeLabel, monthEnd,
  type HrOt, type HrRequest,
} from '@/lib/hr';
import {
  hrApplyRequest, hrLoadMonth, hrPushEmployees, hrRequestDays, hrService, hrUnapplyRequest, type HrMonthData,
} from '@/lib/hr-server';

const service = hrService;

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

export type TeamHrData = { week: HrMonthData; requests: HrRequest[]; ots: HrOt[]; otHours: Record<string, number> };

export async function loadTeamHrAction(team: string, month: string): Promise<{ data?: TeamHrData; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(month)) return { error: 'Bad month' };
  const db = service();
  const week = await hrLoadMonth(db, team, month, true);
  if ('error' in week) return { error: week.error };
  month = week.month;
  const [reqs, ots] = await Promise.all([
    db.from('hr_requests').select('*').eq('team', team).order('created_at', { ascending: false }).limit(100),
    db.from('hr_ot_requests').select('*, hr_ot_lines(employee_id, confirm)').eq('team', team).gte('day', month).lte('day', monthEnd(month)).order('day', { ascending: false }),
  ]);
  const requests = (reqs.data ?? []) as HrRequest[];
  // Proof photos: private bucket, short signed URLs for the leader only.
  for (const r of requests) {
    if (!r.proof_path) continue;
    const { data } = await db.storage.from('hr-proofs').createSignedUrl(r.proof_path, 3600);
    r.proof_url = data?.signedUrl ?? null;
  }
  const otList: HrOt[] = (ots.data ?? []).map((o: any) => ({ ...o, hours: Number(o.hours), lines: o.hr_ot_lines ?? [] }));
  const otHours: Record<string, number> = {};
  for (const o of otList) {
    if (o.status === 'rejected' || o.status === 'cancelled') continue;
    for (const l of o.lines) if (l.confirm !== 'no') otHours[l.employee_id] = (otHours[l.employee_id] ?? 0) + o.hours;
  }
  return { data: { week, requests, ots: otList, otHours } };
}

// code '' = back to the default (base shift or the employee's day-off request).
export async function setScheduleCodeAction(team: string, employeeId: string, day: string, code: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  if (code && !HR_PICK.includes(code as any)) return { error: 'Bad code' };
  const db = service();
  const { data: emp } = await db.from('hr_employees').select('team').eq('id', employeeId).single();
  if (emp?.team !== team) return { error: 'Not allowed' };
  if (!code) {
    const { error } = await db.from('hr_schedule_days').delete().eq('employee_id', employeeId).eq('day', day);
    return error ? { error: error.message } : { ok: true };
  }
  const { error } = await db.from('hr_schedule_days').upsert({ employee_id: employeeId, day, code, updated_by: g.name, updated_at: new Date().toISOString() });
  return error ? { error: error.message } : { ok: true };
}

// Mandatory holiday chosen by the leader: PH for the whole team that day (or removed again).
export async function setHolidayAction(team: string, day: string, on: boolean): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: emps } = await db.from('hr_employees').select('id').eq('team', team).eq('active', true);
  const ids = (emps ?? []).map((e: any) => e.id);
  if (!ids.length) return { ok: true };
  if (on) {
    const { error } = await db.from('hr_schedule_days').upsert(ids.map((employee_id: string) => ({ employee_id, day, code: 'PH', updated_by: g.name, updated_at: new Date().toISOString() })));
    if (error) return { error: error.message };
    await db.from('hr_off_wishes').delete().in('employee_id', ids).eq('day', day);
  } else {
    const { error } = await db.from('hr_schedule_days').delete().in('employee_id', ids).eq('day', day).eq('code', 'PH');
    if (error) return { error: error.message };
  }
  return { ok: true };
}

export async function setWeekStatusAction(team: string, ws: string, status: 'draft' | 'published'): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { error } = await db.from('hr_schedule_weeks').upsert({
    team, week_start: ws, status, published_at: status === 'published' ? new Date().toISOString() : null, published_by: status === 'published' ? g.name : null,
  });
  if (error) return { error: error.message };
  if (status === 'published') {
    const end = addDays(ws, 6);
    await hrPushEmployees(db, team, 'all', `Lịch tuần ${dm(ws)} – ${dm(end)} đã công bố`, `Schedule ${dm(ws)} – ${dm(end)} published`);
  }
  return { ok: true };
}

export async function decideRequestAction(team: string, id: string, decision: 'ok' | 'reject' | 'undo'): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: r } = await db.from('hr_requests').select('*').eq('id', id).single();
  if (!r || r.team !== team) return { error: 'Not found' };
  let patch: Record<string, unknown>;
  if (decision === 'undo') {
    // Only while Mr Giang has not decided yet.
    if (!['pending_giang', 'rejected', 'approved'].includes(r.status) || (r.status === 'approved' && hrNeedsGiang(r.type))) return { error: 'Too late to undo' };
    patch = { status: 'pending_leader', leader_name: null, leader_at: null };
    if (r.status !== 'rejected') await hrUnapplyRequest(db, r);
  } else {
    if (r.status !== 'pending_leader') return { error: 'Already decided' };
    patch = {
      status: decision === 'reject' ? 'rejected' : hrNeedsGiang(r.type) ? 'pending_giang' : 'approved',
      leader_name: g.name, leader_at: new Date().toISOString(),
    };
  }
  const { error } = await db.from('hr_requests').update(patch).eq('id', id);
  if (error) return { error: error.message };
  if (decision === 'ok') await hrApplyRequest(db, r, g.name);
  if (decision !== 'undo') {
    const what = `${hrTypeLabel(r.type, 'vi')} ${dm(r.day_from)}`;
    const whatEn = `${hrTypeLabel(r.type, 'en')} ${dm(r.day_from)}`;
    await hrPushEmployees(db, team, [r.employee_id],
      decision === 'ok' ? `✓ Trưởng nhóm đồng ý: ${what}` : `✕ Trưởng nhóm từ chối: ${what}`,
      decision === 'ok' ? `✓ Leader approved: ${whatEn}` : `✕ Leader rejected: ${whatEn}`);
  }
  return { ok: true };
}

// No proof paper → the leave days become days off (counted in the employee's monthly days off).
export async function noProofAction(team: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: r } = await db.from('hr_requests').select('*').eq('id', id).single();
  if (!r || r.team !== team) return { error: 'Not found' };
  if (r.proof_path) return { error: 'A proof was added' };
  const days = hrRequestDays(r);
  const { error } = await db.from('hr_schedule_days').upsert(days.map((day) => ({ employee_id: r.employee_id, day, code: 'O', updated_by: g.name, updated_at: new Date().toISOString() })));
  if (error) return { error: error.message };
  await db.from('hr_requests').update({ no_proof: true }).eq('id', id);
  await hrPushEmployees(db, team, [r.employee_id], `Không có giấy tờ: ${dm(r.day_from)} tính là ngày nghỉ`, `No proof: ${dm(r.day_from)} counted as a day off`);
  return { ok: true };
}

// Part-time / seasonal staff without the app: the leader adds them and fills their schedule.
export async function addEmployeeAction(team: string, input: { full_name: string; position: string; base_shift: string; is_casual: boolean }): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const name = input.full_name.trim().slice(0, 80);
  if (name.length < 2) return { error: 'Name missing' };
  const db = service();
  const { data: last } = await db.from('hr_employees').select('sort_order').eq('team', team).order('sort_order', { ascending: false }).limit(1);
  const { error } = await db.from('hr_employees').insert({
    team, full_name: name, position: input.position.trim().slice(0, 40) || null, base_shift: input.base_shift === '8' ? '8' : '7',
    is_casual: !!input.is_casual, sort_order: ((last?.[0] as any)?.sort_order ?? 0) + 1,
  });
  return error ? { error: error.message } : { ok: true };
}

export async function removeEmployeeAction(team: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const g = await guard(team);
  if ('error' in g) return { error: g.error };
  const db = service();
  const { data: e } = await db.from('hr_employees').select('team, is_leader').eq('id', id).single();
  if (!e || e.team !== team || e.is_leader) return { error: 'Not allowed' };
  const { error } = await db.from('hr_employees').update({ active: false }).eq('id', id);
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
  if (e2) return { error: e2.message };
  await hrPushEmployees(db, team, input.employeeIds, `Tăng ca ${dm(input.day)} ${input.time_from}–${input.time_to}: vui lòng xác nhận`, `Overtime ${dm(input.day)} ${input.time_from}–${input.time_to}: please confirm`);
  return { ok: true };
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
