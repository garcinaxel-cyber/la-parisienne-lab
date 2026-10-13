import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cleanupRawRequestPhotos } from '@/lib/raw-photo-cleanup';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// On-demand cleanup of orphan "new product" photos (?secret=CRON_SECRET, ?dry=1, ?minAge=minutes).
// The same cleanup also runs every night inside /api/lab/retention.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const minAge = Math.max(10, Number(url.searchParams.get('minAge')) || 60);
  const res = await cleanupRawRequestPhotos(db, { dry: url.searchParams.get('dry') === '1', minAgeMin: minAge });
  return NextResponse.json({ ok: !('error' in res && res.error), ...res });
}
