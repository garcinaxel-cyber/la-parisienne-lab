'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createHash, randomInt } from 'crypto';
import { revalidatePath } from 'next/cache';
import { PORTAL_SHOP_NAMES } from '@/lib/shops';

// Admin-only, one-time-ish provisioning for the Shop Manager role (Axel, 2026-09-10) — creates
// the real individual logins for the 3 managers Axel named, each linked to a fresh
// lab_shop_managers row (or an existing one, if already linked) covering every portal shop.
// Deliberately NOT a general "add manager" form — adding/removing a manager is a rare, deliberate
// admin operation (see the note on ShopManagerView's Team tab), not shop self-service. Isolated
// in its own file from admin/shop-access/actions.ts (the 'shop' role's own account creation) on
// the same "never touch a live file for new, unrelated work" precedent that file itself follows.

async function requireAdmin(): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Forbidden' };
  return { ok: true };
}

function admin() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

function hashManagerPin(pin: string): string {
  return createHash('sha256').update(pin).digest('hex');
}
function genPin(): string {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

// The 3 real managers Axel gave 2026-09-10, all covering every portal shop ("ils ont accès à
// toutes les boutiques"). Display name for Sales@laparisienne.com.vn confirmed by Axel as "Quan"
// (the inbox is a team alias, but a real person owns it) — editable later from Odoo/Supabase
// directly if wrong, this is just the label shown in the app. PINs are only set here on first
// creation (see provisionShopManagerAccountsAction below) — a later PIN change is a direct
// lab_shop_managers.pin_hash update, not something this button does.
const MANAGER_SPECS: { name: string; email: string; password: string; color: string }[] = [
  { name: 'Xuân Giang', email: 'xuangiang.marketing@gmail.com', password: 'xuangiang95@', color: '#EA580C' },
  { name: 'Quan', email: 'Sales@laparisienne.com.vn', password: 'Laparisienne2026@', color: '#0D9488' },
  { name: 'Phương', email: 'phuongc.works@gmail.com', password: '12345678@', color: '#BE123C' },
];

export type ProvisionResult = { name: string; email: string; pin?: string; status: 'created' | 'updated' | 'error'; error?: string };

export async function provisionShopManagerAccountsAction(): Promise<{ results?: ProvisionResult[]; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const svc = admin();
  if (!svc) return { error: 'Server not configured' };

  const results: ProvisionResult[] = [];
  for (const spec of MANAGER_SPECS) {
    const cleanEmail = spec.email.trim().toLowerCase();
    try {
      let userId: string | undefined;
      const { data: authData, error: authErr } = await svc.auth.admin.createUser({
        email: cleanEmail, password: spec.password, email_confirm: true, user_metadata: { full_name: spec.name },
      });
      userId = authData?.user?.id;
      if (authErr || !userId) {
        const alreadyExists = authErr?.message?.toLowerCase().includes('already');
        if (!alreadyExists) { results.push({ name: spec.name, email: cleanEmail, status: 'error', error: authErr?.message ?? 'Failed to create user' }); continue; }
        const { data: list } = await svc.auth.admin.listUsers();
        userId = list?.users?.find(u => u.email?.toLowerCase() === cleanEmail)?.id;
        if (!userId) { results.push({ name: spec.name, email: cleanEmail, status: 'error', error: 'User exists but could not be located' }); continue; }
        await svc.auth.admin.updateUserById(userId, { password: spec.password, email_confirm: true });
      }

      const { error: profileErr } = await svc.from('profiles').upsert({ id: userId, full_name: spec.name, role: 'shop_manager' }, { onConflict: 'id' });
      if (profileErr) { results.push({ name: spec.name, email: cleanEmail, status: 'error', error: profileErr.message }); continue; }

      const { data: existing } = await svc.from('lab_shop_managers').select('id').eq('user_id', userId).maybeSingle();
      if (existing) {
        await svc.from('lab_shop_managers').update({ name: spec.name, color: spec.color, shops: PORTAL_SHOP_NAMES, active: true }).eq('id', existing.id);
        results.push({ name: spec.name, email: cleanEmail, status: 'updated' });
      } else {
        const pin = genPin();
        const { error: mgrErr } = await svc.from('lab_shop_managers').insert({
          name: spec.name, pin_hash: hashManagerPin(pin), shops: PORTAL_SHOP_NAMES, color: spec.color, active: true, user_id: userId,
        });
        if (mgrErr) { results.push({ name: spec.name, email: cleanEmail, status: 'error', error: mgrErr.message }); continue; }
        results.push({ name: spec.name, email: cleanEmail, pin, status: 'created' });
      }
    } catch (e: any) {
      results.push({ name: spec.name, email: cleanEmail, status: 'error', error: e?.message ?? String(e) });
    }
  }

  revalidatePath('/admin/shop-managers');
  return { results };
}

export type ShopManagerRow = { id: string; name: string; color: string; shops: string[]; active: boolean; hasLogin: boolean };

export async function listShopManagersAction(): Promise<{ managers?: ShopManagerRow[]; error?: string }> {
  const auth = await requireAdmin();
  if ('error' in auth) return { error: auth.error };
  const svc = admin();
  if (!svc) return { error: 'Server not configured' };
  const { data } = await svc.from('lab_shop_managers').select('id, name, color, shops, active, user_id').order('name');
  return {
    managers: (data ?? []).map((m: any) => ({
      id: m.id, name: m.name, color: m.color, shops: Array.isArray(m.shops) ? m.shops : [], active: m.active, hasLogin: !!m.user_id,
    })),
  };
}
