'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, TEAMS, type Team, type AssignmentStatus } from '@/lib/types';
import { CheckCircle2, AlertCircle, Clock, Package, ChevronDown, ChevronUp } from 'lucide-react';

interface Stats { imports_today: number; published_today: number; total_assignments: number; done_assignments: number; blocked: number; }

const PREVIEW_COUNT = 6;

// Animated count-up for KPI numbers — purely cosmetic, no data implications
function CountUp({ value, suffix = '', duration = 700 }: { value: number; suffix?: string; duration?: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let raf: number;
    const start = performance.now();
    function tick(now: number) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{display}{suffix}</>;
}

export default function DashboardView({ stats, imports, assignments, orderLines = [], pendingChanges = [], today }:
  { stats: Stats | null; imports: any[]; assignments: any[]; orderLines?: any[]; pendingChanges?: any[]; today: string }) {
  const { t, lang } = useI18n();
  const [applyingChanges, setApplyingChanges] = useState(false);
  const [changesDone, setChangesDone] = useState(false);

  async function applyChanges() {
    setApplyingChanges(true);
    const { applyPendingChangesAction } = await import('@/app/(app)/odoo-changes-actions');
    await applyPendingChangesAction();
    setApplyingChanges(false);
    setChangesDone(true);
    setTimeout(() => window.location.reload(), 800);
  }
  const s = stats ?? { imports_today: 0, published_today: 0, total_assignments: 0, done_assignments: 0, blocked: 0 };
  const pct = s.total_assignments ? Math.round(s.done_assignments / s.total_assignments * 100) : 0;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'teams' | 'orders'>('teams');
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  const byTeam = TEAMS.map(team => ({
    team,
    items: assignments.filter((a: any) => a.team === team),
  })).filter(g => g.items.length > 0);

  // Per-order progress: each order line inherits the status of its production card
  const asgStatus: Record<string, string> = {};
  for (const a of assignments) asgStatus[`${a.import_id}||${a.team}||${a.variant_label}||${a.product_name_vi}`] = a.status;
  type OrderLineDetail = { name: string; variant: string; qty: number; team: string; status: string | null };
  const orderMap = new Map<string, { shops: string[]; time: string | null; total: number; ready: number; units: number; lines: OrderLineDetail[] }>();
  for (const ol of orderLines) {
    if (!ol.order_ref || !ol.qty) continue;
    let o = orderMap.get(ol.order_ref);
    if (!o) { o = { shops: [], time: null, total: 0, ready: 0, units: 0, lines: [] }; orderMap.set(ol.order_ref, o); }
    if (ol.shop_name && !o.shops.includes(ol.shop_name)) o.shops.push(ol.shop_name);
    if (ol.delivery_time && (!o.time || ol.delivery_time < o.time)) o.time = ol.delivery_time;
    const st = asgStatus[`${ol.import_id}||${ol.team}||${ol.variant_label}||${ol.product_name_vi}`] ?? null;
    o.total += 1; o.units += ol.qty;
    if (st === 'done' || st === 'skip') o.ready += 1;
    o.lines.push({ name: ol.product_name_vi ?? '', variant: ol.variant_label ?? '', qty: ol.qty, team: ol.team ?? '', status: st });
  }
  const orderRows = Array.from(orderMap.entries())
    .map(([ref, o]) => ({ ref, ...o }))
    .sort((a, b) => ((a.time ?? '99') < (b.time ?? '99') ? -1 : 1));

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

      {/* Odoo modifications detected by the auto-sync — awaiting review */}
      {pendingChanges.length > 0 && !changesDone && (
        <div className="rounded-2xl border-2 overflow-hidden" style={{ borderColor: '#DC2626' }}>
          <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#FEF2F2' }}>
            <AlertCircle size={20} className="shrink-0" style={{ color: '#DC2626' }} />
            <div className="flex-1">
              <div className="font-bold text-sm" style={{ color: '#B91C1C' }}>
                {pendingChanges.length} {lang === 'vi' ? 'đơn đã thay đổi trong Odoo' : 'orders changed in Odoo'}
              </div>
              <div className="text-xs" style={{ color: '#B91C1C' }}>
                {lang === 'vi' ? 'Đồng bộ tự động phát hiện — kiểm tra và cập nhật sản xuất' : 'Detected by auto-sync — review and update production'}
              </div>
            </div>
            <button onClick={applyChanges} disabled={applyingChanges}
              className="text-xs font-bold px-4 py-2 rounded-xl text-white shrink-0 disabled:opacity-60"
              style={{ backgroundColor: '#B91C1C' }}>
              {applyingChanges ? '…' : (lang === 'vi' ? 'Cập nhật' : 'Update production')}
            </button>
          </div>
          <div className="divide-y bg-white" style={{ borderColor: '#FEE2E2' }}>
            {pendingChanges.slice(0, 8).map((ch: any) => (
              <div key={ch.order_ref} className="px-4 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs font-semibold text-navy">{ch.order_ref}</span>
                  {ch.cancelled && <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEE2E2', color: '#B91C1C' }}>{lang === 'vi' ? 'ĐÃ HỦY' : 'CANCELLED'}</span>}
                  {ch.delivery_date && <span className="text-xs text-ink-light">{ch.delivery_date}</span>}
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {(ch.items ?? []).map((it: any) => (
                    <div key={it.sku} className="flex items-center gap-2 text-xs text-ink-light">
                      <span className="flex-1 truncate">{it.name ?? it.sku}</span>
                      <span>×{it.old_qty ?? 0} → <span className={`font-bold ${(it.new_qty ?? 0) > (it.old_qty ?? 0) ? 'text-green-600' : 'text-red-600'}`}>×{it.new_qty}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft imports waiting for review — created by the hourly Odoo auto-sync */}
      {imports.some((i: any) => i.status === 'draft') && (
        <Link href={`/orders/${imports.find((i: any) => i.status === 'draft')?.delivery_date}`}
          className="card p-4 flex items-center gap-3 border-2 transition-colors hover:bg-amber-50"
          style={{ borderColor: '#F59E0B', backgroundColor: '#FFFBEB' }}>
          <AlertCircle size={20} className="text-amber-600 shrink-0" />
          <div className="flex-1">
            <div className="font-bold text-sm text-amber-800">
              {imports.filter((i: any) => i.status === 'draft').length} {lang === 'vi' ? 'bản nháp đang chờ duyệt' : 'draft imports waiting for review'}
            </div>
            <div className="text-xs text-amber-700">
              {lang === 'vi' ? 'Đồng bộ tự động từ Odoo — kiểm tra và phát hành' : 'Auto-synced from Odoo — review and publish'}
            </div>
          </div>
          <ChevronDown size={16} className="text-amber-600 -rotate-90" />
        </Link>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: lang === 'vi' ? 'Đơn nhập hôm nay' : 'Imports today', value: s.imports_today, suffix: '', icon: Package, color: 'text-navy' },
          { label: lang === 'vi' ? 'Đã phát hành' : 'Published', value: s.published_today, suffix: '', icon: CheckCircle2, color: 'text-green-600' },
          { label: lang === 'vi' ? 'Tiến độ' : 'Progress', value: pct, suffix: '%', icon: Clock, color: 'text-gold' },
          { label: lang === 'vi' ? 'Bị chặn' : 'Blocked', value: s.blocked, suffix: '', icon: AlertCircle, color: 'text-red-500' },
        ].map(({ label, value, suffix, icon: Icon, color }) => (
          <div key={label} className="card p-4 flex items-center gap-3">
            <Icon size={22} className={color} />
            <div>
              <div className="text-2xl font-bold text-navy"><CountUp value={value} suffix={suffix} /></div>
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

      {/* View toggle: by team (chefs' angle) / by order (assistants' angle) */}
      {(byTeam.length > 0 || orderRows.length > 0) && (
        <div className="flex gap-2">
          {([['teams', lang === 'vi' ? 'Theo đội' : 'By team'], ['orders', lang === 'vi' ? 'Theo đơn hàng' : 'By order']] as const).map(([key, label]) => (
            <button key={key} onClick={() => setViewMode(key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                viewMode === key ? 'bg-navy text-white' : 'bg-white border border-border-soft text-ink-light hover:text-navy'
              }`}>{label}</button>
          ))}
        </div>
      )}

      {/* By order — one row per client order, sorted by delivery time */}
      {viewMode === 'orders' && orderRows.length > 0 && (
        <div className="card overflow-hidden divide-y divide-border-soft">
          {orderRows.map(o => {
            const opct = o.total ? Math.round(o.ready / o.total * 100) : 0;
            const isOpen = expandedOrder === o.ref;
            return (
              <div key={o.ref}>
                <button onClick={() => setExpandedOrder(isOpen ? null : o.ref)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-cream/50 transition-colors text-left">
                  {isOpen ? <ChevronUp size={13} className="text-ink-light shrink-0" /> : <ChevronDown size={13} className="text-ink-light shrink-0" />}
                  <span className="font-mono text-xs font-bold text-navy shrink-0">{o.ref}</span>
                  <span className="text-xs text-ink-light truncate flex-1">
                    {o.shops.join(', ')}
                    {o.time && <span className="ml-2 inline-flex items-center gap-1"><Clock size={11} />{o.time}</span>}
                  </span>
                  <span className="text-xs text-ink-light shrink-0">×{o.units}</span>
                  <span className={`text-xs shrink-0 ${opct === 100 ? 'text-green-600 font-semibold' : 'text-ink-light'}`}>
                    {o.ready}/{o.total}
                  </span>
                  <div className="w-20 h-1.5 rounded-full bg-border-soft overflow-hidden shrink-0">
                    <div className="h-full rounded-full transition-all" style={{ width: `${opct}%`, backgroundColor: opct === 100 ? '#16A34A' : '#B45309' }} />
                  </div>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 pt-1 bg-cream/40">
                    {o.lines.map((l, i) => {
                      const teamMeta = TEAM_LABELS[l.team as Team];
                      const st = l.status ? STATUS_META[l.status as AssignmentStatus] : null;
                      return (
                        <div key={i} className="flex items-center gap-2 py-1 text-xs border-t border-border-soft/60">
                          <span className="text-navy truncate flex-1">
                            {l.name}{l.variant && l.variant !== 'Standard' ? <span className="text-ink-light"> · {l.variant}</span> : null}
                          </span>
                          {teamMeta && <span className="font-semibold shrink-0" style={{ color: teamMeta.color }}>{lang === 'vi' ? teamMeta.vi : teamMeta.en}</span>}
                          <span className="font-bold text-navy shrink-0">×{l.qty}</span>
                          {st
                            ? <span className="badge text-white text-[10px] shrink-0" style={{ backgroundColor: st.color }}>{lang === 'vi' ? st.labelVi : st.labelEn}</span>
                            : <span className="text-[10px] text-ink-light shrink-0">—</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* By team */}
      {viewMode === 'teams' && (byTeam.length > 0 ? (
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
                        <div className="flex items-center gap-2 ml-3 shrink-0">
                          <span className="text-sm font-bold text-navy">x{a.total_qty}</span>
                          {a.produced_ahead && a.status === 'done' && (
                            <span className="badge text-[10px]" style={{ backgroundColor: '#DBEAFE', color: '#1E40AF' }}>
                              ⏩ {lang === 'vi' ? 'Trước' : 'Ahead'}
                            </span>
                          )}
                          <span className="badge text-white text-[10px]"
                            style={{ backgroundColor: a.produced_ahead && a.status === 'done' ? '#2563EB' : st.color }}>
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
      ))}

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
