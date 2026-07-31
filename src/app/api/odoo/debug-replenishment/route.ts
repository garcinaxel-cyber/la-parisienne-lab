// TEMPORARY debug route — investigating stock.replenishment.request cancel options
// after both unlink(line) and unlink(parent) failed with a permissions error on the
// write API account. Remove this file once the investigation is done.
import { NextResponse } from 'next/server';
import { odooExecute, odooExecuteWrite } from '@/lib/odoo';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const reqName = url.searchParams.get('name') ?? 'REP/2026/00889';
  const tryAction = url.searchParams.get('try'); // e.g. action_cancel

  const out: any = {};

  try {
    const fields = await odooExecute<any>('stock.replenishment.request', 'fields_get', [], { attributes: ['string', 'type', 'selection'] });
    out.stateField = fields?.state ?? null;
  } catch (e: any) {
    out.fieldsError = String(e?.message ?? e);
  }

  try {
    const docs = await odooExecute<any[]>('stock.replenishment.request', 'search_read', [[['name', '=', reqName]]], { fields: ['id', 'name', 'state'] });
    out.doc = docs?.[0] ?? null;
  } catch (e: any) {
    out.docError = String(e?.message ?? e);
  }

  if (tryAction && out.doc?.id) {
    try {
      await odooExecuteWrite('stock.replenishment.request', tryAction, [[out.doc.id]]);
      out.actionResult = `${tryAction} succeeded`;
    } catch (e: any) {
      out.actionResult = `${tryAction} failed: ${String(e?.message ?? e)}`;
    }
  }

  const setState = url.searchParams.get('setState');
  if (setState && out.doc?.id) {
    try {
      await odooExecuteWrite('stock.replenishment.request', 'write', [[out.doc.id], { state: setState }]);
      out.writeResult = `write state=${setState} succeeded`;
    } catch (e: any) {
      out.writeResult = `write state=${setState} failed: ${String(e?.message ?? e)}`;
    }
  }

  return NextResponse.json(out);
}
