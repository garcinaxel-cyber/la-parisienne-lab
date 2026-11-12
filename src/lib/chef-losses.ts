// Server-only: chef losses → Odoo (Axel, 2026-11-12). See lab_v154_chef_tests_losses.sql.
//   raw / pack / test → scrap from the team's room
//   fin, already sent to stock → scrap from LAB/Stock
//   fin, lost BEFORE it was sent to stock → MO "Lab loss <day>" (room → LAB/Stock), then the scrap
// A row is pushed once validated by the team lead, or after its lab day when nobody validated
// ('auto'). Every push first CLAIMS the row (conditional update), so the validate click and the
// cron never both write to Odoo for the same loss.
import { odooExecuteWrite, odooWriteConfigured, vnTodayStr } from '@/lib/odoo';
import { createScrapAtLocation, resolveProductsBySku } from '@/lib/odoo-scrap';
import { ROOMS, LAB_STOCK_ID } from '@/lib/rooms-odoo';
import { createAndProduceTeamMO, resumeOemMO } from '@/lib/odoo-oem-mo';
import type { ChefLoss } from '@/lib/chef-rd';

type Db = any;
const STALE_MS = 10 * 60 * 1000;

export function mapLoss(r: any): ChefLoss {
  return {
    id: r.id, team: r.team, kind: r.kind, sku: r.sku ?? null, tmplId: r.tmpl_id ?? null, productId: r.product_id ?? null,
    name: r.product_name, uom: r.uom ?? null, qty: Number(r.qty), beforeStock: !!r.before_stock,
    reasonId: r.reason_tag_id ?? null, reason: r.reason_tag_name, note: r.note ?? null, photoUrl: r.photo_url ?? null,
    testId: r.test_id ?? null, trialId: r.trial_id ?? null, labDay: r.lab_day,
    declaredBy: r.declared_by_name ?? null, declaredById: r.declared_by_id ?? null, declaredAt: r.declared_at,
    status: r.status, validatedBy: r.validated_by_name ?? null, validatedAt: r.validated_at ?? null,
    odooState: r.odoo_state ?? null, odooError: r.odoo_error ?? null, odooScrapId: r.odoo_scrap_id ?? null, odooMoName: r.odoo_mo_name ?? null,
  };
}

async function claim(db: Db, id: string): Promise<any | null> {
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data } = await db.from('lab_chef_losses')
    .update({ odoo_state: 'pending', odoo_at: new Date().toISOString() })
    .eq('id', id).in('status', ['validated', 'auto'])
    .or(`odoo_state.is.null,odoo_state.eq.error,and(odoo_state.eq.pending,odoo_at.lt.${stale})`)
    .select('*');
  return data?.[0] ?? null;
}

async function productOf(row: any): Promise<{ id: number; uomId: number } | null> {
  if (row.kind === 'fin') {
    const m = await resolveProductsBySku([row.sku]);
    const p = m[row.sku];
    return p ? { id: p.id, uomId: p.uom_id } : null;
  }
  if (!row.product_id) return null;
  const rows = await odooExecuteWrite<any[]>('product.product', 'read', [[Number(row.product_id)]], { fields: ['uom_id'] });
  const u = rows?.[0]?.uom_id;
  return rows?.[0] ? { id: Number(row.product_id), uomId: Array.isArray(u) ? u[0] : u } : null;
}

/** Pushes one validated / auto loss to Odoo. Safe to call twice (claim). */
export async function pushChefLoss(db: Db, id: string): Promise<{ ok: boolean; error?: string }> {
  if (!odooWriteConfigured()) return { ok: false, error: 'Odoo write account not configured' };
  const row = await claim(db, id);
  if (!row) return { ok: true };  // already done, not validated, or another run holds it
  const fail = async (msg: string) => {
    await db.from('lab_chef_losses').update({ odoo_state: 'error', odoo_error: msg.slice(0, 500), odoo_tries: (row.odoo_tries ?? 0) + 1, updated_at: new Date().toISOString() }).eq('id', id);
    return { ok: false, error: msg };
  };
  try {
    const room = ROOMS[row.team];
    if (!room) return fail(`No room for team ${row.team}`);
    const prod = await productOf(row);
    if (!prod) return fail(row.kind === 'fin' ? `SKU ${row.sku} not found in Odoo` : `Product ${row.product_name} not found in Odoo`);
    const tag = `${row.team} · ${row.lab_day}`;
    let location = room.location;
    if (row.kind === 'fin') {
      location = LAB_STOCK_ID;
      if (row.before_stock && !row.odoo_mo_id) {
        // Lost before the stock transfer: make the lost pieces first (consumes the room), then scrap.
        const mo = await createAndProduceTeamMO(row.sku, Number(row.qty), row.lab_day, `Lab loss ${row.lab_day}`, row.team);
        if (mo.moId) await db.from('lab_chef_losses').update({ odoo_mo_id: mo.moId, odoo_mo_name: mo.moName ?? null }).eq('id', id);
        if (!mo.ok) return fail(`MO: ${mo.error ?? 'failed'}`);
      } else if (row.before_stock && row.odoo_mo_id) {
        const mo = await resumeOemMO(Number(row.odoo_mo_id), row.lab_day);
        if (!mo.ok) return fail(`MO: ${mo.error ?? 'failed'}`);
      }
    }
    if (!row.odoo_scrap_id) {
      const res = await createScrapAtLocation(location, {
        productId: prod.id, uomId: prod.uomId, qty: Number(row.qty),
        reasonTagIds: row.reason_tag_id ? [Number(row.reason_tag_id)] : [],
        origin: row.kind === 'test' ? `Chef test ${tag}` : `Chef loss ${tag}`,
      });
      if (!res.ok) return fail(res.error ?? 'scrap failed');
      await db.from('lab_chef_losses').update({ odoo_scrap_id: res.scrapId ?? null }).eq('id', id);
    }
    await db.from('lab_chef_losses').update({ odoo_state: 'done', odoo_error: null, odoo_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
    return { ok: true };
  } catch (e: any) {
    return fail(String(e?.message ?? e));
  }
}

/** Cron: losses still pending after their lab day go to Odoo anyway ('auto'), then every
 *  validated / auto row not yet in Odoo is pushed (retries included, max 5 tries). */
export async function pushDueChefLosses(db: Db, budgetMs = 100_000): Promise<{ autoValidated: number; pushed: number; errors: string[] }> {
  const t0 = Date.now();
  const today = vnTodayStr();
  const { data: auto } = await db.from('lab_chef_losses')
    .update({ status: 'auto', validated_at: new Date().toISOString(), validated_by_name: 'auto (not validated)', updated_at: new Date().toISOString() })
    .eq('status', 'pending').lt('lab_day', today).select('id');
  const { data: due } = await db.from('lab_chef_losses').select('id, odoo_tries')
    .in('status', ['validated', 'auto']).or('odoo_state.is.null,odoo_state.eq.error,odoo_state.eq.pending')
    .lt('odoo_tries', 5).order('declared_at').limit(200);
  let pushed = 0; const errors: string[] = [];
  for (const r of due ?? []) {
    if (Date.now() - t0 > budgetMs) break;
    const res = await pushChefLoss(db, r.id);
    if (res.ok) pushed++; else errors.push(`${r.id}: ${res.error}`);
  }
  return { autoValidated: auto?.length ?? 0, pushed, errors };
}
