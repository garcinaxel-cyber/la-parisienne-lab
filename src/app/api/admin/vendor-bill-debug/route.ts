import { NextResponse } from 'next/server';
import { odooConfigured, odooExecuteWrite } from '@/lib/odoo';

export const dynamic = 'force-dynamic';

// Read-only diagnostic (2026-09-05, Axel: negotiated a 35% rebate with vendor "Happy True
// Market" covering all of August's vendor bills, ~26 expected) — finds the exact bill list,
// states, and amounts against real Odoo data, and dumps line-level fields (does this instance's
// account.move.line expose 'discount'?) before any write is designed. Same CRON_SECRET pattern
// as /api/admin/scrap-states-debug: a narrow, single-purpose, secret-gated, READ-ONLY route
// (never a write), called by hand via curl, no session. Deliberately kept separate rather than
// exempting a write-capable admin route in middleware.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!odooConfigured()) {
    return NextResponse.json({ error: 'ODOO_* not configured' }, { status: 503 });
  }
  const action = url.searchParams.get('action') ?? 'bills';

  try {
    if (action === 'bills') {
      const q = url.searchParams.get('partner') ?? 'Happy True Market';
      const month = url.searchParams.get('month') ?? '08';
      const year = url.searchParams.get('year') ?? '2026';
      const partners = await odooExecuteWrite<any[]>('res.partner', 'search_read', [
        ['|', ['name', 'ilike', q], ['display_name', 'ilike', q]],
      ], { fields: ['id', 'name', 'display_name'] });
      if (!partners.length) return NextResponse.json({ error: `No partner matching "${q}"`, partners });
      const partnerIds = partners.map((p: any) => p.id);
      const noDateFilter = url.searchParams.get('month') === 'all';
      const start = `${year}-${month}-01`;
      const endDate = new Date(Number(year), Number(month), 1); // first day of next month
      const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-01`;
      const domain: any[] = [
        ['partner_id', 'in', partnerIds],
        ['move_type', 'in', url.searchParams.get('moveTypes')?.split(',') ?? ['in_invoice', 'in_refund']],
      ];
      if (!noDateFilter) domain.push(['invoice_date', '>=', start], ['invoice_date', '<', end]);
      const bills = await odooExecuteWrite<any[]>('account.move', 'search_read', [domain],
        { fields: ['id', 'name', 'ref', 'state', 'invoice_date', 'date', 'partner_id', 'amount_untaxed', 'amount_tax', 'amount_total', 'payment_state'] });
      const byState: Record<string, number> = {};
      for (const b of bills) byState[b.state] = (byState[b.state] ?? 0) + 1;
      const sumTotal = bills.reduce((s: number, b: any) => s + (b.amount_total || 0), 0);
      return NextResponse.json({ partners, count: bills.length, byState, sumTotal, bills });
    }
    if (action === 'lines') {
      const idsParam = url.searchParams.get('ids') ?? '';
      const ids = idsParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      if (!ids.length) return NextResponse.json({ error: 'Missing ?ids=1,2,3' }, { status: 400 });
      const raw = url.searchParams.get('raw') === '1';
      const domain: any[] = raw ? [['move_id', 'in', ids]] : [['move_id', 'in', ids], ['display_type', '=', 'product']];
      const lines = await odooExecuteWrite<any[]>('account.move.line', 'search_read', [domain],
        { fields: ['id', 'move_id', 'display_type', 'name', 'quantity', 'price_unit', 'discount', 'price_subtotal', 'price_total'] });
      return NextResponse.json({ ids, lineCount: lines.length, lines });
    }
    if (action === 'fields') {
      const model = url.searchParams.get('model') ?? 'account.move.line';
      const fields = await odooExecuteWrite<Record<string, any>>(model, 'fields_get', [], { attributes: ['string', 'type'] });
      const hasDiscount = 'discount' in fields;
      const einvoiceFieldNames = Object.keys(fields).filter(k => /einvoice|e_invoice|edi|hoa_don|invoice_electronic/i.test(k));
      const einvoiceFields = Object.fromEntries(einvoiceFieldNames.map(k => [k, fields[k]]));
      return NextResponse.json({ hasDiscount, discountField: fields['discount'] ?? null, einvoiceFields });
    }
    if (action === 'einvoice') {
      // Read-only: check the Vietnamese e-invoice status of specific bills before any reset-to-draft
      // is even considered — Nghị định 123/2020 requires a formal replace/adjust flow for an
      // e-invoice already reported to the tax authority, not a simple edit-and-repost.
      const idsParam = url.searchParams.get('ids') ?? '';
      const ids = idsParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      if (!ids.length) return NextResponse.json({ error: 'Missing ?ids=1,2,3' }, { status: 400 });
      const allFields = await odooExecuteWrite<Record<string, any>>('account.move', 'fields_get', [], { attributes: ['string', 'type'] });
      const einvoiceFieldNames = Object.keys(allFields).filter(k => /einvoice|e_invoice|edi|hoa_don|invoice_electronic|cqt|tax_authority/i.test(k));
      const rows = await odooExecuteWrite<any[]>('account.move', 'read', [ids], { fields: ['id', 'name', 'state', ...einvoiceFieldNames] });
      return NextResponse.json({ einvoiceFieldNames, rows });
    }
    if (action === 'permcheck') {
      // Read-only permission probe (no state change): does the WRITE api user actually have
      // 'write' rights on account.move, and can it call button_draft / action_post at all —
      // before Axel's reset-to-draft + discount + repost request is attempted for real.
      const canWrite = await odooExecuteWrite<boolean>('account.move', 'check_access_rights', ['write'], { raise_exception: false });
      const canWriteLine = await odooExecuteWrite<boolean>('account.move.line', 'check_access_rights', ['write'], { raise_exception: false });
      return NextResponse.json({ canWriteMove: canWrite, canWriteMoveLine: canWriteLine });
    }
    if (action === 'applydiscount') {
      // WRITE (2026-09-05, Axel: 35% rebate negotiated with HAPPY TRUE MARKET for August —
      // "reset to draft et mettre la discount et re confirmer"). Confirmed safe to run:
      // (a) none of these invoices has a Vietnamese e-invoice number yet (einvoice action),
      // (b) account.move.line exposes a real Discount (%) field, (c) Axel has temporarily
      // granted the write API account Accounting rights (permcheck action) specifically for
      // this. Per-invoice: button_draft -> set discount on every real product line -> action_post.
      // Stops and reports per-id on the first failure rather than leaving a partial silent mess.
      const idsParam = url.searchParams.get('ids') ?? '';
      const ids = idsParam.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      const pct = Number(url.searchParams.get('pct') ?? '35');
      if (!ids.length) return NextResponse.json({ error: 'Missing ?ids=1,2,3' }, { status: 400 });

      const results: any[] = [];
      for (const id of ids) {
        try {
          const before = await odooExecuteWrite<any[]>('account.move', 'read', [[id]], { fields: ['id', 'name', 'state', 'amount_total'] });
          const bill = before[0];
          if (!bill) { results.push({ id, ok: false, error: 'not found' }); continue; }
          if (bill.state === 'cancel') { results.push({ id, ok: true, skipped: 'cancelled, left untouched' }); continue; }
          const beforeTotal = bill.amount_total;
          if (bill.state !== 'draft') await odooExecuteWrite('account.move', 'button_draft', [[id]]);
          const lines = await odooExecuteWrite<any[]>('account.move.line', 'search_read', [
            [['move_id', '=', id], ['display_type', '=', 'product']],
          ], { fields: ['id'] });
          const lineIds = lines.map((l: any) => l.id);
          if (lineIds.length) await odooExecuteWrite('account.move.line', 'write', [lineIds, { discount: pct }]);
          await odooExecuteWrite('account.move', 'action_post', [[id]]);
          const after = await odooExecuteWrite<any[]>('account.move', 'read', [[id]], { fields: ['id', 'name', 'state', 'amount_total'] });
          results.push({ id, ok: true, name: bill.name, beforeTotal, afterTotal: after[0]?.amount_total, state: after[0]?.state, linesUpdated: lineIds.length });
        } catch (e: any) {
          results.push({ id, ok: false, error: String(e?.message ?? e) });
          break; // stop on first failure — do not plow through the rest of the batch blind
        }
      }
      return NextResponse.json({ pct, requested: ids.length, results });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
