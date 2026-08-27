'use server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';
import { SHOP_NAMES } from './page';

// Isolated from /admin/users/actions.ts on purpose — same createUser pattern (proven, already
// in production for chef/assistant/lab_manager accounts) but kept in its own file so this new
// 'shop' role work never touches that existing, live file.

async function requireStaff(supabase: ReturnType<typeof createClient>) {
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' as const };
  return { ok: true as const };
}

function admin() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function createShopAccountAction(shopName: string, email: string): Promise<{ link?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireStaff(supabase);
  if ('error' in auth) return { error: auth.error };
  if (!SHOP_NAMES.includes(shopName)) return { error: 'Unknown shop' };
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { error: 'Invalid email' };

  const svc = admin();
  if (!svc) return { error: 'Server not configured' };

  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: cleanEmail, email_confirm: true, user_metadata: { full_name: shopName },
  });
  let userId = authData?.user?.id;
  if (authErr || !userId) {
    const alreadyExists = authErr?.message?.toLowerCase().includes('already');
    if (!alreadyExists) return { error: authErr?.message ?? 'Failed to create user' };
    const { data: list } = await svc.auth.admin.listUsers();
    userId = list?.users?.find(u => u.email?.toLowerCase() === cleanEmail)?.id;
    if (!userId) return { error: 'User exists but could not be located' };
  }

  const { error: profileErr } = await svc.from('profiles').upsert({ id: userId, full_name: shopName, role: 'shop' }, { onConflict: 'id' });
  if (profileErr) return { error: profileErr.message };
  const { error: lpErr } = await svc.from('lab_profiles').upsert({ id: userId, shop_name: shopName }, { onConflict: 'id' });
  if (lpErr) return { error: lpErr.message };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';
  const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
    type: 'recovery', email: cleanEmail, options: { redirectTo: `${siteUrl}/auth/set-password` },
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    return { error: linkErr?.message ?? 'Account created but link generation failed' };
  }
  const link = `${siteUrl}/auth/set-password?token_hash=${linkData.properties.hashed_token}&type=recovery`;

  revalidatePath('/admin/shop-access');
  return { link };
}

// Added 2026-08-27 (Axel: mismatched/duplicated emails across shop portal accounts, wanted
// exact email+password set directly instead of the recovery-link flow). Mirrors
// createShopAccountAction's user+profile+lab_profiles wiring but (a) accepts an explicit
// password via the Admin API's `password` field instead of generating a recovery link, and
// (b) updates the existing auth user (email+password) when one is already linked to the shop,
// instead of only supporting brand-new accounts.
export async function setShopCredentialsAction(shopName: string, email: string, password: string): Promise<{ ok?: true; error?: string }> {
  const supabase = createClient();
  const auth = await requireStaff(supabase);
  if ('error' in auth) return { error: auth.error };
  if (!SHOP_NAMES.includes(shopName)) return { error: 'Unknown shop' };
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[\x00-\x7F]+$/.test(cleanEmail)) return { error: 'Email sans accents (lettres/chiffres standards uniquement)' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return { error: 'Invalid email' };
  if (password.length < 8) return { error: 'Mot de passe trop court (8 caractères min)' };

  const svc = admin();
  if (!svc) return { error: 'Server not configured' };

  const { data: lp } = await svc.from('lab_profiles').select('id').eq('shop_name', shopName).maybeSingle();
  let userId = lp?.id as string | undefined;

  if (userId) {
    const { error: updErr } = await svc.auth.admin.updateUserById(userId, { email: cleanEmail, password, email_confirm: true });
    if (updErr) return { error: updErr.message };
  } else {
    const { data: authData, error: authErr } = await svc.auth.admin.createUser({
      email: cleanEmail, password, email_confirm: true, user_metadata: { full_name: shopName },
    });
    userId = authData?.user?.id;
    if (authErr || !userId) return { error: authErr?.message ?? 'Failed to create user' };
  }

  const { error: profileErr } = await svc.from('profiles').upsert({ id: userId, full_name: shopName, role: 'shop' }, { onConflict: 'id' });
  if (profileErr) return { error: profileErr.message };
  const { error: lpErr } = await svc.from('lab_profiles').upsert({ id: userId, shop_name: shopName }, { onConflict: 'id' });
  if (lpErr) return { error: lpErr.message };

  revalidatePath('/admin/shop-access');
  return { ok: true };
}

export async function generateShopResetLinkAction(shopName: string): Promise<{ link?: string; error?: string }> {
  const supabase = createClient();
  const auth = await requireStaff(supabase);
  if ('error' in auth) return { error: auth.error };

  const svc = admin();
  if (!svc) return { error: 'Server not configured' };
  const { data: lp } = await svc.from('lab_profiles').select('id').eq('shop_name', shopName).maybeSingle();
  if (!lp) return { error: 'No account for this shop' };
  const { data: userData } = await svc.auth.admin.getUserById(lp.id);
  const email = userData?.user?.email;
  if (!email) return { error: 'User email not found' };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';
  const { data, error } = await svc.auth.admin.generateLink({
    type: 'recovery', email, options: { redirectTo: `${siteUrl}/auth/set-password` },
  });
  if (error || !data?.properties?.hashed_token) return { error: error?.message ?? 'Failed to generate link' };
  const link = `${siteUrl}/auth/set-password?token_hash=${data.properties.hashed_token}&type=recovery`;
  return { link };
}
