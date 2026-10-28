import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { syncOdooItemPhotos } from '@/lib/item-photos';

// Odoo → app photos of raw materials & packaging (Axel, 2026-10-28). Admin only; dry run unless
// { commit: true }. Time-boxed: call again until toCopy reaches 0. The weekly job does the same.
export const maxDuration = 300;

export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { commit?: boolean };
  const res = await syncOdooItemPhotos({ commit: body.commit === true, budgetMs: 240_000 });
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
