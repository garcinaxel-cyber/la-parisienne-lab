import { redirect } from 'next/navigation';
import { rawActor, isPurchasing, rawService, loadLines } from '@/lib/raw-materials-db';
import PurchasePrintView from './PurchasePrintView';

export const revalidate = 0;

// Printable purchase request (Axel, 2026-10-22) — the purchasing manager's own paper template
// "PHIẾU ĐỀ XUẤT MUA HÀNG" (columns STT / Tên vật tư / ĐVT / Số lượng / Đơn giá (đã VAT) /
// Thành tiền / Ghi chú, approval box), with the La Paris logo like every other print.
// Outside the (app) group so the print has no app chrome (same reason as /delivery-print).
// Lines are the ones selected on the purchasing board (?lines=id,id,…).
export default async function PurchasePrintPage({ searchParams }: { searchParams: { lines?: string } }) {
  const a = await rawActor();
  if (!a) redirect('/login');
  if (!isPurchasing(a)) redirect('/dashboard');
  const db = rawService();
  if (!db) redirect('/purchasing');
  const ids = String(searchParams.lines ?? '').split(',').map(s => s.trim())
    .filter(s => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 300);
  if (!ids.length) redirect('/purchasing');
  const lines = await loadLines(db, q => q.in('id', ids));
  return <PurchasePrintView lines={lines} printedBy={a.name} />;
}
