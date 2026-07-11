'use server';
import { createClient } from '@/lib/supabase-server';

export interface TransferLineInput {
  assignmentId: string;
  productNameVi: string;
  productNameEn: string;
  sku: string | null;
  variantLabel: string;
  imageUrl: string | null;
  deliveryDate: string | null;
  qtySent: number;
}

// Chef hands finished products off to stock. Creates one transfer note (bon) with lines,
// and flags the source cards as transferred (so they can't be sent twice). RLS restricts
// this to the chef's own team.
export async function submitStockTransferAction(
  team: string,
  lines: TransferLineInput[],
): Promise<{ ok?: boolean; transferId?: string; error?: string }> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not authenticated' };
  const clean = (lines ?? []).filter(l => l.assignmentId && l.qtySent > 0);
  if (!clean.length) return { error: 'No products selected' };

  const { data: profile } = await supabase
    .from('profiles').select('full_name').eq('id', session.user.id).maybeSingle();

  const { data: transfer, error: tErr } = await supabase
    .from('lab_stock_transfers')
    .insert({ team, created_by: session.user.id, created_by_name: profile?.full_name ?? null, status: 'pending' })
    .select('id').single();
  if (tErr || !transfer) return { error: tErr?.message ?? 'Could not create transfer' };

  const { error: lErr } = await supabase.from('lab_stock_transfer_lines').insert(
    clean.map(l => ({
      transfer_id: transfer.id,
      assignment_id: l.assignmentId,
      product_name_vi: l.productNameVi,
      product_name_en: l.productNameEn,
      sku: l.sku,
      variant_label: l.variantLabel,
      image_url: l.imageUrl,
      delivery_date: l.deliveryDate,
      qty_sent: Math.round(l.qtySent),
    })),
  );
  if (lErr) {
    await supabase.from('lab_stock_transfers').delete().eq('id', transfer.id);
    return { error: lErr.message };
  }

  await supabase.from('lab_assignments')
    .update({ transferred: true }).in('id', clean.map(l => l.assignmentId));

  return { ok: true, transferId: transfer.id };
}
