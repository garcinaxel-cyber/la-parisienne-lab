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
  // The cron endpoints have no session — they authenticate with their own CRON_SECRET.
  // 2026-08-05: confirm-mos was missing here, so pg_cron's call got silently redirected to
  // /login (200 OK with login-page HTML, no error) and the daily MO auto-confirm never actually
  // ran — caught by checking net._http_response's captured body after the 22:15 VN run.
  if (pathname.startsWith('/api/odoo/cron')) return NextResponse.next();
  if (pathname.startsWith('/api/odoo/confirm-mos')) return NextResponse.next();
  // Same treatment as confirm-mos above — learned the hard way on 2026-08-05 (see comment
  // above): any new cron endpoint MUST be exempted here, or pg_cron's call gets silently
  // redirected to /login (200 OK, no error) and the job never actually runs.
  if (pathname.startsWith('/api/odoo/reconciliation-check')) return NextResponse.next();
  // Same treatment — J+1 order auto-lock cron (2026-08-13), called twice daily by pg_cron.
  if (pathname.startsWith('/api/odoo/lock-orders')) return NextResponse.next();
  // Same treatment — read-only stock.scrap field diagnostic (2026-08-21), secret-gated itself,
  // called by hand via curl (no session), not a cron but same "no auth cookie" situation.
  if (pathname.startsWith('/api/odoo/scrap-debug')) return NextResponse.next();
  // Same treatment — one-off inventory-date correction diagnostic/fix (2026-08-22), secret-gated
  // itself, called by hand via curl (no session).
  if (pathname.startsWith('/api/odoo/inventory-date-fix')) return NextResponse.next();
  // Same treatment — read-only Odoo ref diagnostic (2026-09-03), secret-gated itself, called by
  // hand (no session).
  if (pathname.startsWith('/api/admin/odoo-ref-debug')) return NextResponse.next();
  if (pathname.startsWith('/api/admin/shop-order-skus-debug')) return NextResponse.next();
  // Public shop order form — the token in the URL is the access key (validated server-side)
  if (pathname.startsWith('/order')) return NextResponse.next();

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
