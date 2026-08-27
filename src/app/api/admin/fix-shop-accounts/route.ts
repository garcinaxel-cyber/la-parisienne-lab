import { NextResponse } from 'next/server';
import { setShopCredentialsAction } from '@/app/(app)/admin/shop-access/actions';

// One-time-use-friendly, staff-only endpoint: sets email+password for a batch of shop portal
// accounts in one call. No credentials are hardcoded here — they're supplied in the request
// body by the caller (already-authenticated staff session), so nothing sensitive lives in the
// repo/git history. Auth is enforced inside setShopCredentialsAction itself (requireStaff),
// same as every other action in this file — this route has no separate secret of its own.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as
    { items?: { shopName: string; email: string; password: string }[] } | null;
  if (!body?.items?.length) return NextResponse.json({ error: 'No items' }, { status: 400 });

  const results = [];
  for (const item of body.items) {
    const res = await setShopCredentialsAction(item.shopName, item.email, item.password);
    results.push({ shopName: item.shopName, ...res });
  }
  return NextResponse.json({ results });
}
