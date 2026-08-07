import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Wraps supabase.auth.getSession() so a stale/invalid refresh token (AuthApiError:
// "Invalid Refresh Token: Refresh Token Not Found") returns session=null instead of
// throwing and crashing the whole page render. 54 occurrences / 10 users in 7 days
// (audit 2026-08-07) across /login, /reception, /station/[team], /dashboard,
// /exceptional-orders — same shape as the raw call, so every existing
// `const { data: { session } } = await ...` call site keeps working unchanged;
// callers already redirect to /login when session is null, which is exactly the
// right outcome for a broken refresh token too.
export async function getSafeSession(supabase: SupabaseClient) {
  try {
    return await supabase.auth.getSession();
  } catch {
    return { data: { session: null }, error: null } as Awaited<ReturnType<SupabaseClient['auth']['getSession']>>;
  }
}

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cs: { name: string; value: string; options?: Record<string, unknown> }[]) => {
          try {
            cs.forEach(({ name, value, options }) => cookieStore.set(name, value, options as any));
          } catch {
            // Called from a Server Component — cookie refresh is handled by middleware
          }
        },
      },
    }
  );
}
