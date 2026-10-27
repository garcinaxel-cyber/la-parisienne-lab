// Axel, 2026-10-27: after the historical Excel import the online analytics showed only the lab
// orders' revenue (104.7M instead of ~218M for October). Cause: `.in('order_batch_id', ids)` with
// ~900 UUIDs builds a PostgREST GET URL too long for the gateway, the request fails, and the
// caller silently got `data: null` -> every lab_online_sale_lines row (shop_stock + excel_import)
// dropped out of the totals. Splitting the id list keeps each URL small; results are concatenated.
export async function selectInChunks<T = any>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
  size = 150,
): Promise<{ data: T[]; error: any }> {
  if (!ids.length) return { data: [], error: null };
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  const results = await Promise.all(chunks.map(c => run(c)));
  const error = results.find(r => r.error)?.error ?? null;
  if (error) console.error('[selectInChunks]', error?.message ?? error);
  return { data: results.flatMap(r => r.data ?? []), error };
}
