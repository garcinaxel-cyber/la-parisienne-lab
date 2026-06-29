import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

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
