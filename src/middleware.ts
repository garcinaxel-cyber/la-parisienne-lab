import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login'];
// Station view has its own lightweight auth
const STATION_PREFIX = '/station';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  if (pathname.startsWith(STATION_PREFIX)) return NextResponse.next();

  let res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cs: { name: string; value: string; options?: Record<string, unknown> }[]) =>
          cs.forEach(({ name, value, options }) => res.cookies.set(name, value, options as any)),
      },
    }
  );

  try {
    // Race getSession against a 4s timeout.
    // If Supabase tries to refresh an expired token (network call) and hangs,
    // we redirect to login instead of hitting Vercel's 10s edge timeout -> 504.
    const sessionResult = await Promise.race([
      supabase.auth.getSession(),
      new Promise((resolve) =>
        setTimeout(() => resolve({ data: { session: null }, error: null }), 4000)
      ),
    ]);

    if (!sessionResult.data.session) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  } catch {
    // Any error -> redirect to login (never 504)
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.png).*)'],
};
