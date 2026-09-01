// Supabase/PostgREST silently caps a single request at 1000 rows (db-max-rows default) -- no
// error, just a truncated result. Any .select() that can plausibly return more than that must
// page through with .range(). Bitten three times in this codebase (delivery-check 2026-08-20,
// odoo-sync anti-duplicate scans 2026-08-26, station History badge 2026-09-01), each time
// silently and each time only noticed because a human spotted a wrong number. Shared here so
// the fix is one helper instead of per-file copies that drift (reconciliation.ts had the exact
// same two queries as checks.ts and was missed when checks.ts was paginated).
//
// Usage: fetchAllPages(f, t => supabase.from('t').select('...').eq(...).order('id').range(f, t))
// -- always add a stable .order() before .range(): without it PostgREST's row order is
// unspecified and pages can overlap or skip rows under concurrent writes.
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}
