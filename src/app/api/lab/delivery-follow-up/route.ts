import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { revalidateTag } from 'next/cache';
import { followUpLine } from '@/lib/delivery-gap';
import { withLock } from '@/lib/named-lock';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Delivery-check follow-up as a route handler, not a server action (review 2026-10-24): Next runs
// a page's server actions one at a time, so a slow Odoo follow-up used to delay the assistant's
// next save. A fetch runs in parallel. One product × day at a time (named lock).
export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role, full_name').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'not configured' }, { status: 500 });
  const sb = createServiceClient(url, key, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const lineId = String(body.lineId ?? '');
  if (!lineId) return NextResponse.json({ error: 'lineId' }, { status: 400 });
  const { data: line } = await sb.from('lab_delivery_check_lines').select('sku, delivery_date').eq('id', lineId).maybeSingle();
  if (!line) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    const result = await withLock(sb as any, `gap|${line.sku ?? lineId}|${line.delivery_date}`, () =>
      followUpLine(sb as any, lineId, { photoUrl: body.photoUrl ?? null, byName: profile?.full_name ?? null, byId: session.user.id, alreadyReported: !!body.alreadyReported }));
    try { revalidateTag('delivery-tasks'); } catch {}
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    await sb.from('lab_delivery_check_lines').update({ resolution_odoo_status: 'error', resolution_odoo_error: String(e?.message ?? e).slice(0, 300) }).eq('id', lineId);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
