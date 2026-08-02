import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { persistImportsFromLines } from '@/lib/import-persist';
import { applyOdooChanges } from '@/lib/odoo-apply';

export const dynamic = 'force-dynamic';

// TEMPORARY self-contained test route — creates its own throwaway data, asserts, cleans up.
// Admin only. Safe to delete after use. Never leaves rows behind (cleanup runs even on failure).
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: 'auth' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager'].includes(profile?.role ?? '')) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const results: any = { testA_no_merge: null, testB_reopen_on_modify: null };
  const cleanup: { table: string; ids: string[] }[] = [];
  const date = '2099-01-01'; // far-future date, guaranteed not to collide with any real production day

  try {
    // ── TEST A: two separate persistImportsFromLines calls for the SAME team+variant+product
    // must now create TWO separate cards (no merge attempt) ──
    const line = (qty: number, ref: string) => ({
      product_sku: null as any, product_name_vi: 'TEST_REVERT_PRODUCT', variant_label: 'Standard',
      team: 'baby_mama', delivery_date: date, total_qty: qty,
      breakdown: [{ order_ref: ref, qty, shop_name: 'TEST_SHOP', delivery_time: null }],
    });
    const r1 = await persistImportsFromLines(supabase as any, [line(3, 'TESTREF-A1')] as any, { status: 'published', auto: true });
    const r2 = await persistImportsFromLines(supabase as any, [line(2, 'TESTREF-A2')] as any, { status: 'published', auto: true });

    const { data: imps } = await supabase.from('lab_imports').select('id').eq('delivery_date', date);
    const impIds = (imps ?? []).map((i: any) => i.id);
    cleanup.push({ table: 'lab_imports', ids: impIds });
    const { data: asgs } = impIds.length
      ? await supabase.from('lab_assignments').select('id, total_qty, import_id').in('import_id', impIds).eq('product_name_vi', 'TEST_REVERT_PRODUCT')
      : { data: [] as any[] };
    cleanup.push({ table: 'lab_assignments', ids: (asgs ?? []).map((a: any) => a.id) });
    const { data: ols } = impIds.length
      ? await supabase.from('lab_order_lines').select('id').in('import_id', impIds)
      : { data: [] as any[] };
    cleanup.push({ table: 'lab_order_lines', ids: (ols ?? []).map((o: any) => o.id) });

    results.testA_no_merge = {
      run1: r1, run2: r2,
      cardsCreated: (asgs ?? []).length,
      cardTotals: (asgs ?? []).map((a: any) => a.total_qty),
      pass: (asgs ?? []).length === 2, // expect 2 SEPARATE cards (3 and 2), not 1 merged card of 5
    };

    // ── TEST B: a 'done' card whose modified order raises the target above qty_produced
    // must reopen to partial/pending, not stay silently 'done' ──
    const { data: testImp } = await supabase.from('lab_imports').insert({
      delivery_date: date, order_number: 999, type: 'daily', status: 'published',
      notes: 'TEST_REVERT_B', published_at: new Date().toISOString(),
    }).select('id').single();
    if (testImp) cleanup.push({ table: 'lab_imports', ids: [testImp.id] });

    const { data: testOl } = testImp ? await supabase.from('lab_order_lines').insert({
      import_id: testImp.id, source_type: 'sales_order', order_ref: 'TESTREF-B1', shop_name: 'TEST_SHOP',
      product_sku: 'TEST_SKU_B', product_name_vi: 'TEST_REVERT_PRODUCT_B', team: 'baby_mama',
      variant_label: 'Standard', qty: 4, delivery_date: date, published: true,
    }).select('id').single() : { data: null };
    if (testOl) cleanup.push({ table: 'lab_order_lines', ids: [testOl.id] });

    const { data: testAsg } = testImp ? await supabase.from('lab_assignments').insert({
      import_id: testImp.id, team: 'baby_mama', product_name_vi: 'TEST_REVERT_PRODUCT_B', product_name_en: '',
      variant_label: 'Standard', total_qty: 4, qty_to_produce: 4, qty_produced: 4, status: 'done',
      breakdown: [{ order_ref: 'TESTREF-B1', qty: 4, shop_name: 'TEST_SHOP', delivery_time: null }],
    }).select('id, status').single() : { data: null };
    if (testAsg) cleanup.push({ table: 'lab_assignments', ids: [testAsg.id] });

    const applyRes = await applyOdooChanges(supabase as any, [
      { order_ref: 'TESTREF-B1', items: [{ sku: 'TEST_SKU_B', new_qty: 6, old_qty: 4 }] },
    ]);

    const { data: afterAsg } = testAsg
      ? await supabase.from('lab_assignments').select('id, status, total_qty, qty_to_produce, qty_produced').eq('id', testAsg.id).single()
      : { data: null };

    results.testB_reopen_on_modify = {
      before: testAsg, applyRes, after: afterAsg,
      pass: !!afterAsg && afterAsg.status === 'partial' && afterAsg.total_qty === 6 && afterAsg.qty_produced === 4,
    };
  } catch (e: any) {
    results.error = String(e?.message ?? e);
  } finally {
    for (const c of cleanup) {
      if (c.ids.length) await supabase.from(c.table).delete().in('id', c.ids);
    }
  }

  return NextResponse.json(results);
}
