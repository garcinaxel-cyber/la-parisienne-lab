'use client';
import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { parseExcelFile, consolidateLines, type ConsolidatedLine } from '@/lib/excel-parser';
import { TEAM_LABELS, TEAMS, type Team } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';

type Step = 'upload' | 'preview' | 'saving' | 'done';

interface ParsedImport {
  sourceType: 'sales_order' | 'replenishment';
  filename: string;
  lines: ConsolidatedLine[];
  warnings: string[];
}

export default function ImportView() {
  const { lang } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().split('T')[0]);
  const [importType, setImportType] = useState<'daily' | 'cake_addon'>('daily');
  const [shippedFromLab, setShippedFromLab] = useState(false);
  const [notes, setNotes] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set(TEAMS));
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const result = await parseExcelFile(file);
      if (result.errors.length && !result.lines.length) {
        setError(result.errors[0]);
        return;
      }
      const lines = consolidateLines(result.lines);
      setParsed({
        sourceType: result.source_type,
        filename: file.name,
        lines,
        warnings: result.errors,
      });
      setStep('preview');
    } catch (e: any) {
      setError(e.message ?? 'Parse error');
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  async function publish(asDraft: boolean) {
    if (!parsed) return;
    setStep('saving');
    const supabase = createClient();

    // Get next order number for this date
    const { count } = await supabase
      .from('lab_imports')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_date', deliveryDate);

    const orderNumber = (count ?? 0) + 1;

    const { data: importRow, error: importErr } = await supabase
      .from('lab_imports')
      .insert({
        delivery_date: deliveryDate,
        order_number: orderNumber,
        type: importType,
        shipped_from_lab: shippedFromLab,
        notes,
        status: asDraft ? 'draft' : 'published',
        filename_sales: parsed.sourceType === 'sales_order' ? parsed.filename : null,
        filename_repl: parsed.sourceType === 'replenishment' ? parsed.filename : null,
        published_at: asDraft ? null : new Date().toISOString(),
      })
      .select('id')
      .single();

    if (importErr || !importRow) {
      setError(importErr?.message ?? 'Failed to create import');
      setStep('preview');
      return;
    }

    // Insert consolidated lines as assignments
    const assignments = parsed.lines.map((line, idx) => ({
      import_id: importRow.id,
      team: line.team,
      product_name_vi: line.product_name_vi,
      product_name_en: '',
      image_url: null,
      variant_label: line.variant_label,
      total_qty: line.total_qty,
      qty_to_produce: line.total_qty,
      qty_produced: 0,
      status: 'pending',
      sort_order: idx,
    }));

    const { error: assignErr } = await supabase.from('lab_assignments').insert(assignments);

    if (assignErr) {
      setError(assignErr.message);
      await supabase.from('lab_imports').delete().eq('id', importRow.id);
      setStep('preview');
      return;
    }

    // Insert raw order lines for traceability
    const orderLines = parsed.lines.flatMap(line =>
      line.breakdown.map(b => ({
        import_id: importRow.id,
        source_type: parsed.sourceType,
        order_ref: b.order_ref,
        shop_name: b.shop_name,
        product_sku: line.product_sku,
        product_name_vi: line.product_name_vi,
        team: line.team,
        variant_label: line.variant_label,
        qty: b.qty,
        delivery_date: deliveryDate,
        delivery_time: null,
      }))
    );
    if (orderLines.length > 0) {
      await supabase.from('lab_order_lines').insert(orderLines);
    }

    setStep('done');
  }

  const toggleTeam = (team: string) => {
    setExpandedTeams(prev => {
      const next = new Set(prev);
      next.has(team) ? next.delete(team) : next.add(team);
      return next;
    });
  };

  const byTeam = TEAMS.map(team => ({
    team,
    lines: parsed?.lines.filter(l => l.team === team) ?? [],
  })).filter(g => g.lines.length > 0);

  // Lines with unknown teams
  const unknownTeamLines = parsed?.lines.filter(l => !TEAMS.includes(l.team as Team)) ?? [];

  const totalItems = parsed?.lines.reduce((sum, l) => sum + l.total_qty, 0) ?? 0;

  if (step === 'done') {
    return (
      <div className="max-w-lg mx-auto mt-16 card p-10 text-center space-y-4">
        <CheckCircle2 size={48} className="mx-auto text-green-500" />
        <h2 className="font-serif text-2xl font-bold text-navy">
          {lang === 'vi' ? 'Nhập thành công!' : 'Import successful!'}
        </h2>
        <p className="text-ink-light text-sm">
          {lang === 'vi'
            ? `${totalItems} sản phẩm đã được phân phối cho các đội`
            : `${totalItems} items dispatched to production teams`}
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <button onClick={() => router.push(`/orders/${deliveryDate}`)} className="btn-primary">
            {lang === 'vi' ? 'Xem đơn hàng' : 'View order'}
          </button>
          <button onClick={() => { setStep('upload'); setParsed(null); setError(null); }} className="btn-secondary">
            {lang === 'vi' ? 'Nhập thêm' : 'Import another'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl font-bold text-navy">
          {lang === 'vi' ? 'Nhập đơn hàng' : 'Import orders'}
        </h1>
        <p className="text-ink-light text-sm mt-1">
          {lang === 'vi' ? 'Tải file Excel từ Odoo để tạo đơn sản xuất' : 'Upload Odoo Excel file to create production orders'}
        </p>
      </div>

      {/* Step 1: Options + upload */}
      {step === 'upload' && (
        <div className="space-y-4">
          <div className="card p-4 flex flex-wrap gap-4">
            <div className="flex-1 min-w-40">
              <label className="label">{lang === 'vi' ? 'Ngày giao hàng' : 'Delivery date'}</label>
              <input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)}
                className="input mt-1 w-full" />
            </div>
            <div className="flex-1 min-w-40">
              <label className="label">{lang === 'vi' ? 'Loại đơn' : 'Order type'}</label>
              <select value={importType} onChange={e => setImportType(e.target.value as any)} className="input mt-1 w-full">
                <option value="daily">{lang === 'vi' ? 'Đơn chính (sáng)' : 'Main order (morning)'}</option>
                <option value="cake_addon">{lang === 'vi' ? 'Đơn bánh khẩn' : 'Urgent cake order'}</option>
              </select>
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input type="checkbox" checked={shippedFromLab} onChange={e => setShippedFromLab(e.target.checked)}
                  className="rounded" />
                <span className="text-sm text-ink">{lang === 'vi' ? 'Giao từ lab' : 'Ships from lab'}</span>
              </label>
            </div>
          </div>

          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`card border-2 border-dashed cursor-pointer transition-colors p-16 text-center
              ${dragging ? 'border-gold bg-gold/5' : 'border-border-soft hover:border-gold/50 hover:bg-cream/80'}`}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={onFileChange} className="hidden" />
            <FileSpreadsheet size={40} className={`mx-auto mb-3 ${dragging ? 'text-gold' : 'text-ink-light'}`} />
            <p className="font-medium text-navy">
              {lang === 'vi' ? 'Kéo file Excel vào đây' : 'Drop Excel file here'}
            </p>
            <p className="text-sm text-ink-light mt-1">
              {lang === 'vi' ? 'hoặc click để chọn file' : 'or click to browse'}
            </p>
            <p className="text-xs text-ink-light mt-3">Sales Order · Stock Replenishment (.xlsx)</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Preview */}
      {(step === 'preview' || step === 'saving') && parsed && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <FileSpreadsheet size={20} className="text-navy" />
              <div>
                <div className="font-medium text-navy text-sm">{parsed.filename}</div>
                <div className="text-xs text-ink-light">
                  {parsed.sourceType === 'sales_order'
                    ? (lang === 'vi' ? 'Đơn bán hàng' : 'Sales Order')
                    : (lang === 'vi' ? 'Bổ sung kho' : 'Stock Replenishment')}
                  {' · '}
                  {parsed.lines.length} {lang === 'vi' ? 'sản phẩm' : 'products'}
                  {' · '}
                  {totalItems} {lang === 'vi' ? 'cái' : 'items'}
                </div>
              </div>
            </div>
            <button onClick={() => { setStep('upload'); setParsed(null); }}
              className="text-ink-light hover:text-ink transition-colors p-1">
              <X size={18} />
            </button>
          </div>

          {/* Warnings */}
          {parsed.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
              <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-1">
                <AlertCircle size={15} /> {lang === 'vi' ? 'Cảnh báo' : 'Warnings'}
              </div>
              <ul className="text-xs text-amber-700 space-y-0.5">
                {parsed.warnings.map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
            </div>
          )}

          {/* Unknown teams warning */}
          {unknownTeamLines.length > 0 && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 text-red-700 font-medium text-sm mb-1">
                <AlertCircle size={15} /> {lang === 'vi' ? 'Đội chưa nhận dạng được' : 'Unrecognised teams'}
              </div>
              <ul className="text-xs text-red-700 space-y-0.5">
                {Array.from(new Set(unknownTeamLines.map(l => l.team))).map(t => <li key={t}>· "{t}"</li>)}
              </ul>
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="label">
              {lang === 'vi' ? 'Ghi chú' : 'Notes'}{' '}
              <span className="font-normal text-ink-light">(optional)</span>
            </label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              placeholder={lang === 'vi' ? 'VD: Đơn khẩn cho Landmark...' : 'E.g. Urgent Landmark order...'}
              className="input mt-1 w-full resize-none" />
          </div>

          {/* By team */}
          <div className="space-y-3">
            {byTeam.map(({ team, lines }) => {
              const meta = TEAM_LABELS[team as Team];
              const expanded = expandedTeams.has(team);
              const teamTotal = lines.reduce((s, l) => s + l.total_qty, 0);
              return (
                <div key={team} className="card overflow-hidden">
                  <button
                    onClick={() => toggleTeam(team)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-cream/50 transition-colors"
                    style={{ borderLeft: `4px solid ${meta.color}` }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-sm" style={{ color: meta.color }}>
                        {lang === 'vi' ? meta.vi : meta.en}
                      </span>
                      <span className="text-xs text-ink-light">
                        {lines.length} {lang === 'vi' ? 'sản phẩm' : 'products'} · {teamTotal} {lang === 'vi' ? 'cái' : 'items'}
                      </span>
                    </div>
                    {expanded ? <ChevronUp size={16} className="text-ink-light" /> : <ChevronDown size={16} className="text-ink-light" />}
                  </button>

                  {expanded && (
                    <div className="divide-y divide-border-soft">
                      <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50">
                        <div className="col-span-2">SKU</div>
                        <div className="col-span-5">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
                        <div className="col-span-2">{lang === 'vi' ? 'Biến thể' : 'Variant'}</div>
                        <div className="col-span-1 text-center">{lang === 'vi' ? 'SL' : 'Qty'}</div>
                        <div className="col-span-2">{lang === 'vi' ? 'Từ đâu' : 'From'}</div>
                      </div>
                      {lines.map((line, i) => (
                        <div key={i} className="grid grid-cols-12 px-4 py-2.5 items-center text-sm">
                          <div className="col-span-2 text-[10px] text-ink-light font-mono truncate">{line.product_sku}</div>
                          <div className="col-span-5">
                            <div className="font-medium text-navy truncate">{line.product_name_vi}</div>
                          </div>
                          <div className="col-span-2 text-xs text-ink-light">
                            {line.variant_label !== 'Standard' ? line.variant_label : '–'}
                          </div>
                          <div className="col-span-1 text-center font-bold text-navy">×{line.total_qty}</div>
                          <div className="col-span-2">
                            {line.breakdown.length === 1 ? (
                              <span className="text-xs text-ink-light truncate block">{line.breakdown[0].shop_name}</span>
                            ) : (
                              <div className="text-xs text-ink-light space-y-0.5">
                                {line.breakdown.map((b, j) => (
                                  <div key={j}>{b.shop_name}: ×{b.qty}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 justify-end pt-2">
            <button onClick={() => { setStep('upload'); setParsed(null); }} disabled={step === 'saving'}
              className="btn-secondary">
              {lang === 'vi' ? 'Quay lại' : 'Back'}
            </button>
            <button onClick={() => publish(true)} disabled={step === 'saving'}
              className="btn-secondary">
              {step === 'saving' ? '…' : (lang === 'vi' ? 'Lưu nháp' : 'Save as draft')}
            </button>
            <button onClick={() => publish(false)} disabled={step === 'saving'}
              className="btn-primary">
              {step === 'saving'
                ? (lang === 'vi' ? 'Đang lưu…' : 'Saving…')
                : (lang === 'vi' ? 'Phát hành ngay' : 'Publish now')}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 text-red-700 text-sm">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
