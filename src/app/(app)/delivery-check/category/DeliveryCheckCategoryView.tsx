'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, CheckCircle2, PackageCheck, Box } from 'lucide-react';
import { DELIVERY_CHECK_REASONS as REASONS } from '@/lib/delivery-check-reasons';

type Row = {
  id: string; sku: string | null; product_name_vi: string; product_name_en: string | null;
  category: string; team: string | null; order_ref: string; shop_name: string | null;
  delivery_date: string; qty_expected: number; qty_checked: number | null; status: string;
  discrepancy_reason: string | null; discrepancy_note: string | null;
};

export default function DeliveryCheckCategoryView({ rows, today }: { rows: Row[]; today: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [state, setState] = useState<Record<string, { qty: string; reason: string; note: string }>>(() => {
    const s: Record<string, { qty: string; reason: string; note: string }> = {};
    for (const r of rows) s[r.id] = { qty: String(r.qty_checked ?? r.qty_expected), reason: r.discrepancy_reason ?? '', note: r.discrepancy_note ?? '' };
    return s;
  });
  const [checked, setChecked] = useState<Set<string>>(() => new Set(rows.filter(r => r.qty_checked != null).map(r => r.id)));
  const [savingLine, setSavingLine] = useState<string | null>(null);

  const upd = (id: string, patch: Partial<{ qty: string; reason: string; note: string }>) =>
    setState(p => ({ ...p, [id]: { ...p[id], ...patch } }));

  async function checkRow(r: Row) {
    const st = state[r.id]; const qty = Number(st?.qty);
    if (qty !== r.qty_expected && !st?.reason) return;
    setSavingLine(r.id);
    const { checkLineAction } = await import('../actions');
    const res = await checkLineAction(r.id, qty, st?.reason || null, st?.note || null);
    setSavingLine(null);
    if (res.ok) setChecked(p => new Set(p).add(r.id));
  }

  // Group by category, then by product (sku, falling back to name for packaging without one)
  type Group = { name_vi: string; name_en: string | null; rows: Row[] };
  const groups: Record<'production' | 'packaging', Record<string, Group>> = { production: {}, packaging: {} };
  for (const r of rows) {
    const cat = r.category === 'packaging' ? 'packaging' : 'production';
    const key = r.sku || r.product_name_vi;
    const g = groups[cat][key] ??= { name_vi: r.product_name_vi, name_en: r.product_name_en, rows: [] };
    g.rows.push(r);
  }

  const Section = ({ title, icon: Icon, groupMap }: { title: string; icon: any; groupMap: Record<string, Group> }) => {
    const entries = Object.values(groupMap).sort((a, b) => a.name_vi.localeCompare(b.name_vi));
    if (!entries.length) return null;
    return (
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-ink-light mb-2 flex items-center gap-1.5">
          <Icon size={14} /> {title}
        </p>
        <div className="space-y-3 mb-5">
          {entries.map(g => {
            const doneCount = g.rows.filter(r => checked.has(r.id)).length;
            return (
              <div key={g.name_vi} className="card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5" style={{ backgroundColor: '#F9FAFB' }}>
                  <span className="text-sm font-bold text-navy">{vi ? g.name_vi : (g.name_en || g.name_vi)}</span>
                  <span className="text-xs text-ink-light">{doneCount}/{g.rows.length}</span>
                </div>
                <div className="divide-y divide-border-soft">
                  {g.rows.map(r => {
                    const st = state[r.id] ?? { qty: String(r.qty_expected), reason: '', note: '' };
                    const qty = Number(st.qty);
                    const diff = qty - r.qty_expected;
                    const isDiff = diff !== 0;
                    const isChecked = checked.has(r.id);
                    return (
                      <div key={r.id} className="px-4 py-2.5" style={{ backgroundColor: isChecked ? '#F0FDF4' : isDiff ? '#FEF2F2' : undefined }}>
                        <div className="grid grid-cols-12 items-center gap-2">
                          <div className="col-span-5 min-w-0">
                            {/* Order ref + client always shown together — never the ref alone */}
                            <div className="text-sm text-navy truncate">{r.order_ref}</div>
                            <div className="text-xs text-ink-light truncate">{r.shop_name || '—'} · {r.delivery_date}</div>
                          </div>
                          <div className="col-span-2 text-center font-bold text-navy">×{r.qty_expected}</div>
                          <div className="col-span-5 flex items-center justify-center gap-2">
                            {isChecked ? (
                              <span className="inline-flex items-center gap-1.5 text-sm font-bold" style={{ color: '#059669' }}>
                                <CheckCircle2 size={16} /> ×{st.qty}{isDiff && <span style={{ color: '#DC2626' }}> ({diff > 0 ? '+' : ''}{diff})</span>}
                              </span>
                            ) : (
                              <>
                                <input type="number" value={st.qty} onChange={e => upd(r.id, { qty: e.target.value })}
                                  className="w-14 text-center rounded-lg px-2 py-1.5 text-sm font-bold"
                                  style={{ border: '1px solid', borderColor: isDiff ? '#F87171' : '#D1D5DB' }} />
                                {isDiff && <span className="text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>{diff > 0 ? '+' : ''}{diff}</span>}
                                <button onClick={() => checkRow(r)} disabled={savingLine === r.id || (isDiff && !st.reason)}
                                  className="text-xs font-bold px-2.5 py-1.5 rounded-lg text-white shrink-0 disabled:opacity-40"
                                  style={{ backgroundColor: '#16A34A' }}>
                                  {savingLine === r.id ? '…' : 'OK'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {isDiff && !isChecked && (
                          <div className="mt-2 flex flex-col sm:flex-row gap-2">
                            <select value={st.reason} onChange={e => upd(r.id, { reason: e.target.value })}
                              className="rounded-lg px-2 py-1.5 text-sm sm:w-56"
                              style={{ border: '1px solid', borderColor: st.reason ? '#D1D5DB' : '#F87171', backgroundColor: 'white' }}>
                              <option value="">{vi ? '— Lý do —' : '— Raison —'}</option>
                              {REASONS.map(r2 => <option key={r2.v} value={r2.v}>{vi ? r2.vi : r2.en}</option>)}
                            </select>
                            <input type="text" value={st.note} onChange={e => upd(r.id, { note: e.target.value })}
                              placeholder={vi ? 'Ghi chú (tuỳ chọn)' : 'Note (optionnel)'}
                              className="flex-1 rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <Link href="/delivery-check" className="inline-flex items-center gap-1.5 text-sm text-ink-light hover:text-navy">
        <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
      </Link>
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1">
        {vi ? 'Theo sản phẩm' : 'Par catégorie'}
      </h1>
      <p className="text-ink-light text-sm mb-3">
        {vi ? 'Cùng một sản phẩm, mọi đơn trong ngày gộp lại.' : "Même produit, toutes les commandes du jour regroupées."}
      </p>
      <Section title={vi ? 'Sản phẩm sản xuất' : 'Produits fabriqués'} icon={PackageCheck} groupMap={groups.production} />
      <Section title={vi ? 'Bao bì / khác' : 'Packaging / divers'} icon={Box} groupMap={groups.packaging} />
    </div>
  );
}
