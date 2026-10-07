'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { odooExecute } from '@/lib/odoo';
import { createEventShop, listEventShops, closeEventShop, setEventQrCodeUrl, getActiveEventById, resetEventPin, type EventShop } from '@/lib/event-shops';
import { setEventSessionCookie } from '@/lib/event-session';

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Forbidden' };
  return { userId: session.user.id };
}

// Admin or lab manager (Axel, 2026-10-07: "accessible dans l'interface admin lab manager") — may
// see the list and step into an event. Everything that changes an event stays requireAdmin.
async function requireAdminOrLabManager(): Promise<{ userId: string; role: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin' && profile?.role !== 'lab_manager') return { error: 'Forbidden' };
  return { userId: session.user.id, role: profile.role };
}

// One-click entry, no PIN: the PIN exists to let shared shop logins into an event, an admin or
// the lab manager is already identified by their own account. Sets the very same signed cookie
// enterEventAction does, so everything downstream behaves exactly as for the staff at the fair.
export async function enterEventAsStaffAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireAdminOrLabManager();
  if ('error' in auth) return { error: auth.error };
  const event = await getActiveEventById(String(id ?? ''));
  if (!event) return { error: 'This event is closed' };
  setEventSessionCookie(event.id);
  return { ok: true };
}

export type CreateEventFormResult = { event?: EventShop; pin?: string; error?: string };

// Axel, 2026-09-12: "je configure moi même l'entrepôt sur Odoo" — this NEVER creates a
// stock.warehouse. It only looks the code up (Odoo is the single source of truth for the
// warehouse itself) and stores the link + generates the PIN.
export async function createEventAction(input: { name?: string; warehouseCode: string }): Promise<CreateEventFormResult> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const code = (input.warehouseCode ?? '').trim().toUpperCase();
  if (!code) return { error: 'Mã kho Odoo bắt buộc' };

  let wh: { id: number; name: string } | undefined;
  try {
    // '=ilike' — case-insensitive exact match. Axel types the code in Odoo's own UI however he
    // likes (e.g. "Test"), while this form always uppercases what it stores/searches with; a
    // plain '=' would silently fail to find "Test" when searching for "TEST".
    const rows = await odooExecute<any[]>('stock.warehouse', 'search_read', [[['code', '=ilike', code]]], { fields: ['id', 'name'], limit: 1 });
    wh = rows[0];
  } catch (e: any) {
    return { error: e?.message ?? 'Không thể kết nối Odoo' };
  }
  if (!wh) return { error: `Không tìm thấy kho Odoo có mã "${code}" — tạo kho trong Odoo trước (Kho vận → Cấu hình → Kho hàng), rồi thử lại` };

  // The event takes ODOO's warehouse name, never a hand-typed one (2026-10-07). The Odoo sync
  // files every replenishment under its warehouse name (minus the "- warehouse" suffix, see
  // odoo-sync.ts), and that name is the key every shop tab reads by — the first real event was
  // typed "HAI PHUONG" here against "HẢI PHÒNG" in Odoo, so its deliveries could never have
  // reached it. One source for the name removes that whole class of mismatch.
  const name = String(wh.name ?? '').replace(/\s*-\s*warehouse\s*$/i, '').trim();
  if (!name) return { error: `Kho Odoo "${code}" không có tên` };

  const result = await createEventShop({ name, warehouseCode: code, odooWarehouseId: wh.id, createdBy: auth.userId });
  if (result.error) return { error: result.error };
  revalidatePath('/admin/events');
  return { event: result.event, pin: result.pin };
}

export async function listEventsAction(): Promise<{ events?: EventShop[]; error?: string }> {
  const auth = await requireAdminOrLabManager();
  if ('error' in auth) return { error: auth.error };
  return { events: await listEventShops() };
}

// New staff PIN for an open event (2026-10-07) — the old one stops working at once. Admin only.
export async function regenerateEventPinAction(id: string): Promise<{ pin?: string; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  return resetEventPin(String(id ?? ''));
}

export async function closeEventAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const res = await closeEventShop(id);
  if (res.error) return { error: res.error };
  revalidatePath('/admin/events');
  return { ok: true };
}

// Payment QR (Axel, 2026-09-14): "le QR code de paiement ... que l'on met nous meme avant que
// l'event commence" — admin uploads once per event, shown at the mini-caisse (EventCaisseTab) for
// a "chuyển khoản" sale. Same storage bucket/size cap as the online-orders payment-proof upload.
export async function uploadEventQrAction(id: string, formData: FormData): Promise<{ url?: string; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const supabase = service();
  if (!supabase) return { error: 'Server not configured' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!file.type.startsWith('image/')) return { error: 'Only images are allowed' };
  if (file.size > 1.5 * 1024 * 1024) return { error: 'Image too large — max 1.5MB' };
  const ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
  const path = `event-qr/${id}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabase.storage.from('lab-design-photos').upload(path, buf, { contentType: file.type, upsert: true });
  if (upErr) return { error: upErr.message };
  const { data } = supabase.storage.from('lab-design-photos').getPublicUrl(path);
  // Cache-bust: a re-upload keeps the same path, so append a version query param or the old image
  // can stick around in caches/the client's own memory.
  const url = `${data.publicUrl}?v=${Date.now()}`;
  const res = await setEventQrCodeUrl(id, url);
  if (res.error) return { error: res.error };
  revalidatePath('/admin/events');
  return { url };
}

export async function removeEventQrAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const res = await setEventQrCodeUrl(id, null);
  if (res.error) return { error: res.error };
  revalidatePath('/admin/events');
  return { ok: true };
}
