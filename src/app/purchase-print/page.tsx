import { redirect } from 'next/navigation';
import { rawActor, isPurchasing, rawService, loadLines } from '@/lib/raw-materials-db';
import { odooExecute } from '@/lib/odoo';
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
  const raw = await loadLines(db, q => q.in('id', ids));
  // Vietnamese names on the paper (Axel, 2026-10-28: "les impressions des purchase request doivent se
  // mettre avec les noms viet") — the line keeps the name picked at request time (often the English
  // Odoo base name). Source: lab_raw_materials.name_vi (Odoo vi_VN), then Odoo vi_VN live for the rest.
  const tmplIds = Array.from(new Set(raw.map(l => l.tmplId).filter((t): t is number => typeof t === 'number' && t > 0)));
  const vi = new Map<number, string>();
  if (tmplIds.length) {
    const { data } = await db.from('lab_raw_materials').select('tmpl_id, name_vi').in('tmpl_id', tmplIds);
    for (const r of data ?? []) if (r.name_vi && String(r.name_vi).trim()) vi.set(Number(r.tmpl_id), String(r.name_vi).trim());
    const missing = tmplIds.filter(t => !vi.has(t));
    if (missing.length) {
      try {
        const rows = await odooExecute<any[]>('product.template', 'read', [missing], { fields: ['name'], context: { lang: 'vi_VN' } });
        for (const r of rows ?? []) if (r?.name) vi.set(Number(r.id), String(r.name).trim());
      } catch { /* Odoo down: keep the stored name */ }
    }
  }
  const lines = raw.map(l => (l.tmplId && vi.has(l.tmplId) ? { ...l, name: vi.get(l.tmplId)! } : l));
  return <PurchasePrintView lines={lines} printedBy={a.name} />;
}
