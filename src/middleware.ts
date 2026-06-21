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
    { cookies: { getAll: () => req.cookies.getAll(),
        setAll: (cs: { name: string; value: string; options?: Record<string, unknown> }[]) =>
            cs.forEach(({ name, value, options }) => res.cookies.set(name, value, options as any)) } }
  );
  // getSession() reads JWT from cookie — no network call, avoids Vercel 10s timeout
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|.*\\.png).*)'] };
