import { createClient, getSafeSession } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import AnalyticsView from './AnalyticsView';

export const revalidate = 300; // 5 min cache — analytics don't need to be real-time

export default async function AnalyticsPage({ searchParams }: { searchParams: { range?: string } }) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) redirect('/login');
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') redirect('/dashboard');

  const range = searchParams.range ?? '30';
  const days = range === 'today' ? 1 : range === '7' ? 7 : range === '60' ? 60 : range === '90' ? 90
    : range === '180' ? 180 : range === '365' ? 365 : 30;
  // Raw detail is retained 60 days (lab_v24). Longer ranges read lab_daily_stats,
  // the per-day aggregates kept forever.
  const aggregated = days > 60;
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - days + 1);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = today.toISOString().split('T')[0];

  // Demand vs production by team/category (Axel, 2026-08-21: "je voudrais savoir s'il est
  // possible dans la partie analytique d'analyser la capacité de production de chaque team en
  // fonction des catégorie de produit... je veux voir si on est en sous capacité ou sur
  // capacité"). A true "capacity" figure isn't computable — no standard-production-time data
  // exists anywhere in this app — so this is demand (qty ordered) vs actual output (qty
  // produced) per team per category, which is the closest reliable proxy and works identically
  // whichever window (raw assignments or lab_daily_stats) is active. category comes from
  // lab_fiche_meta, matched by product name (assignments/lab_daily_stats don't carry sku
  // reliably enough to join on it — lab_daily_stats does have a sku column but it's frequently
  // null for older rows, per lab_v24's own comments) — name match is the same approach already
  // used elsewhere on this page (perProduct, productAgg).
  const { data: ficheMeta } = await supabase.from('lab_fiche_meta').select('name_vi, category');
  const nameToCategory: Record<string, string> = {};
  for (const f of ficheMeta ?? []) if (f.name_vi && f.category) nameToCategory[f.name_vi] = f.category;
  const OTHER_CATEGORY = 'Khác / Other';

  // Published imports in range
  const { data: imports } = await supabase
    .from('lab_imports')
    .select('id, delivery_date')
    .eq('status', 'published')
    .gte('delivery_date', fromStr)
    .lte('delivery_date', toStr);
  const importIds = (imports ?? []).map((i: any) => i.id);
  const dateByImport: Record<string, string> = {};
  for (const i of imports ?? []) dateByImport[i.id] = i.delivery_date;

  // 2026-08-20 — Order-modification analysis removed (Axel: "plus interessant"). Production
  // cards now also carry blocked_at/blocked_by_name (lab_v46) for traceability, and delivery-
  // check lines are read for the two new team-level metrics below.
  const [{ data: assignments }, { data: checkLines }, { data: excludedRows }] = await Promise.all([
    importIds.length
      ? supabase.from('lab_assignments')
          .select('import_id, team, product_name_vi, total_qty, qty_produced, status, blocked_reason, blocked_at, blocked_by_name, cancelled')
          .in('import_id', importIds).limit(20000)
      : Promise.resolve({ data: [] as any[] }),
    // Only for the raw (≤60d) window — no daily-aggregate table exists yet for delivery-check
    // data (unlike production, which has lab_daily_stats), so a wide aggregated range would mean
    // an unbounded scan. Follow-up worth doing if these metrics prove useful long-range.
    !aggregated
      ? supabase.from('lab_delivery_check_lines')
          .select('sku, team, product_name_vi, status, qty_expected, qty_checked')
          .eq('category', 'production').not('team', 'is', null)
          .gte('delivery_date', fromStr).lte('delivery_date', toStr).limit(20000)
      : Promise.resolve({ data: [] as any[] }),
    // category='production' isn't a fully reliable "actually produced" filter on its own — a
    // SKU added to lab_excluded_skus AFTER its check line already existed stays category=
    // 'production' forever (ensureDeliveryOrderChecklist only re-buckets on next open — same
    // staleness class as the qty_expected drift the Check tab now catches). Confirmed live
    // 2026-08-20: drinks (Americano, Bạc Xỉu…), a raw material (Flour T65) and a packaging box
    // still sitting as category='production' with team='' — Axel: "enlève les items non
    // produit" from the delivery-based completion rate.
    !aggregated ? supabase.from('lab_excluded_skus').select('sku') : Promise.resolve({ data: [] as any[] }),
  ]);
  const excludedSkuSet = new Set((excludedRows ?? []).map((r: any) => r.sku));

  const rows = (assignments ?? []) as any[];
  const isDone = (s: string) => s === 'done' || s === 'skip';

  // KPIs
  let unitsProduced = 0, unitsPlanned = 0, doneCards = 0, blockedCount = 0;
  const perTeam: Record<string, { total: number; done: number; units: number }> = {};
  const perProduct: Record<string, number> = {};
  const perReason: Record<string, number> = {};
  const perDay: Record<string, { units: number; total: number; done: number }> = {};
  // Blocked-card traceability (Axel, 2026-08-20: "je veux les blocked reason avec la
  // tracabilite pour pouvoir aller chercher le probleme") — one entry per blocked card, not
  // just an aggregate count, so a reason in the UI can be traced to the actual card/date/team.
  const blockedCards: { date: string; team: string; product: string; reason: string; blockedAt: string | null; blockedBy: string | null }[] = [];
  const demandByTeamCategory: Record<string, Record<string, { demand: number; produced: number }>> = {};

  for (const a of rows) {
    if (a.cancelled) continue; // cancelled cards are out of every production metric
    const date = dateByImport[a.import_id];
    unitsPlanned += a.total_qty ?? 0;
    // Units actually PRODUCED — in-stock (skip) was not made, so it counts 0.
    // 'done' = fully made; 'partial' = what was made so far.
    const producedQty = a.status === 'done' ? (a.qty_produced || a.total_qty || 0)
      : a.status === 'partial' ? (a.qty_produced ?? 0)
      : 0;
    unitsProduced += producedQty;
    {
      const t = a.team || 'other';
      const cat = nameToCategory[a.product_name_vi] || OTHER_CATEGORY;
      (demandByTeamCategory[t] ??= {});
      (demandByTeamCategory[t][cat] ??= { demand: 0, produced: 0 });
      demandByTeamCategory[t][cat].demand += a.total_qty ?? 0;
      demandByTeamCategory[t][cat].produced += producedQty;
    }
    if (isDone(a.status)) doneCards++;
    if (a.status === 'blocked') {
      blockedCount++;
      const r = a.blocked_reason || 'Autre';
      perReason[r] = (perReason[r] ?? 0) + 1;
      blockedCards.push({ date, team: a.team || 'other', product: a.product_name_vi, reason: r, blockedAt: a.blocked_at ?? null, blockedBy: a.blocked_by_name ?? null });
    }
    const t = a.team || 'other';
    (perTeam[t] ??= { total: 0, done: 0, units: 0 });
    perTeam[t].total++; if (isDone(a.status)) perTeam[t].done++; perTeam[t].units += a.total_qty ?? 0;
    perProduct[a.product_name_vi] = (perProduct[a.product_name_vi] ?? 0) + (a.total_qty ?? 0);
    if (date) {
      (perDay[date] ??= { units: 0, total: 0, done: 0 });
      perDay[date].units += a.total_qty ?? 0;
      perDay[date].total++;
      if (isDone(a.status)) perDay[date].done++;
    }
  }

  // Blocking frequency over time + dominant reason per team (Axel, 2026-08-20). Trend uses
  // blocked_at's own date (when the block actually happened), falling back to the card's
  // delivery date for cards blocked before lab_v46 (blocked_at is null there).
  const blockFreqByDay: Record<string, number> = {};
  const blockByTeamReason: Record<string, Record<string, number>> = {};
  for (const c of blockedCards) {
    const d = c.blockedAt ? c.blockedAt.slice(0, 10) : c.date;
    if (d) blockFreqByDay[d] = (blockFreqByDay[d] ?? 0) + 1;
    (blockByTeamReason[c.team] ??= {});
    blockByTeamReason[c.team][c.reason] = (blockByTeamReason[c.team][c.reason] ?? 0) + 1;
  }
  const blockTrend = Object.entries(blockFreqByDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
  const teamDominantReason = Object.entries(blockByTeamReason).map(([team, reasons]) => {
    const sorted = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, n]) => s + n, 0);
    return { team, total, topReason: sorted[0]?.[0] ?? '—', topCount: sorted[0]?.[1] ?? 0 };
  }).sort((a, b) => b.total - a.total);

  const totalCards = rows.length;
  const kpis = {
    unitsProduced,
    unitsPlanned,
    completion: totalCards ? Math.round(doneCards / totalCards * 100) : 0,
    orders: new Set(rows.map(a => a.import_id)).size, // published imports in range
    blocked: blockedCount,
  };
  const teams = Object.entries(perTeam).map(([team, v]) => ({
    team, completion: v.total ? Math.round(v.done / v.total * 100) : 0, units: v.units,
  })).sort((a, b) => b.units - a.units);
  const topProducts = Object.entries(perProduct).map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty).slice(0, 8);
  const reasons = Object.entries(perReason).map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const daily = Object.entries(perDay).map(([date, v]) => ({
    date, units: v.units, total: v.total, done: v.done,
    completion: v.total ? Math.round(v.done / v.total * 100) : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // Delivery-check based metrics (Axel, 2026-08-20): completion = qty actually checked by
  // assistants vs. qty the client demanded (NOT the same as the cards-based "Completion by
  // team" above, which only counts cards marked done — this one catches partial/short
  // deliveries that never got flagged as blocked). Discrepancy rate = % of lines whose checked
  // qty differed from expected (status='adjusted'), by team and by product.
  const teamAgg: Record<string, { total: number; adjusted: number; expected: number; checked: number }> = {};
  const productAgg: Record<string, { total: number; adjusted: number }> = {};
  // Completion by team (delivery) gets its own aggregate, filtered to actually-produced SKUs
  // only (Axel, 2026-08-20) — discrepancy stays on the full set below, unscoped from this ask.
  const teamAggProduced: Record<string, { expected: number; checked: number }> = {};
  // Per-team, per-product breakdown of the gap (Axel, 2026-08-20: "je veux voir le detail des
  // produits problematiques classe par ordre de grandeur") — same excluded-SKU filter, keyed
  // by sku (falling back to name) so the same flavor across several orders/days aggregates
  // into one line instead of fragmenting the ranking.
  const teamProductAgg: Record<string, Record<string, { name: string; expected: number; checked: number }>> = {};
  for (const l of (checkLines ?? []) as any[]) {
    const t = l.team || 'other';
    (teamAgg[t] ??= { total: 0, adjusted: 0, expected: 0, checked: 0 });
    teamAgg[t].total++;
    if (l.status === 'adjusted') teamAgg[t].adjusted++;
    teamAgg[t].expected += l.qty_expected ?? 0;
    teamAgg[t].checked += l.qty_checked ?? 0;
    const p = l.product_name_vi || '—';
    (productAgg[p] ??= { total: 0, adjusted: 0 });
    productAgg[p].total++;
    if (l.status === 'adjusted') productAgg[p].adjusted++;
    if (!l.sku || !excludedSkuSet.has(l.sku)) {
      (teamAggProduced[t] ??= { expected: 0, checked: 0 });
      teamAggProduced[t].expected += l.qty_expected ?? 0;
      teamAggProduced[t].checked += l.qty_checked ?? 0;
      const key = l.sku ?? p;
      (teamProductAgg[t] ??= {});
      (teamProductAgg[t][key] ??= { name: p, expected: 0, checked: 0 });
      teamProductAgg[t][key].expected += l.qty_expected ?? 0;
      teamProductAgg[t][key].checked += l.qty_checked ?? 0;
    }
  }
  const completionByTeamDelivery = Object.entries(teamAggProduced).map(([team, v]) => ({
    team, expected: v.expected, checked: v.checked, rate: v.expected ? Math.round(v.checked / v.expected * 100) : 0,
  })).sort((a, b) => b.expected - a.expected);
  // Top problem products per team — biggest mismatch first, in either direction (Axel,
  // 2026-08-29: afficher aussi les quantités livrées en supplément, pas juste les manques).
  // gap > 0 = manque (livré en moins), gap < 0 = surplus (livré en plus). Exact matches excluded.
  const completionGapsByTeam: Record<string, { name: string; expected: number; checked: number; gap: number }[]> = {};
  for (const [team, products] of Object.entries(teamProductAgg)) {
    completionGapsByTeam[team] = Object.values(products)
      .map(v => ({ name: v.name, expected: v.expected, checked: v.checked, gap: v.expected - v.checked }))
      .filter(v => v.gap !== 0)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
      .slice(0, 10);
  }
  const discrepancyByTeam = Object.entries(teamAgg).map(([team, v]) => ({
    team, total: v.total, adjusted: v.adjusted, rate: v.total ? Math.round(v.adjusted / v.total * 100) : 0,
  })).sort((a, b) => b.rate - a.rate);
  const discrepancyByProduct = Object.entries(productAgg).map(([name, v]) => ({
    name, total: v.total, adjusted: v.adjusted, rate: v.total ? Math.round(v.adjusted / v.total * 100) : 0,
  })).filter(p => p.adjusted > 0).sort((a, b) => b.adjusted - a.adjusted).slice(0, 8);

  // ── Aggregate ranges (6 months / 1 year): production stats from lab_daily_stats ──
  let kpisOut = kpis, teamsOut = teams, topOut = topProducts, reasonsOut = reasons, dailyOut = daily;
  let blockedCardsOut = blockedCards, blockTrendOut = blockTrend, teamDominantReasonOut = teamDominantReason;
  if (aggregated) {
    const { data: stats } = await supabase.from('lab_daily_stats')
      .select('day, team, sku, product_name, qty_ordered, qty_produced, qty_extra, cards_total, cards_done, cards_blocked')
      .gte('day', fromStr).lte('day', toStr).limit(50000);
    let sUnitsProduced = 0, sUnitsPlanned = 0, sCardsTotal = 0, sCardsDone = 0, sBlocked = 0;
    const sTeam: Record<string, { total: number; done: number; units: number }> = {};
    const sProduct: Record<string, number> = {};
    const sDay: Record<string, { units: number; total: number; done: number }> = {};
    // Reset — the raw-window loop above already populated this from `rows`, which is empty for
    // an aggregated range anyway (no imports fetched for >60d windows), but be explicit.
    for (const k of Object.keys(demandByTeamCategory)) delete demandByTeamCategory[k];
    for (const r of stats ?? []) {
      sUnitsProduced += r.qty_produced ?? 0;
      sUnitsPlanned += r.qty_ordered ?? 0;
      sCardsTotal += r.cards_total ?? 0;
      sCardsDone += r.cards_done ?? 0;
      sBlocked += r.cards_blocked ?? 0;
      (sTeam[r.team] ??= { total: 0, done: 0, units: 0 });
      sTeam[r.team].total += r.cards_total ?? 0; sTeam[r.team].done += r.cards_done ?? 0; sTeam[r.team].units += r.qty_ordered ?? 0;
      const pname = r.product_name || r.sku || '—';
      sProduct[pname] = (sProduct[pname] ?? 0) + (r.qty_ordered ?? 0);
      (sDay[r.day] ??= { units: 0, total: 0, done: 0 });
      sDay[r.day].units += r.qty_ordered ?? 0; sDay[r.day].total += r.cards_total ?? 0; sDay[r.day].done += r.cards_done ?? 0;
      const t = r.team || 'other';
      const cat = nameToCategory[r.product_name ?? ''] || OTHER_CATEGORY;
      (demandByTeamCategory[t] ??= {});
      (demandByTeamCategory[t][cat] ??= { demand: 0, produced: 0 });
      demandByTeamCategory[t][cat].demand += r.qty_ordered ?? 0;
      demandByTeamCategory[t][cat].produced += r.qty_produced ?? 0;
    }
    kpisOut = {
      unitsProduced: sUnitsProduced,
      unitsPlanned: sUnitsPlanned,
      completion: sCardsTotal ? Math.round(sCardsDone / sCardsTotal * 100) : 0,
      orders: Object.keys(sDay).length, // production DAYS (imports detail is purged past 60d)
      blocked: sBlocked,
    };
    teamsOut = Object.entries(sTeam).map(([team, v]) => ({
      team, completion: v.total ? Math.round(v.done / v.total * 100) : 0, units: v.units,
    })).sort((a, b) => b.units - a.units);
    topOut = Object.entries(sProduct).map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty).slice(0, 8);
    reasonsOut = []; // blocked reasons live in the raw detail only
    blockedCardsOut = []; blockTrendOut = []; teamDominantReasonOut = [];
    dailyOut = Object.entries(sDay).map(([date, v]) => ({
      date, units: v.units, total: v.total, done: v.done,
      completion: v.total ? Math.round(v.done / v.total * 100) : 0,
    })).sort((a, b) => a.date.localeCompare(b.date));
  }

  // Demand vs production, by team then category — ~10% gap threshold for the
  // under/équilibré/over badge (Axel's mockup): produced < 90% of demand = under-capacity,
  // > 110% = over-capacity (making more than what's actually ordered — also worth flagging,
  // e.g. wasted effort or stale forecasts), else balanced. Sorted by demand desc so the
  // biggest-volume category surfaces first within each team; teams sorted by total demand desc.
  const demandVsProduction = Object.entries(demandByTeamCategory).map(([team, cats]) => {
    const categories = Object.entries(cats).map(([category, v]) => {
      const gapPct = v.demand > 0 ? Math.round((v.produced - v.demand) / v.demand * 100) : 0;
      const status: 'under' | 'ok' | 'over' = v.demand === 0 ? 'ok' : v.produced < v.demand * 0.9 ? 'under' : v.produced > v.demand * 1.1 ? 'over' : 'ok';
      return { category, demand: v.demand, produced: v.produced, gapPct, status };
    }).sort((a, b) => b.demand - a.demand);
    const totalDemand = categories.reduce((s, c) => s + c.demand, 0);
    return { team, totalDemand, categories };
  }).sort((a, b) => b.totalDemand - a.totalDemand);

  return <AnalyticsView range={range} days={days} kpis={kpisOut} teams={teamsOut} topProducts={topOut}
    reasons={reasonsOut} blockedCards={blockedCardsOut} blockTrend={blockTrendOut} teamDominantReason={teamDominantReasonOut}
    daily={dailyOut} completionByTeamDelivery={completionByTeamDelivery} completionGapsByTeam={completionGapsByTeam}
    discrepancyByTeam={discrepancyByTeam} discrepancyByProduct={discrepancyByProduct}
    demandVsProduction={demandVsProduction}
    aggregated={aggregated} />;
}
