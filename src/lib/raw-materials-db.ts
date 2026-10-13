// Server-only helpers for the raw materials feature (see raw-materials.ts). Phase 1: the app's own
// tables only; Odoo is read, never written.
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import type { RawMaterial, PurchaseLine, Withdrawal } from '@/lib/raw-materials';

export function rawService() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

// canPurchase (Axel, 2026-10-09): purchasing access on top of another role (Hien stays 'assistant' for the OEM orders).
export type RawActor = { userId: string; role: string; name: string; team: string | null; isLead: boolean; canPurchase: boolean };

// Who is calling. `team` comes from lab_profiles (chefs), never from the client.
export async function rawActor(): Promise<RawActor | null> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return null;
  const { data: profile } = await supabase.from('profiles').select('role, full_name, can_purchase').eq('id', session.user.id).single();
  if (!profile?.role) return null;
  const { data: lab } = await supabase.from('lab_profiles').select('team, is_team_lead').eq('id', session.user.id).maybeSingle();
  return { userId: session.user.id, role: profile.role as string, name: (profile.full_name as string) || '', team: (lab?.team as string) ?? null, isLead: !!(lab as any)?.is_team_lead, canPurchase: !!(profile as any).can_purchase };
}

// Chefs act for their own team; admin / lab manager may act for any team (testing, cover).
export function canActForTeam(a: RawActor, team: string): boolean {
  if (a.role === 'admin' || a.role === 'lab_manager') return true;
  return a.role === 'chef' && a.team === team;
}
// Team lead approval (Axel, 2026-10-08: "seulement Hưng dans son équipe puisse valider la
// request"). Approvers = the team's lead(s) on their own team, plus admin as a backup.
export function canApproveForTeam(a: RawActor, team: string): boolean {
  return a.role === 'admin' || (a.role === 'chef' && a.isLead && a.team === team);
}
export async function teamLeads(db: NonNullable<ReturnType<typeof rawService>>, team: string): Promise<{ id: string; name: string }[]> {
  const { data } = await db.from('lab_profiles').select('id').eq('team', team).eq('is_team_lead', true);
  const ids = (data ?? []).map(r => r.id as string);
  if (!ids.length) return [];
  const { data: ps } = await db.from('profiles').select('id, full_name').in('id', ids);
  return ids.map(id => ({ id, name: ((ps ?? []).find(p => p.id === id)?.full_name as string) || '' }));
}
// Everyone holding the 'purchasing' role (Axel, 2026-10-09: they get a push when a request
// reaches the purchasing queue).
export async function purchasingUserIds(db: NonNullable<ReturnType<typeof rawService>>): Promise<string[]> {
  const { data } = await db.from('profiles').select('id').or('role.eq.purchasing,can_purchase.eq.true');
  return (data ?? []).map(r => r.id as string);
}
export function isPurchasing(a: RawActor | null): a is RawActor {
  return !!a && (a.role === 'purchasing' || a.role === 'admin' || a.canPurchase);
}

export function mapMaterial(r: any): RawMaterial {
  return {
    tmplId: r.tmpl_id, sku: r.sku ?? null, name: r.name, nameVi: r.name_vi ?? null, uom: r.uom, type: r.type, sub: r.sub,
    packs: Array.isArray(r.packs) ? r.packs : [], visible: !!r.visible, checked: !!r.checked, purchased: !!r.purchased,
    vendorId: r.vendor_id ?? null, vendorName: r.vendor_name ?? null, vendors: Array.isArray(r.vendors) ? r.vendors : [],
    bomCount: r.bom_count == null ? null : Number(r.bom_count), noRecipeNeeded: !!r.no_recipe_needed,
  };
}

export function mapLine(l: any, req: any): PurchaseLine {
  return {
    id: l.id, requestId: l.request_id, requestNo: Number(req?.no ?? 0), team: req?.team ?? '', requestedBy: req?.requested_by ?? null,
    createdAt: l.created_at, tmplId: l.tmpl_id ?? null, sku: l.sku ?? null, name: l.name, uom: l.uom, qty: Number(l.qty),
    brand: l.brand ?? null, brandStrict: !!l.brand_strict, note: l.note ?? null, isNew: !!l.is_new, photoUrl: l.photo_url ?? null,
    newState: l.new_state ?? null, vendorId: l.vendor_id ?? null, vendorName: l.vendor_name ?? null, status: l.status,
    poRef: l.po_ref ?? null, orderedAt: l.ordered_at ?? null, orderedBy: l.ordered_by_name ?? null,
    receivedAt: l.received_at ?? null, receivedBy: l.received_by_name ?? null, cancelledAt: l.cancelled_at ?? null,
    approvedAt: l.approved_at ?? null, approvedBy: l.approved_by_name ?? null, requestedQty: l.requested_qty == null ? null : Number(l.requested_qty),
    rejectedByLead: !!l.rejected_by_lead, rejectReason: l.reject_reason ?? null, cancelledBy: l.cancelled_by_name ?? null,
    poOdooId: l.po_odoo_id == null ? null : Number(l.po_odoo_id),
  };
}

const LINE_COLS = 'id, request_id, tmpl_id, sku, name, uom, qty, brand, brand_strict, note, is_new, photo_url, new_state, vendor_id, vendor_name, status, po_ref, ordered_at, ordered_by_name, received_at, received_by_name, cancelled_at, cancelled_by_name, approved_at, approved_by_name, requested_qty, rejected_by_lead, reject_reason, created_at, po_odoo_id';

// Purchase lines with their request, filtered by a builder over lab_purchase_request_lines.
export async function loadLines(db: NonNullable<ReturnType<typeof rawService>>, build: (q: any) => any): Promise<PurchaseLine[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(db.from('lab_purchase_request_lines').select(LINE_COLS)).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const reqIds = Array.from(new Set(out.map(l => l.request_id)));
  const reqs = new Map<string, any>();
  for (let i = 0; i < reqIds.length; i += 200) {
    const { data } = await db.from('lab_purchase_requests').select('id, no, team, requested_by').in('id', reqIds.slice(i, i + 200));
    for (const r of data ?? []) reqs.set(r.id, r);
  }
  return out.map(l => mapLine(l, reqs.get(l.request_id)));
}

export async function loadWithdrawals(db: NonNullable<ReturnType<typeof rawService>>, build: (q: any) => any): Promise<Withdrawal[]> {
  const { data: ws, error } = await build(db.from('lab_raw_withdrawals').select('id, no, team, taken_by, created_at, status, confirmed_at, confirmed_by_name')).limit(2000);
  if (error) throw new Error(error.message);
  const ids = (ws ?? []).map((w: any) => w.id);
  const lines = new Map<string, any[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from('lab_raw_withdrawal_lines')
      .select('id, withdrawal_id, tmpl_id, sku, name, uom, qty, pack_label, pack_count, corrected_qty, corrected_by_name, off_recipe, used_for')
      .in('withdrawal_id', ids.slice(i, i + 200));
    for (const l of data ?? []) { const a = lines.get(l.withdrawal_id) ?? []; a.push(l); lines.set(l.withdrawal_id, a); }
  }
  return (ws ?? []).map((w: any) => ({
    id: w.id, no: Number(w.no), team: w.team, takenBy: w.taken_by ?? null, createdAt: w.created_at,
    status: w.status === 'to_confirm' ? 'to_confirm' : 'confirmed', confirmedAt: w.confirmed_at ?? null, confirmedBy: w.confirmed_by_name ?? null,
    lines: (lines.get(w.id) ?? []).map(l => ({
      id: l.id, tmplId: l.tmpl_id ?? null, sku: l.sku ?? null, name: l.name, uom: l.uom, qty: Number(l.qty),
      packLabel: l.pack_label ?? null, packCount: l.pack_count == null ? null : Number(l.pack_count),
      correctedQty: l.corrected_qty == null ? null : Number(l.corrected_qty), correctedBy: l.corrected_by_name ?? null,
      offRecipe: !!l.off_recipe, usedFor: l.used_for ?? null,
    })),
  }));
}
