'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ArrowLeft, CircleAlert, CheckCircle2 } from 'lucide-react';

type Line = {
  id: string; product_name_vi: string; product_name_en: string | null;
  qty_expected: number; qty_checked: number | null; delivery_date: string;
  customer_name: string | null; customer_phone: string | null;
};

export default function DeliveryCheckUnreconciledView({ lines }: { lines: Line[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [checked, setChecked] = useState<Set<string>>(() => new Set(lines.filter(l => l.qty_checked != null).map(l => l.id)));
  const [saving, setSaving] = useState<string | null>(null);

  async function toggle(l: Line) {
    if (checked.has(l.id)) return; // one-way for now — untick isn't a real use case here
    setSaving(l.id);
    const { checkLineAction } = await import('../actions');
    const res = await checkLineAction(l.id, l.qty_expected, null, null);
    setSaving(null);
    if (res.ok) setChecked(p => new Set(p).add(l.id));
  }

  const byDate = new Map<string, Line[]>();
  for (const l of lines) (byDate.get(l.delivery_date) ?? byDate.set(l.delivery_date, []).get(l.delivery_date)!).push(l);
  const dates = Array.from(byDate.keys()).sort();

  return (
    <div className="space-y-4">
      <Link href="/delivery-check" className="inline-flex items-center gap-1.5 text-sm text-ink-light hover:text-navy">
        <ArrowLeft size={15} /> {vi ? 'Quay lại' : 'Retour'}
      </Link>
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1">
        {vi ? 'Chưa đồng bộ Odoo' : 'Non conciliés Odoo'}
      </h1>
      <p className="text-ink-light text-sm mb-3">
        {vi
          ? 'Bánh chưa có đơn Odoo. Tích để tự theo dõi — không đẩy sang Odoo, không in được từ Odoo.'
          : "Cakes sans commande Odoo derrière. Coche pour ton suivi — rien n'est poussé vers Odoo, et ça n'apparaîtra pas sur le bon imprimé tant que ce n'est pas rattaché."}
      </p>

      {lines.length === 0 ? (
        <div className="card p-10 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-green-600" />
          <p className="font-semibold text-navy">{vi ? 'Không có bánh nào chờ' : 'Aucun cake en attente'}</p>
        </div>
      ) : (
        dates.map(d => (
          <div key={d}>
            <p className="text-xs font-bold uppercase tracking-wide text-ink-light mb-2">{d}</p>
            <div className="card overflow-hidden">
              <div className="divide-y divide-border-soft">
                {byDate.get(d)!.map(l => {
                  const isChecked = checked.has(l.id);
                  return (
                    <div key={l.id} className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: isChecked ? '#F0FDF4' : undefined }}>
                      <input type="checkbox" checked={isChecked} disabled={saving === l.id || isChecked}
                        onChange={() => toggle(l)} className="w-4 h-4 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-navy">{vi ? l.product_name_vi : (l.product_name_en || l.product_name_vi)} <span className="text-ink-light">×{l.qty_expected}</span></div>
                        <div className="text-xs text-ink-light truncate">{l.customer_name ?? '—'}{l.customer_phone ? ` · ${l.customer_phone}` : ''}</div>
                      </div>
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1 shrink-0"
                        style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
                        <CircleAlert size={11} /> {vi ? 'chưa có trong Odoo' : 'pas dans Odoo'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
