'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { AlertCircle, CheckCircle2, FilePlus, Send, Ban } from 'lucide-react';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { publishImportAction, generateMissingCardsAction } from './actions';
import { createFicheFromSku } from '../../import/actions';
import { excludeSkuAction } from '../../odoo-changes-actions';

type Unmatched = { sku: string; name: string; qty: number };

// Shared publish/status bar shown above BOTH order views (by order + by team).
// One place to: see draft/published status, resolve products without a recipe
// card (create fiche / ignore), generate cards for fiches added post-publish, and publish.
export default function PublishBar({ date, imports, orderLines = [], unmatchedProducts, missingCardsCount, missingCards = [], canManage }: {
  date: string; imports: any[]; orderLines?: any[]; unmatchedProducts: Unmatched[]; missingCardsCount: number; missingCards?: { name: string; team: string; qty: number }[]; canManage: boolean;
}) {
  const { lang } = useI18n();
  const router = useRouter();
  const [publishing, setPublishing] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [excluding, setExcluding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exclude(sku: string, name: string) {
    setExcluding(sku); setError(null);
    const res = await excludeSkuAction(sku, name);
    setExcluding(null);
    if (res?.error) { setError(res.error); return; }
    router.refresh();
  }

  async function generateMissing() {
    setGenerating(true); setError(null);
    const res = await generateMissingCardsAction(date);
    setGenerating(false);
    if (res?.error) { setError(res.error); return; }
    router.refresh();
  }

  const drafts = imports.filter(i => i.status === 'draft');
  const published = imports.filter(i => i.status === 'published');

  async function publish(id: string) {
    setPublishing(id); setError(null);
    const res = await publishImportAction(id, date);
    setPublishing(null);
    if (res?.error) { setError(res.error); return; }
    router.refresh();
  }

  async function createFiche(sku: string, name: string) {
    setCreating(sku); setError(null);
    const { ficheId, error } = await createFicheFromSku(sku, name);
    if (error || !ficheId) { setCreating(null); setError(error ?? 'Failed'); return; }
    router.push(`/admin/fiches/${ficheId}?back=/orders/${date}`);
  }

  if (!canManage && !drafts.length) return null;

  return (
    <div className="space-y-3">
      {/* Products without a recipe card — won't be produced */}
      {unmatchedProducts.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#FCD34D' }}>
          <div className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium" style={{ backgroundColor: '#FFFBEB', color: '#92600A' }}>
            <AlertCircle size={16} className="shrink-0" />
            <span>
              {unmatchedProducts.length} {lang === 'vi'
                ? 'sản phẩm chưa có phiếu kỹ thuật — sẽ KHÔNG được sản xuất'
                : 'products without a recipe card — will NOT be produced'}
            </span>
          </div>
          <div className="divide-y divide-amber-100 bg-white">
            {unmatchedProducts.map(p => (
              <div key={p.sku} className="flex items-center gap-2 px-4 py-2 text-sm">
                <code className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{p.sku}</code>
                <span className="flex-1 truncate text-navy">{p.name}</span>
                <span className="text-xs text-ink-light shrink-0">×{p.qty}</span>
                {canManage && (
                  <>
                    <button onClick={() => exclude(p.sku, p.name)} disabled={excluding === p.sku}
                      className="text-xs font-semibold px-3 py-1 rounded-full shrink-0 flex items-center gap-1 border disabled:opacity-50"
                      style={{ borderColor: '#D1D5DB', color: '#6B7280' }}
                      title={lang === 'vi' ? 'Không sản xuất (bao bì, đồ uống…)' : 'Not produced (packaging, drinks…)'}>
                      <Ban size={11} />
                      {excluding === p.sku ? '…' : (lang === 'vi' ? 'Không SX' : 'Not produced')}
                    </button>
                    <button onClick={() => createFiche(p.sku, p.name)} disabled={creating === p.sku || !!creating}
                      className="text-xs font-semibold px-3 py-1 rounded-full shrink-0 flex items-center gap-1 disabled:opacity-50"
                      style={{ backgroundColor: '#1A4731', color: 'white' }}>
                      <FilePlus size={11} />
                      {creating === p.sku ? '…' : (lang === 'vi' ? 'Tạo phiếu' : 'Create fiche')}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Draft imports awaiting publish */}
      {canManage && drafts.map(imp => (
        <div key={imp.id} className="card p-3 flex items-center gap-3 flex-wrap">
          <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>
            {lang === 'vi' ? 'NHÁP' : 'DRAFT'}
          </span>
          <span className="text-sm text-navy flex-1 min-w-0">
            {imp.type === 'daily' ? (lang === 'vi' ? 'Đơn chính' : 'Main order') : (lang === 'vi' ? 'Đơn khẩn' : 'Urgent')} #{imp.order_number}
            {imp.control_report?.auto && (
              <span className="ml-2 text-xs text-ink-light">· {lang === 'vi' ? 'Tự động từ Odoo' : 'Auto from Odoo'}</span>
            )}
          </span>
          <button onClick={() => publish(imp.id)} disabled={publishing === imp.id}
            className="btn-primary text-sm py-2 px-4 flex items-center gap-2 shrink-0">
            <Send size={14} />
            {publishing === imp.id ? '…' : (lang === 'vi' ? 'Phát hành' : 'Publish')}
          </button>
          {/* Which client orders are in this draft (all new — drafts never contain modifications) */}
          {(() => {
            const refs = Array.from(new Set(
              orderLines.filter((l: any) => l.import_id === imp.id).map((l: any) => l.order_ref).filter(Boolean)
            ));
            if (!refs.length) return null;
            return (
              <div className="w-full flex flex-wrap gap-1.5 mt-1">
                <span className="text-[10px] text-ink-light uppercase tracking-wider mr-1 self-center">
                  {lang === 'vi' ? 'Đơn mới' : 'New orders'}:
                </span>
                {refs.map((r: any) => (
                  <span key={r} className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>{r}</span>
                ))}
              </div>
            );
          })()}
        </div>
      ))}

      {/* Published imports — who published (traceability) */}
      {canManage && published.map(imp => (
        <div key={imp.id} className="flex items-center gap-2 text-xs px-1" style={{ color: '#16A34A' }}>
          <CheckCircle2 size={13} className="shrink-0" />
          <span>
            {imp.type === 'daily' ? (lang === 'vi' ? 'Đơn chính' : 'Main order') : (lang === 'vi' ? 'Đơn khẩn' : 'Urgent')} #{imp.order_number} · {lang === 'vi' ? 'Đã phát hành' : 'Publié'}
            {imp.published_by_name ? <> · {lang === 'vi' ? 'bởi' : 'par'} <span className="font-semibold">{imp.published_by_name}</span></> : null}
          </span>
        </div>
      ))}

      {/* Missing production cards — fiches added after publish */}
      {canManage && missingCardsCount > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#93C5FD' }}>
          <div className="p-3 flex items-center gap-3 flex-wrap" style={{ backgroundColor: '#EFF6FF' }}>
            <AlertCircle size={16} className="shrink-0" style={{ color: '#2563EB' }} />
            <span className="text-sm flex-1 min-w-0" style={{ color: '#1E40AF' }}>
              {missingCardsCount} {lang === 'vi'
                ? 'sản phẩm đã có phiếu nhưng chưa có thẻ sản xuất'
                : 'products now have a recipe card but no production card'}
            </span>
            <button onClick={generateMissing} disabled={generating}
              className="text-sm py-2 px-4 rounded-xl font-bold text-white flex items-center gap-2 shrink-0"
              style={{ backgroundColor: '#2563EB' }}>
              <FilePlus size={14} />
              {generating ? '…' : (lang === 'vi' ? 'Tạo thẻ còn thiếu' : 'Generate missing cards')}
            </button>
          </div>
          {missingCards.length > 0 && (
            <div className="divide-y bg-white" style={{ borderColor: '#DBEAFE' }}>
              {missingCards.map((p, i) => {
                const meta = TEAM_LABELS[p.team as Team];
                return (
                  <div key={i} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                    <span className="flex-1 truncate text-navy">{p.name}</span>
                    {meta && <span className="text-[10px] font-semibold" style={{ color: meta.color }}>{lang === 'vi' ? meta.vi : meta.en}</span>}
                    <span className="text-xs font-bold text-navy shrink-0">×{p.qty}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* All published */}
      {canManage && !drafts.length && published.length > 0 && missingCardsCount === 0 && (
        <div className="flex items-center gap-2 text-sm px-1" style={{ color: '#16A34A' }}>
          <CheckCircle2 size={15} />
          {lang === 'vi' ? 'Tất cả đã phát hành' : 'All published'}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
          <AlertCircle size={14} className="shrink-0 mt-0.5" /><span>{error}</span>
        </div>
      )}
    </div>
  );
}
