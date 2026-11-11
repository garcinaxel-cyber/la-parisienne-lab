// HR pilot (Axel, 2026-11-06) — schedules, requests and overtime in the app, Team Hưng first.
// Shared, client-safe helpers: types, team rules, labels (EN/VI) and date helpers.
// Pay rules (Trang, 2026-11-04): 9 h on site = 1 day (8 h + 1 h break), pro rata; overtime = time beyond
// 9 h, paid only with an approved request (team leader → Mr Giang).
// Round 2 after Hưng's review (2026-11-06): the schedule is published WEEK by week; a day-off request
// is accepted automatically while the day has room (first come, first served — Macaron: 2 off on a
// weekday, 3 on Saturday/Sunday, rules per team); requests for next week close on the Saturday before;
// days off allowed a month = number of Sundays in the month; employees see the whole team's week;
// approved leave is written into the schedule; sick & co need a proof paper, no proof → the leader
// turns the day into a day off.

export const HR_PILOT_TEAMS = ['hung'];

// Half days (2026-11-11): S = works the morning only, C = the afternoon only (fixed halves of the base
// shift). A half day off = 0.5 of the monthly days off, always accepted, outside the per-day limit.
export type HrCode = '7' | '8' | 'S' | 'C' | 'O' | 'AL' | 'PH' | 'SN' | 'OM' | 'KL' | 'CD';
export const HR_PICK: HrCode[] = ['7', '8', 'S', 'C', 'O', 'AL', 'SN', 'OM', 'KL', 'CD', 'PH'];
export const HR_HALF_CODES: HrCode[] = ['S', 'C'];
// Weight of a code in the monthly days-off counter.
export const offWeight = (c: string) => (c === 'O' ? 1 : c === 'S' || c === 'C' ? 0.5 : 0);
// Hours of each half, from the base shift (7 → 07–16, 8 → 08–17, 1 h break at midday).
export function halfHours(code: string, baseShift: string): string {
  const s = baseShift === '8' ? 8 : 7;
  const p = (h: number) => String(h).padStart(2, '0') + ':00';
  return code === 'S' ? `${p(s)}–${p(s + 4)}` : `${p(s + 5)}–${p(s + 9)}`;
}
export const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
// Codes that count against the "people off that day" limit (PH = everybody off, not counted).
export const HR_OFF_CODES: HrCode[] = ['O', 'AL', 'SN', 'OM', 'KL', 'CD'];
export const HR_CODE_LABEL: Record<string, { en: string; vi: string }> = {
  '7': { en: 'Shift 07:00–16:00', vi: 'Ca 07:00–16:00' },
  '8': { en: 'Shift 08:00–17:00', vi: 'Ca 08:00–17:00' },
  S: { en: 'Morning only (half day)', vi: 'Làm buổi sáng (nửa ngày)' },
  C: { en: 'Afternoon only (half day)', vi: 'Làm buổi chiều (nửa ngày)' },
  O: { en: 'Day off', vi: 'Nghỉ' },
  AL: { en: 'Annual leave', vi: 'Phép năm' },
  PH: { en: 'Public holiday', vi: 'Ngày lễ' },
  SN: { en: 'Birthday leave', vi: 'Nghỉ sinh nhật' },
  OM: { en: 'Sick', vi: 'Ốm' },
  KL: { en: 'Unpaid leave', vi: 'Nghỉ không lương' },
  CD: { en: 'Leave (wedding, bereavement…)', vi: 'Nghỉ chế độ' },
};
export const HR_OT_CAP = 40;

export type HrRules = { max_off_weekday: number; max_off_weekend: number; max_sat_month: number | null; max_sun_month: number | null };
export const HR_DEFAULT_RULES: HrRules = { max_off_weekday: 2, max_off_weekend: 3, max_sat_month: null, max_sun_month: null };

export type HrEmployee = {
  id: string; team: string; full_name: string; position: string | null; base_shift: string;
  clock_id: string | null; is_leader: boolean; is_casual: boolean; access_token?: string; sort_order: number;
  profile_id?: string | null;
};

export type HrRequest = {
  id: string; employee_id: string; team: string; type: string; day_from: string; day_to: string | null;
  time_from: string | null; time_to: string | null; swap_with: string | null; reason: string | null;
  status: 'pending_leader' | 'pending_giang' | 'approved' | 'rejected' | 'cancelled';
  leader_name: string | null; leader_at: string | null; giang_name: string | null; giang_at: string | null; created_at: string;
  proof_path?: string | null; proof_at?: string | null; no_proof?: boolean; proof_url?: string | null;
};

export type HrOt = {
  id: string; team: string; day: string; time_from: string; time_to: string; hours: number; reason: string | null;
  status: 'pending_giang' | 'approved' | 'rejected' | 'cancelled'; created_by_name: string | null; created_at: string;
  lines: { employee_id: string; confirm: 'yes' | 'no' | null }[];
};

export const HR_REQUEST_TYPES: { id: string; en: string; vi: string }[] = [
  { id: 'late', en: 'Late', vi: 'Đi muộn' },
  { id: 'early', en: 'Early leave', vi: 'Về sớm' },
  { id: 'annual', en: 'Annual leave', vi: 'Nghỉ phép' },
  { id: 'unpaid', en: 'Unpaid leave', vi: 'Nghỉ không lương' },
  { id: 'sick', en: 'Sick', vi: 'Nghỉ ốm' },
  { id: 'child_sick', en: 'Child sick', vi: 'Nghỉ con ốm' },
  { id: 'wedding', en: 'Wedding', vi: 'Nghỉ cưới' },
  { id: 'bereavement', en: 'Bereavement', vi: 'Nghỉ tang' },
  { id: 'prenatal', en: 'Prenatal check-up', vi: 'Nghỉ khám thai' },
  { id: 'maternity', en: 'Maternity', vi: 'Nghỉ thai sản' },
  { id: 'business_trip', en: 'Business trip', vi: 'Công tác' },
  { id: 'missed_punch', en: 'Missed punch', vi: 'Quên chấm công' },
  { id: 'swap', en: 'Shift swap', vi: 'Đổi ca' },
  { id: 'other', en: 'Other', vi: 'Lý do khác' },
];
export const hrTypeLabel = (id: string, lang: string) => {
  const t = HR_REQUEST_TYPES.find((x) => x.id === id);
  return t ? (lang === 'vi' ? t.vi : t.en) : id;
};
// Shift swaps only need the team leader; everything else goes on to Mr Giang.
export const hrNeedsGiang = (type: string) => type !== 'swap';
// Reasons that need a paper (doctor, certificate…) added after the request.
export const HR_PROOF_TYPES = ['sick', 'child_sick', 'wedding', 'bereavement', 'prenatal', 'maternity'];
// Code written into the schedule when the leader approves the request (null = schedule unchanged).
export function hrRequestCode(type: string): HrCode | null {
  if (type === 'annual') return 'AL';
  if (type === 'unpaid') return 'KL';
  if (type === 'sick' || type === 'child_sick') return 'OM';
  if (['wedding', 'bereavement', 'prenatal', 'maternity'].includes(type)) return 'CD';
  return null;
}

// ---------- dates (all YYYY-MM-DD strings, Hanoi calendar) ----------
export function hanoiToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
export function monthStart(d: string): string { return d.slice(0, 7) + '-01'; }
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function monthEnd(d: string): string { return dayStr(d, daysInMonth(d)); }
export function dayStr(month: string, d: number): string { return month.slice(0, 8) + String(d).padStart(2, '0'); }
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function dow(day: string): number { // 0 = Sunday
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export const isWeekend = (day: string) => dow(day) === 0 || dow(day) === 6;
export function weekStart(day: string): string { return addDays(day, -((dow(day) + 6) % 7)); } // Monday
// Day-off requests for a week close at the end of the Saturday before it.
export function wishDeadline(ws: string): string { return addDays(ws, -2); }
// Days off allowed in a month = number of Sundays in it (Hưng, 2026-11-06).
export function offAllowance(month: string): number {
  let n = 0; const last = daysInMonth(month);
  for (let d = 1; d <= last; d++) if (dow(dayStr(month, d)) === 0) n++;
  return n;
}
export const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(month: string, lang: string): string {
  const [y, m] = month.split('-').map(Number);
  return lang === 'vi' ? `Tháng ${m}/${y}` : `${MONTH_EN[m - 1]} ${y}`;
}
export function shortDay(day: string, lang: string): string {
  const [, m, d] = day.split('-');
  return `${(lang === 'vi' ? DOW_VI : DOW_EN)[dow(day)]} ${d}/${m}`;
}
export const dm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
export function hoursBetween(from: string, to: string): number {
  const [h1, m1] = from.split(':').map(Number);
  const [h2, m2] = to.split(':').map(Number);
  const h = (h2 * 60 + m2 - (h1 * 60 + m1)) / 60;
  return Math.max(0, Math.round(h * 4) / 4);
}

// ---------- schedule ----------
// Effective code: what the leader set, else a day-off request (auto-accepted; a half-day request gives
// S or C via `parts`), else the base shift.
export function scheduleCode(e: { id: string; base_shift: string }, day: string, stored: Record<string, string>, wishes: Set<string>, parts?: Record<string, string>): HrCode {
  const k = e.id + '|' + day;
  const s = stored[k];
  if (s) return s as HrCode;
  if (wishes.has(k)) return (parts?.[k] as HrCode) || 'O';
  return (e.base_shift === '8' ? '8' : '7');
}
export const offLimit = (rules: HrRules, day: string) => (isWeekend(day) ? rules.max_off_weekend : rules.max_off_weekday);

