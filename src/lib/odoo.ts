// Server-only Odoo JSON-RPC client (read-only account).
// Credentials come from env vars — never hardcode them here.
// ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_API_KEY

const ODOO_URL = () => process.env.ODOO_URL ?? '';
const ODOO_DB = () => process.env.ODOO_DB ?? '';
const ODOO_LOGIN = () => process.env.ODOO_LOGIN ?? '';
const ODOO_KEY = () => process.env.ODOO_API_KEY ?? '';
// Dedicated WRITE account (least-privilege: only what needs to write, e.g. mrp.production).
// Same Odoo URL/DB, separate login + key so the read-only key stays read-only.
const ODOO_WRITE_LOGIN = () => process.env.ODOO_WRITE_LOGIN ?? '';
const ODOO_WRITE_KEY = () => process.env.ODOO_WRITE_API_KEY ?? '';

/** Lab operates in Vietnam — Odoo stores datetimes in UTC, we convert for display/grouping */
export const LAB_TZ = 'Asia/Ho_Chi_Minh';

let cachedUid: number | null = null;

async function rpc(service: string, method: string, args: unknown[]): Promise<any> {
  const res = await fetch(`${ODOO_URL()}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error?.data?.message ?? json.error?.message ?? 'Odoo RPC error');
  return json.result;
}

export function odooConfigured(): boolean {
  return !!(ODOO_URL() && ODOO_DB() && ODOO_LOGIN() && ODOO_KEY());
}

async function authenticate(): Promise<number> {
  if (cachedUid) return cachedUid;
  const uid = await rpc('common', 'authenticate', [ODOO_DB(), ODOO_LOGIN(), ODOO_KEY(), {}]);
  if (!uid) throw new Error('Odoo authentication failed — check ODOO_LOGIN / ODOO_API_KEY');
  cachedUid = uid as number;
  return cachedUid;
}

export async function odooExecute<T = any>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const uid = await authenticate();
  return rpc('object', 'execute_kw', [ODOO_DB(), uid, ODOO_KEY(), model, method, args, kwargs]);
}

// ── Dedicated WRITE client (separate account/key) ──────────────────────────────
export function odooWriteConfigured(): boolean {
  return !!(ODOO_URL() && ODOO_DB() && ODOO_WRITE_LOGIN() && ODOO_WRITE_KEY());
}
let cachedWriteUid: number | null = null;
async function authenticateWrite(): Promise<number> {
  if (cachedWriteUid) return cachedWriteUid;
  const uid = await rpc('common', 'authenticate', [ODOO_DB(), ODOO_WRITE_LOGIN(), ODOO_WRITE_KEY(), {}]);
  if (!uid) throw new Error('Odoo WRITE auth failed — check ODOO_WRITE_LOGIN / ODOO_WRITE_API_KEY');
  cachedWriteUid = uid as number;
  return cachedWriteUid;
}
export async function odooExecuteWrite<T = any>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const uid = await authenticateWrite();
  return rpc('object', 'execute_kw', [ODOO_DB(), uid, ODOO_WRITE_KEY(), model, method, args, kwargs]);
}

/** Convert an Odoo UTC datetime string ("2026-07-07 01:00:00") to lab-local date + time */
export function odooDateTimeToLocal(utc: string | false | null): { date: string; time: string | null } {
  if (!utc) return { date: '', time: null };
  const d = new Date(utc.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return { date: '', time: null };
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: LAB_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  return { date, time: time === '00:00' ? null : time };
}

/** Lab-local calendar date ('YYYY-MM-DD') of a UTC timestamp (e.g. produced_at). */
export function labDateOf(isoUtc: string | null | undefined): string | null {
  if (!isoUtc) return null;
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: LAB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** UTC [start,end) covering one lab-local day (VN = UTC+7, no DST). */
export function labDayUtcRange(date: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - 7 * 3600 * 1000; // lab midnight in UTC
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + 24 * 3600 * 1000).toISOString() };
}

/** Lab-local date ('YYYY-MM-DD') + optional 'HH:MM' time -> Odoo UTC datetime string.
 *  Inverse of odooDateTimeToLocal. VN = UTC+7, no DST, so this is a fixed 7h subtraction.
 *  No time given -> defaults to 09:00 lab-local (a safe daytime placeholder for a draft doc). */
export function labLocalToOdooUtc(date: string, time?: string | null): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time && /^\d{2}:\d{2}$/.test(time) ? time : '09:00').split(':').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0) - 7 * 3600 * 1000;
  const dt = new Date(utcMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:00`;
}

/** "MM-DD HH:mm" in lab-local (Vietnam) time for the current moment — used in the
 *  per-client "changed at" tag on a production card's breakdown (2026-08-13, Axel: the
 *  audit-trail stamp was being written in raw server UTC, 7h behind what a chef in Hanoi
 *  actually reads on the clock). */
export function nowLabStamp(): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAB_TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** UTC datetime string for "today 00:00 in lab timezone" — used as Odoo query threshold.
 *  `daysBack` shifts the threshold earlier (2026-08-26, Axel: a shop/assistant formalizing a
 *  manual/exceptional cake into a real Odoo order a day or more after the fact — the order's own
 *  delivery_date is already in the past by the time it's entered — was silently never picked up
 *  by any sync, since both this threshold and odoo-sync.ts's anti-duplicate lookback were pinned
 *  to "today". See runOdooSync's SYNC_GRACE_DAYS.) */
export function labTodayUtcThreshold(daysBack: number = 0): string {
  const now = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: LAB_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  // Midnight lab time = previous day 17:00 UTC (VN = UTC+7, no DST)
  const localMidnightUtcMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 7 * 3600 * 1000;
  const d = new Date(localMidnightUtcMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:00:00`;
}
