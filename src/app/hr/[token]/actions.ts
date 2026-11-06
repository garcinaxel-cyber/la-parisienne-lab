'use server';
// HR pilot — employee side (personal link /hr/<token>, no password — same posture as the shop order
// link /order/<token>). Axel, 2026-11-06. The token is the only key: every action re-reads the
// employee from it and only touches that employee's own rows.
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  HR_REQUEST_TYPES, HR_RULES, addMonths, daysInMonth, dayStr, dow, hanoiToday, isWeekend, monthStart,
  type HrEmployee, type HrRequest,
} from '@/lib/hr';

function service() {
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

async function me(token: string): Promise<HrEmployee | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !token || token.length < 16) return null;
  const { data } = await service().from('hr_employees').select('*').eq('access_token', token).eq('active', true).maybeSingle();
  return (data as HrEmployee) ?? null;
}

export type MeData = {
  employee: HrEmployee; colleagues: { id: string; full_name: string }[];
  months: { month: string; published: boolean; stored: Record<string, string>; myWishes: string[] }[];
  wishMonth: string; wishOpen: boolean; myNextWishes: string[]; wishSubmitted: boolean; teamWishCount: Record<string, number>;
  requests: HrRequest[];
  ots: { id: string; day: string; time_from: string; time_to: string; hours: number; reason: string | null; status: string; created_by_name: string | null; confirm: 'yes' | 'no' | null }[];
  otMonthHours: number;
};

export async function loadMeAction(token: string): Promise<{ data?: MeData; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const db = service();
  const today = hanoiToday();
  const cur = monthStart(today);
  const next = addMonths(cur, 1);
  const end = dayStr(next, daysInMonth(next));
  const [cols, days, mstat, wishes, submit, reqs, lines] = await Promise.all([
    db.from('hr_employees').select('id, full_name, is_casual').eq('team', e.team).eq('active', true).order('sort_order'),
    db.from('hr_schedule_days').select('day, code').eq('employee_id', e.id).gte('day', cur).lte('day', end),
    db.from('hr_schedule_months').select('month, status').eq('team', e.team).in('month', [cur, next]),
    db.from('hr_off_wishes').select('employee_id, day').gte('day', cur).lte('day', end),
    db.from('hr_off_wish_submits').select('month').eq('employee_id', e.id).eq('month', next).maybeSingle(),
    db.from('hr_requests').select('*').eq('employee_id', e.id).order('created_at', { ascending: false }).limit(30),
    db.from('hr_ot_lines').select('confirm, hr_ot_requests(id, day, time_from, time_to, hours, reason, status, created_by_name)').eq('employee_id', e.id),
  ]);
  const teamIds = new Set((cols.data ?? []).map((c: any) => c.id));
  const regularIds = new Set((cols.data ?? []).filter((c: any) => !c.is_casual).map((c: any) => c.id));
  const allWishes = (wishes.data ?? []).filter((w: any) => teamIds.has(w.employee_id));
  const stored: Record<string, string> = {};
  for (const d of days.data ?? []) stored[d.day] = d.code;
  const pub = new Set((mstat.data ?? []).filter((m: any) => m.status === 'published').map((m: any) => m.month));
  const months = [cur, next].map((m) => ({
    month: m, published: pub.has(m), stored,
    myWishes: allWishes.filter((w: any) => w.employee_id === e.id && w.day.startsWith(m.slice(0, 7))).map((w: any) => w.day),
  }));
  const teamWishCount: Record<string, number> = {};
  for (const w of allWishes) {
    if (w.employee_id === e.id || !regularIds.has(w.employee_id) || !w.day.startsWith(next.slice(0, 7))) continue;
    teamWishCount[w.day] = (teamWishCount[w.day] ?? 0) + 1;
  }
  const ots = (lines.data ?? []).map((l: any) => ({ ...l.hr_ot_requests, hours: Number(l.hr_ot_requests?.hours ?? 0), confirm: l.confirm }))
    .filter((o: any) => o.id && o.status !== 'cancelled')
    .sort((a: any, b: any) => (a.day < b.day ? 1 : -1));
  const otMonthHours = ots.filter((o: any) => o.day.startsWith(cur.slice(0, 7)) && o.status !== 'rejected' && o.confirm !== 'no').reduce((s: number, o: any) => s + o.hours, 0);
  return {
    data: {
      employee: { ...e, access_token: undefined }, colleagues: (cols.data ?? []).filter((c: any) => c.id !== e.id).map((c: any) => ({ id: c.id, full_name: c.full_name })),
      months, wishMonth: next, wishOpen: Number(today.slice(8, 10)) <= HR_RULES.wishDeadlineDay,
      myNextWishes: months[1].myWishes, wishSubmitted: !!submit.data, teamWishCount,
      requests: (reqs.data ?? []) as HrRequest[], ots, otMonthHours,
    },
  };
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
  return error ? { error: error.message } : { ok: true };
}

export async function cancelRequestAction(token: string, id: string): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const { error } = await service().from('hr_requests').update({ status: 'cancelled' })
    .eq('id', id).eq('employee_id', e.id).eq('status', 'pending_leader');
  return error ? { error: error.message } : { ok: true };
}

export async function confirmOtAction(token: string, otId: string, answer: 'yes' | 'no'): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const { error } = await service().from('hr_ot_lines').update({ confirm: answer, confirmed_at: new Date().toISOString() })
    .eq('ot_id', otId).eq('employee_id', e.id);
  return error ? { error: error.message } : { ok: true };
}

// Off-day wishes for next month — rules enforced here too (not only in the screen).
export async function saveWishesAction(token: string, month: string, days: string[]): Promise<{ ok?: boolean; error?: string }> {
  const e = await me(token);
  if (!e) return { error: 'INVALID' };
  const today = hanoiToday();
  const next = addMonths(monthStart(today), 1);
  if (month !== next) return { error: 'Wrong month' };
  if (Number(today.slice(8, 10)) > HR_RULES.wishDeadlineDay) return { error: 'CLOSED' };
  const uniq = Array.from(new Set(days)).filter((d) => d.startsWith(month.slice(0, 7))).sort();
  if (uniq.some((d) => Number(d.slice(8)) > daysInMonth(month))) return { error: 'Bad day' };
  if (!e.is_casual) {
    if (uniq.length > HR_RULES.offPerMonth) return { error: 'MAX_DAYS' };
    if (uniq.filter((d) => dow(d) === 6).length > HR_RULES.maxSat) return { error: 'MAX_SAT' };
    if (uniq.filter((d) => dow(d) === 0).length > HR_RULES.maxSun) return { error: 'MAX_SUN' };
  }
  const db = service();
  const { data: mine } = await db.from('hr_off_wishes').select('day').eq('employee_id', e.id).gte('day', month).lte('day', dayStr(month, daysInMonth(month)));
  const already = new Set((mine ?? []).map((w: any) => w.day));
  const added = uniq.filter((d) => !already.has(d));
  if (added.length && !e.is_casual) {
    // First registered, first served: a day already at the team limit cannot be added.
    const { data: cols } = await db.from('hr_employees').select('id').eq('team', e.team).eq('active', true).eq('is_casual', false).neq('id', e.id);
    const ids = (cols ?? []).map((c: any) => c.id);
    const { data: others } = ids.length ? await db.from('hr_off_wishes').select('day').in('employee_id', ids).in('day', added) : { data: [] as any[] };
    const cnt: Record<string, number> = {};
    for (const o of others ?? []) cnt[o.day] = (cnt[o.day] ?? 0) + 1;
    const full = added.find((d) => (cnt[d] ?? 0) >= (isWeekend(d) ? HR_RULES.maxOffWeekend : HR_RULES.maxOffWeekday));
    if (full) return { error: 'FULL:' + full };
  }
  const removed = Array.from(already).filter((d) => !uniq.includes(d));
  if (removed.length) await db.from('hr_off_wishes').delete().eq('employee_id', e.id).in('day', removed);
  if (added.length) {
    const { error } = await db.from('hr_off_wishes').insert(added.map((day) => ({ employee_id: e.id, day })));
    if (error) return { error: error.message };
  }
  await db.from('hr_off_wish_submits').upsert({ employee_id: e.id, month, submitted_at: new Date().toISOString() });
  return { ok: true };
}
