'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { odooExecute } from '@/lib/odoo';
import { createEventShop, listEventShops, closeEventShop, type EventShop } from '@/lib/event-shops';

async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Forbidden' };
  return { userId: session.user.id };
}

export type CreateEventFormResult = { event?: EventShop; pin?: string; error?: string };

// Axel, 2026-09-12: "je configure moi même l'entrepôt sur Odoo" — this NEVER creates a
// stock.warehouse. It only looks the code up (Odoo is the single source of truth for the
// warehouse itself) and stores the link + generates the PIN.
export async function createEventAction(input: { name: string; warehouseCode: string }): Promise<CreateEventFormResult> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const name = (input.name ?? '').trim();
  if (!name) return { error: 'Tên event bắt buộc' };
  const code = (input.warehouseCode ?? '').trim().toUpperCase();
  if (!code) return { error: 'Mã kho Odoo bắt buộc' };

  let wh: { id: number; name: string } | undefined;
  try {
    const rows = await odooExecute<any[]>('stock.warehouse', 'search_read', [[['code', '=', code]]], { fields: ['id', 'name'], limit: 1 });
    wh = rows[0];
  } catch (e: any) {
    return { error: e?.message ?? 'Không thể kết nối Odoo' };
  }
  if (!wh) return { error: `Không tìm thấy kho Odoo có mã "${code}" — tạo kho trong Odoo trước (Kho vận → Cấu hình → Kho hàng), rồi thử lại` };

  const result = await createEventShop({ name, warehouseCode: code, odooWarehouseId: wh.id, createdBy: auth.userId });
  if (result.error) return { error: result.error };
  revalidatePath('/admin/events');
  return { event: result.event, pin: result.pin };
}

export async function listEventsAction(): Promise<{ events?: EventShop[]; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  return { events: await listEventShops() };
}

export async function closeEventAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const res = await closeEventShop(id);
  if (res.error) return { error: res.error };
  revalidatePath('/admin/events');
  return { ok: true };
}
