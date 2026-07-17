import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/auth/set-password'];

// Coarse auth gate ONLY. The real session validation + role routing happens server-side in
// the (app) layout (getSession → redirect). We deliberately do NOT import @supabase/ssr here:
// bundling it pulled all of supabase-js into the Edge middleware, pushing its bundle over the
// Vercel Edge size limit — which made EVERY route fail with MIDDLEWARE_INVOCATION_FAILED as
// soon as any unrelated server file nudged the shared chunk. Reading the cookie directly keeps
// the middleware dependency-free and tiny. Token refresh still happens via the browser client.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  // The cron endpoint has no session — it authenticates with its own CRON_SECRET
  if (pathname.startsWith('/api/odoo/cron')) return NextResponse.next();

  // Is a Supabase auth cookie present? (name: sb-<ref>-auth-token, possibly chunked .0/.1)
  const hasAuth = req.cookies.getAll().some(
    (c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name) && !!c.value,
  );
  if (!hasAuth) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Expose the pathname to server components (used by the app layout for role routing)
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers: reqHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.png).*)'],
};
