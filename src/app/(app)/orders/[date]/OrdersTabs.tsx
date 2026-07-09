'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, Users } from 'lucide-react';
import OrderReviewView from './OrderReviewView';
import OrdersCommandView from './OrdersCommandView';
import PublishBar from './PublishBar';

// Two views over the same data:
//  - "By order"  : the assistants' cockpit (one row per client order, Odoo status + production progress)
//  - "By team"   : the original review view (kept unchanged)
export default function OrdersTabs(props: {
  date: string;
  imports: any[];
  assignments: any[];
  orderLines: any[];
  unmatchedProducts: { sku: string; name: string; qty: number }[];
  missingCardsCount: number;
  userRole: string | null;
}) {
  const { lang } = useI18n();
  const [view, setView] = useState<'orders' | 'teams'>('orders');
  const canManage = ['admin', 'lab_manager', 'assistant'].includes(props.userRole ?? '');

  return (
    <div className="space-y-4">
      {/* Publish + unmatched-products bar — shared across both views */}
      <PublishBar date={props.date} imports={props.imports}
        unmatchedProducts={props.unmatchedProducts}
        missingCardsCount={props.missingCardsCount} canManage={canManage} />

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
