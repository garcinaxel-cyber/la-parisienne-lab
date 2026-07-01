'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, TEAMS, type Team, type AssignmentStatus } from '@/lib/types';
import { CheckCircle2, AlertCircle, Clock, Package, ChevronDown, ChevronUp } from 'lucide-react';

interface Stats { imports_today: number; published_today: number; total_assignments: number; done_assignments: number; blocked: number; }

const PREVIEW_COUNT = 6;

export default function DashboardView({ stats, imports, assignments, today }:
  { stats: Stats | null; imports: any[]; assignments: any[]; today: string }) {
  const { t, lang } = useI18n();
  const s = stats ?? { imports_today: 0, published_today: 0, total_assignments: 0, done_assignments: 0, blocked: 0 };
  const pct = s.total_assignments ? Math.round(s.done_assignments / s.total_assignments * 100) : 0;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const byTeam = TEAMS.map(team => ({
    team,
    items: assignments.filter((a: any) => a.team === team),
  })).filter(g => g.items.length > 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-bold text-navy">{t('dashboard')}</h1>
          <p className="text-ink-light text-sm mt-1">{new Date(today + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </div>
        <Link href="/import" className="btn-primary">{t('import')}</Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: lang === 'vi' ? 'Đơn nhập hôm nay' : 'Imports today', value: s.imports_today, icon: Package, color: 'text-navy' },
          { label: lang === 'vi' ? 'Đã phát hành' : 'Published', value: s.published_today, icon: CheckCircle2, color: 'text-green-600' },
          { label: lang === 'vi' ? 'Tiến độ' : 'Progress', value: `${pct}%`, icon: Clock, color: 'text-gold' },
          { label: lang === 'vi' ? 'Bị chặn' : 'Blocked', value: s.blocked, icon: AlertCircle, color: 'text-red-500' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-4 flex items-center gap-3">
            <Icon size={22} className={color} />
            <div>
              <div className="text-2xl font-bold text-navy">{value}</div>
              <div className="text-xs text-ink-light">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {s.total_assignments > 0 && (
        <div className="card p-4">
          <div className="flex justify-between text-sm mb-2">
            <span className="font-medium text-navy">{lang === 'vi' ? 'Tiến độ sản xuất' : 'Production progress'}</span>
            <span className="text-ink-light">{s.done_assignments}/{s.total_assignments}</span>
          </div>
          <div className="h-3 rounded-full bg-border-soft overflow-hidden">
            <div className="h-full bg-green-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* By team */}
      {byTeam.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {byTeam.map(({ team, items }) => {
            const meta = TEAM_LABELS[team as Team];
            const done = items.filter((a: any) => a.status === 'done' || a.status === 'skip').length;
            const isExpanded = !!expanded[team];
            const visibleItems = isExpanded ? items : items.slice(0, PREVIEW_COUNT);
            const hiddenCount = items.length - PREVIEW_COUNT;
            const totalQty = items.reduce((sum: number, a: any) => sum + (a.total_qty ?? 0), 0);
            const pendingQty = items
              .filter((a: any) => a.status !== 'done' && a.status !== 'skip')
              .reduce((sum: number, a: any) => sum + (a.total_qty ?? 0), 0);

            return (
              <div key={team} className="card overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: meta.bg }}>
                  <span className="font-semibold text-sm" style={{ color: meta.color }}>
                    {lang === 'vi' ? meta.vi : meta.en}
                  </span>
                  <span className="text-xs font-medium" style={{ color: meta.color }}>{done}/{items.length}</span>
                </div>
                <div className="divide-y divide-border-soft">
                  {visibleItems.map((a: any) => {
                    const st = STATUS_META[a.status as AssignmentStatus];
                    return (
                      <div key={a.id} className="flex items-center justify-between px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-navy truncate">{a.product_name_vi}</div>
                          {a.variant_label !== 'Standard' && <div className="text-xs text-ink-light">{a.variant_label}</div>}
                        </div>
                        <div className="flex items-center gap-3 ml-3 shrink-0">
                          <span className="text-sm font-bold text-navy">x{a.total_qty}</span>
                          <span className="badge text-white text-[10px]" style={{ backgroundColor: st.color }}>
                            {lang === 'vi' ? st.labelVi : st.labelEn}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {/* Total row when expanded */}
                  {isExpanded && (
                    <div className="flex items-center justify-between px-4 py-2.5 font-semibold" style={{ backgroundColor: meta.bg }}>
                      <span className="text-sm" style={{ color: meta.color }}>
                        {lang === 'vi' ? 'Tổng cộng' : 'Total'}
                      </span>
                      <span className="text-sm" style={{ color: meta.color }}>
                        x{totalQty}
                        {pendingQty > 0 && (
                          <span className="ml-2 text-xs font-normal opacity-70">
                            ({pendingQty} {lang === 'vi' ? 'còn lại' : 'remaining'})
                          </span>
                        )}
                      </span>
                    </div>
                  )}

                  {/* Expand / collapse button */}
                  {hiddenCount > 0 && (
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [team]: !isExpanded }))}
                      className="w-full px-4 py-2 flex items-center justify-center gap-1.5 text-xs font-medium transition-colors hover:bg-gray-50"
                      style={{ color: meta.color }}
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp size={13} />
                          {lang === 'vi' ? 'Thu gọn' : 'Show less'}
                        </>
                      ) : (
                        <>
                          <ChevronDown size={13} />
                          +{hiddenCount} {lang === 'vi' ? 'sản phẩm khác' : 'more'}
                          {' - '}
                          {lang === 'vi' ? 'tổng' : 'total'} x{totalQty}
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card p-12 text-center">
          <Package size={40} className="mx-auto mb-3 text-border-soft" />
          <p className="text-ink-light">{lang === 'vi' ? 'Chưa có đơn nào được phát hành hôm nay' : 'No orders published yet today'}</p>
          <Link href="/import" className="btn-primary mt-4 mx-auto">{t('import')}</Link>
        </div>
      )}

      {/* Upcoming imports */}
      {imports.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-border-soft">
            <h2 className="font-semibold text-navy text-sm">{lang === 'vi' ? 'Đơn gần đây' : 'Recent imports'}</h2>
          </div>
          <div className="divide-y divide-border-soft">
            {imports.map((imp: any) => (
              <Link key={imp.id} href={`/orders/${imp.delivery_date}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-cream transition-colors">
                <div>
                  <span className="text-sm font-medium text-navy">
                    {imp.delivery_date} — {lang === 'vi' ? (imp.type === 'daily' ? 'Đơn chính' : 'Đơn khẩn') : (imp.type === 'daily' ? 'Main' : 'Urgent')} #{imp.order_number}
                  </span>
                  {imp.shipped_from_lab && <span className="ml-2 text-xs text-amber-600">⚡ {lang === 'vi' ? 'Giao từ lab' : 'Ships from lab'}</span>}
                </div>
                <span className={`badge ${imp.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {imp.status === 'published' ? (lang === 'vi' ? 'Đã phát' : 'Published') : (lang === 'vi' ? 'Nháp' : 'Draft')}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
