import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/auth/set-password'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  // The cron endpoint has no session — it authenticates with its own CRON_SECRET
  if (pathname.startsWith('/api/odoo/cron')) return NextResponse.next();
  // Stations are NOT public: an unauthenticated visitor (e.g. scanning a QR code)
  // is redirected to /login. Team tablets stay logged in with a worker account.

  // Expose the pathname to server components (used by the app layout for role routing)
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('x-pathname', pathname);
  let res = NextResponse.next({ request: { headers: reqHeaders } });
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
