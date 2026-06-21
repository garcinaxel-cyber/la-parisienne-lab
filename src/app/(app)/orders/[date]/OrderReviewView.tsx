'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, AlertCircle, Clock, Ban, ChevronLeft, Send, MoreVertical, ChevronDown, Store } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, STATUS_META, TEAMS, type Team, type AssignmentStatus } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

type OrderLine = { import_id: string; team: string; variant_label: string; shop_name: string; qty: number; order_ref?: string };

const EXCEPTION_OPTIONS_EN = ['Out of stock', 'Not in production today', 'Already in stock', 'Quantity reduced', 'Other'];
const EXCEPTION_OPTIONS_VI = ['Hết nguyên liệu', 'Không sản xuất hôm nay', 'Đã có trong kho', 'Giảm số lượng', 'Khác'];

export default function OrderReviewView({
  date, imports, assignments, orderLines, userRole,
}: {
  date: string;
  imports: any[];
  assignments: any[];
  orderLines: OrderLine[];
  userRole: string | null;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const [localAssignments, setLocalAssignments] = useState(assignments);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [exceptionModal, setExceptionModal] = useState<{ id: string; productName: string } | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [expandedBreakdown, setExpandedBreakdown] = useState<Set<string>>(new Set());

  function getBreakdown(a: any): { shop_name: string; qty: number }[] {
    // Use stored breakdown JSON first (new imports after v3 migration)
    if (Array.isArray(a.breakdown) && a.breakdown.length > 0) return a.breakdown;
    // Fallback: match from fetched order lines
    return orderLines.filter(
      ol => ol.import_id === a.import_id && ol.team === a.team && ol.variant_label === a.variant_label
    );
  }

  function toggleBreakdown(id: string) {
    setExpandedBreakdown(prev => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
    });
  }

  const canManage = userRole === 'admin' || userRole === 'lab_manager' || userRole === 'assistant';

  const formatDate = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

  async function publishImport(importId: string) {
    setPublishing(importId);
    const supabase = createClient();
    await supabase.from('lab_imports').update({
      status: 'published',
      published_at: new Date().toISOString(),
    }).eq('id', importId);
    setPublishing(null);
    router.refresh();
  }

  async function cancelImport(importId: string) {
    setCancelling(importId);
    const supabase = createClient();
    await supabase.from('lab_imports').update({ status: 'cancelled' }).eq('id', importId);
    setCancelling(null);
    setConfirmCancel(null);
    router.refresh();
  }

  async function deleteImport(importId: string) {
    setDeleting(importId);
    const supabase = createClient();
    // Assignments cascade via FK; delete import is enough
    await supabase.from('lab_imports').delete().eq('id', importId);
    setDeleting(null);
    setConfirmDelete(null);
    router.refresh();
  }

  async function setException(assignmentId: string, reason: string) {
    const supabase = createClient();
    await supabase.from('lab_assignments').update({
      status: 'skip',
      exception_reason: reason,
      exception_at: new Date().toISOString(),
    }).eq('id', assignmentId);
    setLocalAssignments(prev =>
      prev.map(a => a.id === assignmentId
        ? { ...a, status: 'skip', exception_reason: reason }
        : a
      )
    );
    setExceptionModal(null);
    setExceptionReason('');
  }

  const byTeam = TEAMS.map(team => ({
    team,
    lines: localAssignments.filter(a => a.team === team),
  })).filter(g => g.lines.length > 0);

  const allDraftImports = imports.filter(i => i.status === 'draft');
  const hasPublished = imports.some(i => i.status === 'published');

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link href="/orders" className="mt-1 p-1 rounded-lg hover:bg-border-soft transition-colors">
          <ChevronLeft size={20} className="text-ink-light" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-serif text-2xl font-bold text-navy capitalize">{formatDate(date)}</h1>
          <p className="text-sm text-ink-light mt-0.5">
            {imports.length} {lang === 'vi' ? 'đơn' : 'import(s)'}
            {' · '}
            {localAssignments.length} {lang === 'vi' ? 'sản phẩm' : 'products'}
          </p>
        </div>
      </div>

      {/* Imports summary */}
      <div className="space-y-2">
        {imports.map(imp => (
          <div key={imp.id} className="card p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="font-medium text-navy text-sm">
                {imp.type === 'daily'
                  ? (lang === 'vi' ? 'Đơn chính' : 'Main order')
                  : (lang === 'vi' ? 'Đơn bánh khẩn' : 'Urgent cake order')}
                {' '}#{imp.order_number}
                {imp.shipped_from_lab && <span className="ml-2 text-amber-600 text-xs">⚡ {lang === 'vi' ? 'Giao từ lab' : 'Ships from lab'}</span>}
              </div>
              {imp.notes && <div className="text-xs text-ink-light mt-0.5">{imp.notes}</div>}
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge text-xs ${
                imp.status === 'published' ? 'bg-green-100 text-green-700' :
                imp.status === 'draft' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
              }`}>
                {imp.status === 'published'
                  ? (lang === 'vi' ? 'Đã phát' : 'Published')
                  : imp.status === 'draft'
                  ? (lang === 'vi' ? 'Nháp' : 'Draft')
                  : (lang === 'vi' ? 'Đã hủy' : 'Cancelled')}
              </span>
              {canManage && imp.status === 'draft' && (
                <button
                  onClick={() => publishImport(imp.id)}
                  disabled={publishing === imp.id}
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <Send size={13} />
                  {publishing === imp.id ? '…' : (lang === 'vi' ? 'Phát hành' : 'Publish')}
                </button>
              )}
              {canManage && imp.status === 'published' && (
                <button
                  onClick={() => setConfirmCancel(imp.id)}
                  className="text-xs py-1.5 px-3 rounded-xl border border-red-300 text-red-600 hover:bg-red-50 transition-colors"
                >
                  {lang === 'vi' ? 'Hủy đơn' : 'Cancel'}
                </button>
              )}
              {canManage && imp.status === 'cancelled' && (
                <button
                  onClick={() => setConfirmDelete(imp.id)}
                  className="text-xs py-1.5 px-3 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors"
                >
                  {lang === 'vi' ? 'Xóa vĩnh viễn' : 'Delete'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {localAssignments.length > 0 && (() => {
        const done = localAssignments.filter(a => a.status === 'done').length;
        const pct = Math.round(done / localAssignments.length * 100);
        return (
          <div className="card p-4">
            <div className="flex justify-between text-sm mb-2">
              <span className="font-medium text-navy">{lang === 'vi' ? 'Tiến độ sản xuất' : 'Production progress'}</span>
              <span className="text-ink-light">{done}/{localAssignments.length} · {pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-border-soft overflow-hidden">
              <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}

      {/* By team */}
      {byTeam.map(({ team, lines }) => {
        const meta = TEAM_LABELS[team as Team];
        const done = lines.filter(l => l.status === 'done').length;
        return (
          <div key={team} className="card overflow-hidden">
            <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: meta.bg }}>
              <span className="font-semibold text-sm" style={{ color: meta.color }}>
                {lang === 'vi' ? meta.vi : meta.en}
              </span>
              <span className="text-xs" style={{ color: meta.color }}>{done}/{lines.length}</span>
            </div>
            <div className="divide-y divide-border-soft">
              {/* Header */}
              <div className="hidden md:grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50">
                <div className="col-span-4">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
                <div className="col-span-2">{lang === 'vi' ? 'Biến thể' : 'Variant'}</div>
                <div className="col-span-1 text-center">{lang === 'vi' ? 'Cần làm' : 'Need'}</div>
                <div className="col-span-1 text-center">{lang === 'vi' ? 'Đã làm' : 'Done'}</div>
                <div className="col-span-2">{lang === 'vi' ? 'Trạng thái' : 'Status'}</div>
                <div className="col-span-2">{lang === 'vi' ? 'Lý do' : 'Exception'}</div>
              </div>

              {lines.map(a => {
                const st = STATUS_META[a.status as AssignmentStatus];
                const isSkip = a.status === 'skip';
                const breakdown = getBreakdown(a);
                const isExpanded = expandedBreakdown.has(a.id);
                return (
                  <div key={a.id} className={isSkip ? 'bg-purple-50/40' : ''}>
                    <div className="flex md:grid md:grid-cols-12 items-center px-4 py-3 gap-3">
                      {/* Product */}
                      <div className="flex-1 md:col-span-4 min-w-0 flex items-center gap-2">
                        {a.image_url ? (
                          <img src={a.image_url} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" loading="lazy" />
                        ) : (
                          <div className="w-9 h-9 rounded-lg bg-cream shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-navy truncate">{a.product_name_vi}</div>
                          {a.product_name_en && <div className="text-xs text-ink-light truncate">{a.product_name_en}</div>}
                          {/* Client breakdown toggle */}
                          {breakdown.length > 0 && (
                            <button onClick={() => toggleBreakdown(a.id)}
                              className="flex items-center gap-1 text-[10px] font-semibold mt-0.5 transition-colors"
                              style={{ color: '#2D6A4F' }}>
                              <Store size={9} />
                              {breakdown.length} {lang === 'vi' ? 'khách' : 'clients'}
                              <ChevronDown size={9} style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Variant */}
                      <div className="hidden md:block md:col-span-2 text-xs text-ink-light">
                        {a.variant_label !== 'Standard' ? a.variant_label : '–'}
                      </div>
                      {/* Qty */}
                      <div className="md:col-span-1 text-center font-bold text-navy shrink-0">×{a.total_qty}</div>
                      {/* Produced */}
                      <div className="hidden md:block md:col-span-1 text-center text-sm text-ink-light">
                        {a.qty_produced > 0 ? a.qty_produced : '–'}
                      </div>
                      {/* Status badge */}
                      <div className="md:col-span-2 shrink-0">
                        <span className="badge text-white text-[10px] whitespace-nowrap" style={{ backgroundColor: st.color }}>
                          {lang === 'vi' ? st.labelVi : st.labelEn}
                        </span>
                      </div>
                      {/* Exception / action */}
                      <div className="md:col-span-2 text-xs text-ink-light truncate">
                        {a.exception_reason
                          ? <span className="italic">{a.exception_reason}</span>
                          : canManage && !isSkip && (
                            <button
                              onClick={() => setExceptionModal({ id: a.id, productName: a.product_name_vi })}
                              className="text-ink-light hover:text-navy transition-colors"
                              title={lang === 'vi' ? 'Đánh dấu ngoại lệ' : 'Mark exception'}
                            >
                              <MoreVertical size={15} />
                            </button>
                          )}
                      </div>
                    </div>
                    {/* Expanded client breakdown */}
                    {isExpanded && breakdown.length > 0 && (
                      <div className="mx-4 mb-3 rounded-xl overflow-hidden text-xs" style={{ border: '1px solid #E0D49A' }}>
                        {breakdown.map((b, i) => (
                          <div key={i} className="flex items-center justify-between px-3 py-2"
                            style={{ borderTop: i > 0 ? '1px solid #F5EFC8' : undefined, backgroundColor: i % 2 === 0 ? 'white' : '#FFFAEE' }}>
                            <span className="text-ink font-medium">{b.shop_name}</span>
                            <span className="font-bold" style={{ color: '#1A4731' }}>×{b.qty}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/40">
          <div className="card w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-red-700">
              {lang === 'vi' ? '⚠️ Xóa vĩnh viễn đơn này?' : '⚠️ Permanently delete this import?'}
            </h3>
            <p className="text-sm text-ink-light">
              {lang === 'vi'
                ? 'Toàn bộ dữ liệu sẽ bị xóa và không thể khôi phục.'
                : 'All data will be permanently deleted and cannot be recovered.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="btn-secondary text-sm">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button
                onClick={() => deleteImport(confirmDelete)}
                disabled={deleting === confirmDelete}
                className="text-sm py-2 px-4 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                {deleting === confirmDelete ? '…' : (lang === 'vi' ? 'Xóa vĩnh viễn' : 'Delete permanently')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/40">
          <div className="card w-full max-w-sm p-6 space-y-4">
            <h3 className="font-semibold text-navy">
              {lang === 'vi' ? 'Xác nhận hủy đơn?' : 'Cancel this import?'}
            </h3>
            <p className="text-sm text-ink-light">
              {lang === 'vi'
                ? 'Đơn sẽ chuyển sang trạng thái Đã hủy. Chefstation sẽ không còn thấy đơn này.'
                : 'The import will be marked as cancelled and disappear from chef stations.'}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmCancel(null)} className="btn-secondary text-sm">
                {lang === 'vi' ? 'Giữ lại' : 'Keep'}
              </button>
              <button
                onClick={() => cancelImport(confirmCancel)}
                disabled={cancelling === confirmCancel}
                className="text-sm py-2 px-4 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                {cancelling === confirmCancel ? '…' : (lang === 'vi' ? 'Hủy đơn' : 'Cancel import')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Exception modal */}
      {exceptionModal && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/40">
          <div className="card w-full max-w-md p-6 space-y-4">
            <h3 className="font-semibold text-navy">
              {lang === 'vi' ? 'Đánh dấu ngoại lệ' : 'Mark as exception'}
            </h3>
            <p className="text-sm text-ink-light">{exceptionModal.productName}</p>
            <div className="space-y-2">
              {(lang === 'vi' ? EXCEPTION_OPTIONS_VI : EXCEPTION_OPTIONS_EN).map((opt, i) => (
                <button
                  key={i}
                  onClick={() => setExceptionReason(opt)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-sm border transition-colors ${
                    exceptionReason === opt
                      ? 'border-navy bg-navy text-white'
                      : 'border-border-soft hover:border-navy/40'
                  }`}
                >
                  {opt}
                </button>
              ))}
              <input
                value={EXCEPTION_OPTIONS_EN.includes(exceptionReason) || EXCEPTION_OPTIONS_VI.includes(exceptionReason) ? '' : exceptionReason}
                onChange={e => setExceptionReason(e.target.value)}
                placeholder={lang === 'vi' ? 'Hoặc nhập lý do khác…' : 'Or type custom reason…'}
                className="input w-full text-sm"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setExceptionModal(null); setExceptionReason(''); }} className="btn-secondary text-sm">
                {lang === 'vi' ? 'Hủy' : 'Cancel'}
              </button>
              <button
                onClick={() => exceptionReason && setException(exceptionModal.id, exceptionReason)}
                disabled={!exceptionReason}
                className="btn-primary text-sm"
              >
                {lang === 'vi' ? 'Xác nhận' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
