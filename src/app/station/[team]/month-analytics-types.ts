// Types for the station Analytics › "This month" view (see getTeamMonthAnalyticsAction in ./actions).
export type MonthRow = {
  cat: string; name: string; size: string;
  made: number; sent: number;           // current month to date
  prevMade: number; prevSent: number;   // previous month, full
  sameMade: number; sameSent: number;   // previous month, same days (1 → today's day)
};
export type OemRow = { name: string; kg: number; prevKg: number; sameKg: number };
export type TeamMonthAnalytics = {
  today: string; curMonth: string; prevMonth: string; day: number; prevSameTo: string;
  rows: MonthRow[]; oem: OemRow[] | null;
};

