import { createClient as createServiceClient } from '@supabase/supabase-js';
import { hashEventPin } from './event-session';
import type { ShopConfig } from './shops';

// Server-only reads/writes for lab_event_shops (lab_v82) — the single source of truth for every
// temporary "event" shop. `name` doubles as the shop_name used everywhere else in the app (see
// migration comment), so this is deliberately the ONLY place that touches this table: every
// caller (session resolution in shop/actions.ts, the dynamic SHOP_CONFIG fallback below, the
// admin CRUD actions) goes through these functions rather than querying lab_event_shops directly.

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

export type EventShop = {
  id: string; name: string; warehouseCode: string; odooWarehouseId: number;
  active: boolean; createdAt: string; closedAt: string | null;
};

function fromRow(r: any): EventShop {
  return {
    id: r.id, name: r.name, warehouseCode: r.warehouse_code, odooWarehouseId: r.odoo_warehouse_id,
    active: r.active, createdAt: r.created_at, closedAt: r.closed_at,
  };
}

export async function getActiveEventById(id: string): Promise<EventShop | null> {
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_event_shops').select('*').eq('id', id).eq('active', true).maybeSingle();
  return data ? fromRow(data) : null;
}

export async function getActiveEventByPin(pin: string): Promise<EventShop | null> {
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_event_shops').select('*')
    .eq('pin_hash', hashEventPin(pin)).eq('active', true).maybeSingle();
  return data ? fromRow(data) : null;
}

export async function getActiveEventByName(name: string): Promise<EventShop | null> {
  const supabase = service();
  if (!supabase) return null;
  const { data } = await supabase.from('lab_event_shops').select('*')
    .ilike('name', name).eq('active', true).maybeSingle();
  return data ? fromRow(data) : null;
}

// Whether the FAB should even show — cheap existence check, no row content needed.
export async function hasAnyActiveEvent(): Promise<boolean> {
  const supabase = service();
  if (!supabase) return false;
  const { count } = await supabase.from('lab_event_shops').select('id', { count: 'exact', head: true }).eq('active', true);
  return (count ?? 0) > 0;
}

// The dynamic counterpart to SHOP_CONFIG (src/lib/shops.ts) for the Odoo-facing modules
// (odoo-manager-order.ts, odoo-scrap.ts) — an event shop is always docType:'replenishment'
// against the warehouse Axel configured himself, never a quotation partner.
export async function resolveEventShopConfig(shopName: string): Promise<ShopConfig | null> {
  const ev = await getActiveEventByName(shopName);
  if (!ev) return null;
  return { docType: 'replenishment', warehouseCode: ev.warehouseCode, portalAccount: true };
}

export async function listEventShops(): Promise<EventShop[]> {
  const supabase = service();
  if (!supabase) return [];
  const { data } = await supabase.from('lab_event_shops').select('*').order('created_at', { ascending: false }).limit(100);
  return (data ?? []).map(fromRow);
}

export type CreateEventResult = { event?: EventShop; pin?: string; error?: string };

function randomPin(): string {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits — matches the PIN length used elsewhere (manager PINs)
}

// Looks up the Odoo warehouse Axel already created (never creates one — see the migration/lib
// comment and the mockup discussion: "je configure moi même l'entrepôt sur Odoo"), generates a
// fresh unique 4-digit PIN (retried on the rare collision against other ACTIVE events), and
// inserts the row. odooWarehouseId + odooWarehouseName are passed in already resolved by the
// caller (the admin action), which is the one place allowed to call Odoo directly.
export async function createEventShop(input: {
  name: string; warehouseCode: string; odooWarehouseId: number; createdBy?: string | null;
}): Promise<CreateEventResult> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const name = input.name.trim().slice(0, 120);
  if (!name) return { error: 'Tên event bắt buộc' };
  const code = input.warehouseCode.trim().toUpperCase().slice(0, 5);
  if (!code) return { error: 'Mã kho bắt buộc' };

  for (let attempt = 0; attempt < 6; attempt++) {
    const pin = randomPin();
    const { data, error } = await supabase.from('lab_event_shops').insert({
      name, warehouse_code: code, odoo_warehouse_id: input.odooWarehouseId,
      pin_hash: hashEventPin(pin), created_by: input.createdBy ?? null,
    }).select('*').single();
    if (!error) return { event: fromRow(data), pin };
    // Unique-index collision on the PIN specifically -> retry with a new one; any other error
    // (duplicate active name/warehouse) is real and should surface immediately.
    if (/pin/i.test(error.message) && /duplicate|unique/i.test(error.message)) continue;
    if (/duplicate|unique/i.test(error.message)) {
      return { error: /warehouse/i.test(error.message) ? 'Kho này đã được dùng cho một event đang mở' : 'Đã có event đang mở trùng tên' };
    }
    return { error: error.message };
  }
  return { error: 'Không tạo được mã PIN duy nhất — thử lại' };
}

export async function closeEventShop(id: string): Promise<{ ok?: boolean; error?: string }> {
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const { error } = await supabase.from('lab_event_shops').update({ active: false, closed_at: new Date().toISOString() }).eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}
