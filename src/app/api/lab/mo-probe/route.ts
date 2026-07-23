import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { odooExecuteWrite, odooWriteConfigured } from '@/lib/odoo';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// TEMP admin probe — confirms the dedicated WRITE account authenticates and has the right
// permissions on mrp.production, WITHOUT creating anything. Delete after validation.
function tmo<T>(p: Promise<T>, ms: number, l: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error('timeout ' + l)), ms))]);
}

export async function GET() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!odooWriteConfigured()) return NextResponse.json({ error: 'ODOO_WRITE_* not configured (env not set, or the deploy has not picked it up yet)' }, { status: 500 });

  // check_access_rights implicitly authenticates the write account (throws if the key/login is wrong).
  const check = (op: string) =>
    tmo(odooExecuteWrite<boolean>('mrp.production', 'check_access_rights', [op], { raise_exception: false }), 15000, op);
  try {
    const read = await check('read');
    const write = await check('write');
    const create = await check('create');
    return NextResponse.json({
      authenticated: true,
      mrp_production: { read, write, create },
      ready_to_create_MO: read && write && create,
    });
  } catch (e: any) {
    return NextResponse.json({ authenticated: false, error: String(e?.message ?? e) }, { status: 502 });
  }
}
