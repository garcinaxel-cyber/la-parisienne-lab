'use server';
import { createClient } from '@/lib/supabase-server';
import { revalidatePath } from 'next/cache';

// Upsert the complementary info attached to ONE birthday-cake order line.
// Never creates or duplicates an order — only the extra fields, keyed by order_line_id.
export async function saveBirthdayDetailAction(
  orderLineId: string,
  fields: { message?: string | null; readyTime?: string | null; deliveredBy?: string | null; deliveryAddress?: string | null },
): Promise<{ ok?: boolean; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Not authorized' };

  const { error } = await supabase.from('lab_birthday_details').upsert({
    order_line_id: orderLineId,
    message: fields.message ?? null,
    ready_time: fields.readyTime ?? null,
    delivered_by: fields.deliveredBy ?? null,
    delivery_address: fields.deliveryAddress ?? null,
    updated_by: session.user.id,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'order_line_id' });
  if (error) return { error: error.message };

  revalidatePath('/birthday-cakes');
  return { ok: true };
}
