import type { SupabaseClient } from '@supabase/supabase-js';

// Short-lived named lock (table lab_named_locks, functions lab_try_lock / lab_unlock — v132).
// Used so that two follow-ups, retries or MO syncs on the same product × day never run the same
// Odoo work twice (review 2026-10-24). Waits up to `waitMs`; runs without the lock if the lock
// functions are missing (never blocks the Lab).
export async function withLock<T>(sb: SupabaseClient, key: string, fn: () => Promise<T>, opts: { seconds?: number; waitMs?: number } = {}): Promise<T> {
  const holder = Math.random().toString(36).slice(2);
  const seconds = opts.seconds ?? 90; const deadline = Date.now() + (opts.waitMs ?? 25000);
  let got = false;
  for (;;) {
    const { data, error } = await sb.rpc('lab_try_lock', { p_key: key, p_holder: holder, p_seconds: seconds });
    if (error) break;            // lock unavailable → run anyway
    if (data === true) { got = true; break; }
    if (Date.now() > deadline) throw new Error(`Busy (${key}) — try again in a minute`);
    await new Promise(r => setTimeout(r, 700));
  }
  try { return await fn(); }
  finally { if (got) { try { await sb.rpc('lab_unlock', { p_key: key, p_holder: holder }); } catch {} } }
}
