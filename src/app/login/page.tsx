import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { createClient } from '@/lib/supabase-server';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (session) redirect('/dashboard');
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
