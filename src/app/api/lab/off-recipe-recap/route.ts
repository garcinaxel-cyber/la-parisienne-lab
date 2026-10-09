import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendAdminPush } from '@/lib/push-notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Daily recap of off-recipe withdrawals (Axel, 2026-10-09): raw materials the chefs took from
// storage in the last 24 h that no Odoo recipe uses yet (and not marked "no recipe needed").
// One push to the admins at ~18:00 VN, nothing when there is nothing. Called by the Vercel cron
// (Authorization: Bearer CRON_SECRET) or by hand with ?secret=.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: ws } = await db.from('lab_raw_withdrawals').select('id').gte('created_at', since).limit(2000);
  const ids = (ws ?? []).map(w => w.id as string);
  if (!ids.length) return NextResponse.json({ ok: true, count: 0 });
  const lines: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('lab_raw_withdrawal_lines').select('tmpl_id, name, used_for').in('withdrawal_id', ids.slice(i, i + 200)).eq('off_recipe', true);
    lines.push(...(data ?? []));
  }
  const tmplIds = Array.from(new Set(lines.map(l => l.tmpl_id).filter(Boolean)));
  const { data: mats } = tmplIds.length
    ? await db.from('lab_raw_materials').select('tmpl_id, name_vi, bom_count, no_recipe_needed').in('tmpl_id', tmplIds)
    : { data: [] as any[] };
  const mat = new Map((mats ?? []).map((m: any) => [m.tmpl_id, m]));
  const open = lines.filter(l => { const m: any = mat.get(l.tmpl_id); return !m || (!(Number(m.bom_count) > 0) && !m.no_recipe_needed); });
  if (!open.length) return NextResponse.json({ ok: true, count: 0 });
  const names = Array.from(new Set(open.map(l => (mat.get(l.tmpl_id) as any)?.name_vi || l.name)));
  const missingFor = open.filter(l => !l.used_for).length;
  const list = names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4}` : '');
  await sendAdminPush(db as any,
    { title: 'La Parisienne Lab', body: `⚠ ${open.length} lần lấy kho ngoài công thức hôm nay: ${list}${missingFor ? ` · ${missingFor} chưa ghi món` : ''}`, url: '/admin/raw-report', tag: 'off-recipe' },
    { title: 'La Parisienne Lab', body: `⚠ ${open.length} off-recipe withdrawals today: ${list}${missingFor ? ` · ${missingFor} without a product` : ''}`, url: '/admin/raw-report', tag: 'off-recipe' });
  return NextResponse.json({ ok: true, count: open.length });
}
