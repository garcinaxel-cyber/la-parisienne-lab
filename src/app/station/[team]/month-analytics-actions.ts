'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { isOemSku } from '@/lib/oem';
import { vnTodayStr } from '@/lib/odoo';

// Station Analytics › "This month" (Axel, 2026-11-11). Reads the pre-summed lab_analytics_daily
// table (lab_v152, kept current by triggers) — no Odoo call, nothing recalculated on open.
//   made = sent to stock (lab_stock_transfer_lines, = Odoo MOs "Lab YYYY-MM-DD")
//   sent = checked at delivery (lab_delivery_check_lines, category production, = LAB/OUT)
// Current month (1 → today) is compared with the SAME days of the previous month; the previous
// month is also shown in full (one month back only, Axel). OEM (Team Hưng) comes from Odoo MOs in
// kg, copied nightly into lab_analytics_oem_daily (/api/lab/analytics-sync).

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

const OEM_TEAMS = ['hung'];
const HIDDEN_SIZES = new Set(['standard', 'chiếc', 'chiec', '']);

function monthStart(d: string) { return d.slice(0, 8) + '01'; }
function prevMonthOf(d: string) {
  const [y, m] = d.split('-').map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}
function lastDayOf(monthFirst: string) {
  const [y, m] = monthFirst.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export async function getTeamMonthAnalyticsAction(team: string): Promise<{ data?: TeamMonthAnalytics; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return { error: 'Service role not configured' };
  const sb = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const today = vnTodayStr();
  const cur = monthStart(today);
  const prev = prevMonthOf(today);
  const day = Number(today.slice(8, 10));
  const prevLast = lastDayOf(prev);
  const prevSameTo = `${prev.slice(0, 8)}${String(Math.min(day, prevLast)).padStart(2, '0')}`;
  const prevEnd = `${prev.slice(0, 8)}${String(prevLast).padStart(2, '0')}`;

  const [{ data: daily, error }, { data: excl }] = await Promise.all([
    sb.from('lab_analytics_daily').select('day, sku, made, sent').eq('team', team).gte('day', prev).lte('day', today).limit(10000),
    sb.from('lab_excluded_skus').select('sku'),
  ]);
  if (error) return { error: error.message };
  const excluded = new Set((excl ?? []).map((r: any) => r.sku));

  type Acc = { made: number; sent: number; prevMade: number; prevSent: number; sameMade: number; sameSent: number };
  const bySku = new Map<string, Acc>();
  for (const r of daily ?? []) {
    if (!r.sku || excluded.has(r.sku) || isOemSku(r.sku)) continue;
    const a = bySku.get(r.sku) ?? { made: 0, sent: 0, prevMade: 0, prevSent: 0, sameMade: 0, sameSent: 0 };
    const m = Number(r.made) || 0, s = Number(r.sent) || 0;
    if (r.day >= cur) { a.made += m; a.sent += s; }
    else if (r.day <= prevEnd) {
      a.prevMade += m; a.prevSent += s;
      if (r.day <= prevSameTo) { a.sameMade += m; a.sameSent += s; }
    }
    bySku.set(r.sku, a);
  }

  // Names and categories from the production fiches; SKUs without a fiche (delivered items only)
  // fall back to the name on the delivery-check line.
  const skus = Array.from(bySku.keys());
  const info = new Map<string, { cat: string; name: string; size: string }>();
  for (let i = 0; i < skus.length; i += 200) {
    const { data: vars } = await sb.from('lab_fiche_variants')
      .select('sku, label, lab_fiche_meta(name_en, name_vi, category)').in('sku', skus.slice(i, i + 200));
    for (const v of (vars ?? []) as any[]) {
      if (info.has(v.sku)) continue;
      const meta = v.lab_fiche_meta ?? {};
      const label = String(v.label ?? '').trim();
      info.set(v.sku, {
        cat: meta.category || 'Other',
        name: String(meta.name_en || meta.name_vi || v.sku).trim(),
        size: HIDDEN_SIZES.has(label.toLowerCase()) ? '' : label,
      });
    }
  }
  const missing = skus.filter(s => !info.has(s));
  if (missing.length) {
    const { data: names } = await sb.from('lab_delivery_check_lines')
      .select('sku, product_name_en, product_name_vi').in('sku', missing).order('delivery_date', { ascending: false }).limit(missing.length * 5);
    for (const n of (names ?? []) as any[]) {
      if (!info.has(n.sku)) info.set(n.sku, { cat: 'Other', name: n.product_name_en || n.product_name_vi || n.sku, size: '' });
    }
  }

  const rows: MonthRow[] = [];
  bySku.forEach((a, sku) => {
    const i = info.get(sku) ?? { cat: 'Other', name: sku, size: '' };
    if (!a.made && !a.sent && !a.prevMade && !a.prevSent) return;
    rows.push({ cat: i.cat, name: i.name, size: i.size, ...a });
  });

  let oem: OemRow[] | null = null;
  if (OEM_TEAMS.includes(team)) {
    const { data: o } = await sb.from('lab_analytics_oem_daily').select('day, code, name, kg').gte('day', prev).lte('day', today).limit(5000);
    const byCode = new Map<string, OemRow>();
    for (const r of (o ?? []) as any[]) {
      const x = byCode.get(r.code) ?? { name: r.name || r.code, kg: 0, prevKg: 0, sameKg: 0 };
      const k = Number(r.kg) || 0;
      if (r.day >= cur) x.kg += k;
      else { x.prevKg += k; if (r.day <= prevSameTo) x.sameKg += k; }
      byCode.set(r.code, x);
    }
    oem = Array.from(byCode.values());
  }

  return { data: { today, curMonth: cur, prevMonth: prev, day, prevSameTo, rows, oem } };
}
