'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, Users } from 'lucide-react';
import OrderReviewView from './OrderReviewView';
import OrdersCommandView from './OrdersCommandView';

// Two views over the same data:
//  - "By order"  : the assistants' cockpit (one row per client order, Odoo status + production progress)
//  - "By team"   : the original review view (kept unchanged)
export default function OrdersTabs(props: {
  date: string;
  imports: any[];
  assignments: any[];
  orderLines: any[];
  userRole: string | null;
}) {
  const { lang } = useI18n();
  const [view, setView] = useState<'orders' | 'teams'>('orders');

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-border-soft">
        {[
          { key: 'orders' as const, icon: ClipboardList, label: lang === 'vi' ? 'Theo đơn hàng' : 'By order' },
          { key: 'teams' as const, icon: Users, label: lang === 'vi' ? 'Theo đội / chi tiết' : 'By team / detail' },
        ].map(t => (
          <button key={t.key} onClick={() => setView(t.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors -mb-px flex items-center gap-2 ${
              view === t.key
                ? 'bg-white border border-border-soft border-b-white text-navy'
                : 'text-ink-light hover:text-navy'
            }`}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {view === 'orders'
        ? <OrdersCommandView {...props} />
        : <OrderReviewView {...props} />}
    </div>
  );
}
