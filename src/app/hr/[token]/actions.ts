'use server';
// HR pilot — employee side ("Của tôi" tab in the station, or the personal link /hr/<token>).
// Axel, 2026-11-06. The token is the only key: every action re-reads the employee from it and only
// touches that employee's own rows. Round 2 (Hưng's review): the employee sees the team's week,
// cannot change the schedule — only requests a day off (accepted at once while the day has room,
// first come first served) or cancels it before the Saturday deadline, and adds proof papers.
import {
  HR_OFF_CODES, HR_PROOF_TYPES, HR_REQUEST_TYPES, dm, dow, hanoiToday, hrTypeLabel, monthEnd, monthStart, offAllowance,
  offLimit, scheduleCode, weekStart, wishDeadline, type HrEmployee, type HrRequest,
} from '@/lib/hr';
import { hrLoadMonth, hrOffCount, hrPushLeader, hrRules, hrService, type HrMonthData } from '@/lib/hr-server';

const service = hrService;

async function me(token: string): Promise<HrEmployee | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !token || token.length < 16) return null;
  const { data } = await service().from('hr_employees').select('*').eq('access_token', token).eq('active', true).maybeSingle();
  return (data as HrEmployee) ?? null;
}

export type MeOt = { id: string; day: string; time_from: string; time_to: string; hours: number; reason: string | null; status: string; created_by_name: string | null; confirm: 'yes' | 'no' | null };
export type MeData = {
  employee: HrEmployee; week: HrMonthData; requests: HrRequest[]; ots: MeOt[]; otMonthHours: number;
  myOffDays: string[]; // upcoming day-off requests (all months)
};

export async function loadMeAction(token: string, month?: string): Promise<{ data?: MeData; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const db = service();
  const today = hanoiToday();
  const m = month && /^\d{4}-\d{2}-\d{2}$/.test(month) ? monthStart(month) : monthStart(today);
  const week = await hrLoadMonth(db, e.team, m);
  if ('error' in week) return { error: week.error };
  // Unpublished weeks: colleagues only see days off, not the leader's draft shifts.
  const pub = new Set(week.weeks.filter((w) => w.published).map((w) => w.start));
  for (const k of Object.keys(week.stored)) {
    const d = k.split('|')[1];
    if (!pub.has(weekStart(d)) && !HR_OFF_CODES.includes(week.stored[k] as any) && week.stored[k] !== 'PH') delete week.stored[k];
  }
  const [reqs, lines, offs] = await Promise.all([
    db.from('hr_requests').select('*').eq('employee_id', e.id).order('created_at', { ascending: false }).limit(30),
    db.from('hr_ot_lines').select('confirm, hr_ot_requests(id, day, time_from, time_to, hours, reason, status, created_by_name)').eq('employee_id', e.id),
    db.from('hr_off_wishes').select('day').eq('employee_id', e.id).gte('day', today).order('day'),
  ]);
  const ots = (lines.data ?? []).map((l: any) => ({ ...l.hr_ot_requests, hours: Number(l.hr_ot_requests?.hours ?? 0), confirm: l.confirm }))
    .filter((o: any) => o.id && o.status !== 'cancelled')
    .sort((a: any, b: any) => (a.day < b.day ? 1 : -1));
  const cur = monthStart(today);
  const otMonthHours = ots.filter((o: any) => o.day.startsWith(cur.slice(0, 7)) && o.status !== 'rejected' && o.confirm !== 'no').reduce((s: number, o: any) => s + o.hours, 0);
  return {
    data: {
      employee: { ...e, access_token: undefined }, week, requests: (reqs.data ?? []) as HrRequest[], ots, otMonthHours,
      myOffDays: (offs.data ?? []).map((o: any) => o.day),
    },
  };
}

// Ask for a day off. Accepted at once if: before the Saturday deadline, the week is not published,
// the monthly allowance (= Sundays in the month) and the Sat/Sun caps are not reached, and the day
// still has room in the team (first come, first served — re-checked after the insert for races).
export async function requestOffAction(token: string, day: string): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Bad day' };
  const db = service();
  const today = hanoiToday();
  const ws = weekStart(day);
  if (day <= today || today > wishDeadline(ws)) return { error: 'CLOSED' };
  const { data: wk } = await db.from('hr_schedule_weeks').select('status').eq('team', e.team).eq('week_start', ws).maybeSingle();
  if (wk?.status === 'published') return { error: 'CLOSED' };
  const { data: st } = await db.from('hr_schedule_days').select('code').eq('employee_id', e.id).eq('day', day).maybeSingle();
  if (st?.code && st.code !== '7' && st.code !== '8') return { error: 'ALREADY' };
  const rules = await hrRules(db, e.team);
  if (!e.is_casual) {
    const m = monthStart(day);
    const [{ data: wi }, { data: so }] = await Promise.all([
      db.from('hr_off_wishes').select('day').eq('employee_id', e.id).gte('day', m).lte('day', monthEnd(m)),
      db.from('hr_schedule_days').select('day, code').eq('employee_id', e.id).gte('day', m).lte('day', monthEnd(m)),
    ]);
    const stored: Record<string, string> = {};
    for (const r of so ?? []) stored[e.id + '|' + r.day] = r.code;
    const wset = new Set<string>((wi ?? []).map((w: any) => e.id + '|' + w.day));
    const offs: string[] = [];
    for (const k of Array.from(wset)) { const d = k.split('|')[1]; if (scheduleCode(e, d, stored, wset) === 'O') offs.push(d); }
    for (const r of so ?? []) if (r.code === 'O' && !wset.has(e.id + '|' + r.day)) offs.push(r.day);
    if (offs.length >= offAllowance(m)) return { error: 'MAX_DAYS' };
    if (dow(day) === 6 && rules.max_sat_month != null && offs.filter((d) => dow(d) === 6).length >= rules.max_sat_month) return { error: 'MAX_SAT' };
    if (dow(day) === 0 && rules.max_sun_month != null && offs.filter((d) => dow(d) === 0).length >= rules.max_sun_month) return { error: 'MAX_SUN' };
    if ((await hrOffCount(db, e.team, day, e.id)) >= offLimit(rules, day)) return { error: 'FULL' };
  }
  const { error } = await db.from('hr_off_wishes').insert({ employee_id: e.id, day });
  if (error) return { error: error.message.includes('duplicate') ? 'ALREADY' : error.message };
  if (!e.is_casual && (await hrOffCount(db, e.team, day)) > offLimit(rules, day)) {
    // Someone else got the last place at the same moment: the first one keeps it.
    await db.from('hr_off_wishes').delete().eq('employee_id', e.id).eq('day', day);
    return { error: 'FULL' };
  }
  await hrPushLeader(db, e.team, `${e.full_name} xin nghỉ ${dm(day)}`, `${e.full_name} takes ${dm(day)} off`);
  return { ok: true };
}

export async function cancelOffAction(token: string, day: string): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const db = service();
  const ws = weekStart(day);
  if (hanoiToday() > wishDeadline(ws)) return { error: 'CLOSED' };
  const { data: wk } = await db.from('hr_schedule_weeks').select('status').eq('team', e.team).eq('week_start', ws).maybeSingle();
  if (wk?.status === 'published') return { error: 'CLOSED' };
  const { error } = await db.from('hr_off_wishes').delete().eq('employee_id', e.id).eq('day', day);
  if (error) return { error: error.message };
  await hrPushLeader(db, e.team, `${e.full_name} hủy nghỉ ${dm(day)}`, `${e.full_name} cancelled day off ${dm(day)}`);
  return { ok: true };
}

export async function submitRequestAction(token: string, input: {
  type: string; day_from: string; day_to?: string; time_from?: string; time_to?: string; reason?: string; swap_with?: string;
}): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  if (!HR_REQUEST_TYPES.some((t) => t.id === input.type)) return { error: 'Bad type' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day_from)) return { error: 'Date missing' };
  if (input.day_to && input.day_to < input.day_from) return { error: 'End date before start date' };
  const db = service();
  if (input.swap_with) {
    const { data: c } = await db.from('hr_employees').select('team').eq('id', input.swap_with).single();
    if (c?.team !== e.team) return { error: 'Colleague not in your team' };
  }
  const { error } = await db.from('hr_requests').insert({
    employee_id: e.id, team: e.team, type: input.type, day_from: input.day_from, day_to: input.day_to || null,
    time_from: input.time_from || null, time_to: input.time_to || null, reason: (input.reason ?? '').slice(0, 500) || null,
    swap_with: input.type === 'swap' ? input.swap_with || null : null,
  });
  if (error) return { error: error.message };
  await hrPushLeader(db, e.team, `${e.full_name}: ${hrTypeLabel(input.type, 'vi')} ${dm(input.day_from)}`, `${e.full_name}: ${hrTypeLabel(input.type, 'en')} ${dm(input.day_from)}`);
  return { ok: true };
}

export async function cancelRequestAction(token: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const { error } = await service().from('hr_requests').update({ status: 'cancelled' })
    .eq('id', id).eq('employee_id', e.id).eq('status', 'pending_leader');
  return error ? { error: error.message } : { ok: true };
}

// Proof paper (photo) added after the request — e.g. after the doctor.
export async function uploadProofAction(token: string, id: string, formData: FormData): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const db = service();
  const { data: r } = await db.from('hr_requests').select('employee_id, type, day_from').eq('id', id).single();
  if (!r || r.employee_id !== e.id) return { error: 'Not found' };
  if (!HR_PROOF_TYPES.includes(r.type)) return { error: 'No proof needed' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only photos' };
  if (file.size > 4 * 1024 * 1024) return { error: 'Photo too large' };
  const path = `${e.team}/${e.id}/${id}-${Date.now()}.jpg`;
  const { error: upErr } = await db.storage.from('hr-proofs').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (upErr) return { error: upErr.message };
  const { error } = await db.from('hr_requests').update({ proof_path: path, proof_at: new Date().toISOString(), no_proof: false }).eq('id', id);
  if (error) return { error: error.message };
  await hrPushLeader(db, e.team, `${e.full_name} đã gửi giấy tờ (${hrTypeLabel(r.type, 'vi')} ${dm(r.day_from)})`, `${e.full_name} added a proof (${hrTypeLabel(r.type, 'en')} ${dm(r.day_from)})`);
  return { ok: true };
}

export async function confirmOtAction(token: string, otId: string, answer: 'yes' | 'no'): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const { error } = await service().from('hr_ot_lines').update({ confirm: answer, confirmed_at: new Date().toISOString() })
    .eq('ot_id', otId).eq('employee_id', e.id);
  return error ? { error: error.message } : { ok: true };
}
