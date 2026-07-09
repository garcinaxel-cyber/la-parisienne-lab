'use server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

export async function inviteLabUser(data: {
  email: string;
  fullName: string;
  role: 'chef' | 'assistant' | 'lab_manager' | 'worker';
  team: string | null;
}): Promise<{ error?: string; success?: true; link?: string }> {
  const { email, fullName, role, team } = data;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: 'SUPABASE_SERVICE_ROLE_KEY not configured on server.' };
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';

  // 1. Create the account directly — NO email sent (Supabase default SMTP is rate-limited
  //    to ~2-3/hour and this shop has no custom SMTP/OA). The admin shares the link via Zalo.
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (authErr || !authData?.user) {
    // If the user already exists, fall back to just (re)generating a link below
    const existing = authErr?.message?.toLowerCase().includes('already') ? true : false;
    if (!existing) return { error: authErr?.message ?? 'Failed to create user' };
  }

  // Resolve the user id (new or existing)
  let userId = authData?.user?.id;
  if (!userId) {
    const { data: list } = await supabase.auth.admin.listUsers();
    userId = list?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase())?.id;
    if (!userId) return { error: 'User exists but could not be located' };
  }

  // 2. Profile (lab role only = no catalogue app access) + team
  const { error: profileErr } = await supabase
    .from('profiles')
    .upsert({ id: userId, full_name: fullName, role }, { onConflict: 'id' });
  if (profileErr) return { error: profileErr.message };
  if (team) {
    const { error: lpErr } = await supabase
      .from('lab_profiles')
      .upsert({ id: userId, team }, { onConflict: 'id' });
    if (lpErr) return { error: lpErr.message };
  }

  // 3. Password-setup link (token_hash — works on any device), shared via Zalo
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${siteUrl}/auth/set-password` },
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    return { error: linkErr?.message ?? 'Account created but link generation failed — use the 🔑 button' };
  }
  const link = `${siteUrl}/auth/set-password?token_hash=${linkData.properties.hashed_token}&type=recovery`;

  revalidatePath('/admin/users');
  return { success: true, link };
}

// Generate a password-reset link WITHOUT sending an email (bypasses the
// Supabase email rate limit). The admin shares it via Zalo/any channel.
// The link lands on /auth/set-password.
export async function generateResetLink(userId: string): Promise<{ link?: string; email?: string; error?: string }> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: 'SUPABASE_SERVICE_ROLE_KEY not configured on server.' };
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(userId);
  const email = userData?.user?.email;
  if (userErr || !email) return { error: userErr?.message ?? 'User email not found' };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${siteUrl}/auth/set-password` },
  });
  if (error || !data?.properties?.hashed_token) return { error: error?.message ?? 'Failed to generate link' };
  // Build a token_hash link — verifiable on ANY device (no PKCE code_verifier needed,
  // unlike the default action_link which fails when opened on a different device)
  const link = `${siteUrl}/auth/set-password?token_hash=${data.properties.hashed_token}&type=recovery`;
  return { link, email };
}
