// HR pilot (Axel, 2026-11-06) — schedules, requests and overtime in the app, Team Hưng first.
// Shared, client-safe helpers: types, team rules, labels (EN/VI) and date helpers.
// Pay rules (Trang, 2026-11-04): 9 h on site = 1 day (8 h + 1 h break), pro rata; overtime = time beyond
// 9 h, paid only with an approved request (team leader → Mr Giang). Team rules (Macaron paper schedule):
// 5 days off a month, max 2 Saturdays and 2 Sundays off, max 2 people off on a weekday and 3 on a
// weekend day, off-day wishes for next month before the 25th (first registered, first served).

export const HR_PILOT_TEAMS = ['hung'];

export type HrCode = '7' | '8' | 'O' | 'AL' | 'PH' | 'SN';
export const HR_CYCLE: HrCode[] = ['7', '8', 'O', 'AL', 'PH', 'SN'];
export const HR_OFF_CODES: HrCode[] = ['O', 'AL', 'SN']; // count against the "people off that day" limit
export const HR_RULES = { offPerMonth: 5, maxSat: 2, maxSun: 2, maxOffWeekday: 2, maxOffWeekend: 3, wishDeadlineDay: 25, otMonthCap: 40 };

export type HrEmployee = {
  id: string; team: string; full_name: string; position: string | null; base_shift: string;
  clock_id: string | null; is_leader: boolean; is_casual: boolean; access_token?: string; sort_order: number;
};

export type HrRequest = {
  id: string; employee_id: string; team: string; type: string; day_from: string; day_to: string | null;
  time_from: string | null; time_to: string | null; swap_with: string | null; reason: string | null;
  status: 'pending_leader' | 'pending_giang' | 'approved' | 'rejected' | 'cancelled';
  leader_name: string | null; leader_at: string | null; giang_name: string | null; giang_at: string | null; created_at: string;
};

export type HrOt = {
  id: string; team: string; day: string; time_from: string; time_to: string; hours: number; reason: string | null;
  status: 'pending_giang' | 'approved' | 'rejected' | 'cancelled'; created_by_name: string | null; created_at: string;
  lines: { employee_id: string; confirm: 'yes' | 'no' | null }[];
};

export const HR_REQUEST_TYPES: { id: string; en: string; vi: string; leaderOnly?: boolean }[] = [
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
  { id: 'swap', en: 'Shift swap', vi: 'Đổi ca', leaderOnly: true },
  { id: 'other', en: 'Other', vi: 'Lý do khác' },
];
export const hrTypeLabel = (id: string, lang: string) => {
  const t = HR_REQUEST_TYPES.find((x) => x.id === id);
  return t ? (lang === 'vi' ? t.vi : t.en) : id;
};
// Shift swaps only need the team leader; everything else goes on to Mr Giang.
export const hrNeedsGiang = (type: string) => type !== 'swap';

// ---------- dates (all YYYY-MM-DD strings, Hanoi calendar) ----------
export function hanoiToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
export function monthStart(d: string): string { return d.slice(0, 7) + '-01'; }
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return dt.toISOString().slice(0, 10);
}
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
export function dayStr(month: string, d: number): string { return month.slice(0, 8) + String(d).padStart(2, '0'); }
export function dow(day: string): number { // 0 = Sunday
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export const isWeekend = (day: string) => dow(day) === 0 || dow(day) === 6;
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
export function hoursBetween(from: string, to: string): number {
  const [h1, m1] = from.split(':').map(Number);
  const [h2, m2] = to.split(':').map(Number);
  const h = (h2 * 60 + m2 - (h1 * 60 + m1)) / 60;
  return Math.max(0, Math.round(h * 4) / 4);
}

// ---------- schedule rules ----------
export function scheduleCode(e: HrEmployee, day: string, stored: Record<string, string>, wishes: Set<string>): HrCode {
  const s = stored[e.id + '|' + day];
  if (s) return s as HrCode;
  if (wishes.has(e.id + '|' + day)) return 'O';
  return (e.base_shift === '8' ? '8' : '7');
}

export type HrAlert = { kind: 'day' | 'person'; day?: string; employee_id?: string; en: string; vi: string };

export function scheduleAlerts(month: string, emps: HrEmployee[], codeOf: (e: HrEmployee, day: string) => HrCode): HrAlert[] {
  const out: HrAlert[] = [];
  const n = daysInMonth(month);
  const regular = emps.filter((e) => !e.is_casual);
  for (let d = 1; d <= n; d++) {
    const day = dayStr(month, d);
    const off = regular.filter((e) => HR_OFF_CODES.includes(codeOf(e, day))).length;
    const lim = isWeekend(day) ? HR_RULES.maxOffWeekend : HR_RULES.maxOffWeekday;
    if (off > lim) out.push({ kind: 'day', day, en: `${shortDay(day, 'en')}: ${off} people off, max ${lim}`, vi: `${shortDay(day, 'vi')}: ${off} người nghỉ, tối đa ${lim}` });
  }
  for (const e of regular) {
    let o = 0, sat = 0, sun = 0;
    for (let d = 1; d <= n; d++) {
      const day = dayStr(month, d);
      if (codeOf(e, day) === 'O') { o++; if (dow(day) === 6) sat++; if (dow(day) === 0) sun++; }
    }
    if (o > HR_RULES.offPerMonth) out.push({ kind: 'person', employee_id: e.id, en: `${e.full_name}: ${o} days off, quota ${HR_RULES.offPerMonth}`, vi: `${e.full_name}: ${o} ngày nghỉ, định mức ${HR_RULES.offPerMonth}` });
    if (sat > HR_RULES.maxSat) out.push({ kind: 'person', employee_id: e.id, en: `${e.full_name}: ${sat} Saturdays off, max ${HR_RULES.maxSat}`, vi: `${e.full_name}: nghỉ ${sat} Thứ 7, tối đa ${HR_RULES.maxSat}` });
    if (sun > HR_RULES.maxSun) out.push({ kind: 'person', employee_id: e.id, en: `${e.full_name}: ${sun} Sundays off, max ${HR_RULES.maxSun}`, vi: `${e.full_name}: nghỉ ${sun} Chủ nhật, tối đa ${HR_RULES.maxSun}` });
  }
  return out;
}

export const SHIFT_HOURS: Record<string, string> = { '7': '07:00–16:00', '8': '08:00–17:00' };
