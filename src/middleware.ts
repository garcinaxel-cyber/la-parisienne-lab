import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  // Stations are NOT public: an unauthenticated visitor (e.g. scanning a QR code)
  // is redirected to /login. Team tablets stay logged in with a worker account.

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

  // Race getSession (reads cookie, but may hang on token refresh) vs 4s timeout.
  // Prevents Vercel 10s edge timeout -> 504 when Supabase refresh token call hangs.
  let session = null;
  try {
    session = await Promise.race([
      supabase.auth.getSession().then((r) => r.data.session),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
  } catch (_e) {
    session = null;
  }

  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.png).*)'],
};
