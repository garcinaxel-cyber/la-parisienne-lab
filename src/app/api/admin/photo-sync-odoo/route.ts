import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { syncWebsitePhotosToOdoo } from '@/lib/photo-sync-odoo';

// Website photos → Odoo (Axel, 2026-10-28). Admin session only. POST { skus?: string[], commit?: boolean }.
// Without commit it only returns the plan (dry run). The nightly run will call the same function.
export const maxDuration = 300;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { skus?: string[]; commit?: boolean; force?: boolean };
  const res = await syncWebsitePhotosToOdoo({
    skus: Array.isArray(body.skus) ? body.skus.filter(s => typeof s === 'string').slice(0, 1000) : undefined,
    commit: body.commit === true, force: body.force === true,
    by: (profile as any)?.full_name ?? session.user.email ?? 'admin',
  });
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
