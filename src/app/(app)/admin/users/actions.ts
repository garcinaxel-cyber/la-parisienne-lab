'use server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

export async function inviteLabUser(data: {
  email: string;
  fullName: string;
  role: 'chef' | 'assistant' | 'lab_manager' | 'worker';
  team: string | null;
}): Promise<{ error?: string; success?: true }> {
  const { email, fullName, role, team } = data;

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: 'SUPABASE_SERVICE_ROLE_KEY not configured on server.' };
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Invite user — sends email with a setup link landing on our set-password page
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';
  const { data: authData, error: authErr } = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${siteUrl}/auth/set-password`,
  });
  if (authErr) return { error: authErr.message };

  const userId = authData.user.id;

  // 2. Create profile with lab role only (no sales/viewer = no catalogue app access)
  const { error: profileErr } = await supabase
    .from('profiles')
    .upsert({ id: userId, full_name: fullName, role }, { onConflict: 'id' });
  if (profileErr) return { error: profileErr.message };

  // 3. Create lab_profiles with team assignment
  if (team) {
    const { error: lpErr } = await supabase
      .from('lab_profiles')
      .upsert({ id: userId, team }, { onConflict: 'id' });
    if (lpErr) return { error: lpErr.message };
  }

  revalidatePath('/admin/users');
  return { success: true };
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
  if (error || !data?.properties?.action_link) return { error: error?.message ?? 'Failed to generate link' };
  return { link: data.properties.action_link, email };
}
