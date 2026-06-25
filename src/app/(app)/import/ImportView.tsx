'use client';
import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, X, ChevronDown, ChevronUp, FilePlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { parseExcelFile, consolidateLines, type ConsolidatedLine } from '@/lib/excel-parser';
import { TEAM_LABELS, TEAMS, type Team } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';
import { createFicheFromSku } from './actions';

type Step = 'upload' | 'preview' | 'saving' | 'done';

interface ParsedImport {
  sourceType: 'sales_order' | 'replenishment';
  filename: string;
  lines: ConsolidatedLine[];
  warnings: string[];
}

/** Merge consolidated lines from multiple files: same SKU+variant+team → sum qty, merge breakdown */
function mergeLines(groups: ConsolidatedLine[][]): ConsolidatedLine[] {
  const map = new Map<string, ConsolidatedLine>();
  for (const group of groups) {
    for (const line of group) {
      const key = `${line.team}||${line.product_sku}||${line.variant_label}`;
      const existing = map.get(key);
      if (existing) {
        map.set(key, {
          ...existing,
          total_qty: existing.total_qty + line.total_qty,
          breakdown: [...existing.breakdown, ...line.breakdown],
        });
      } else {
        map.set(key, { ...line });
      }
    }
  }
  return Array.from(map.values());
}

export default function ImportView() {
  const { lang } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [parsedFiles, setParsedFiles] = useState<ParsedImport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().split('T')[0]);
  const [importType, setImportType] = useState<'daily' | 'cake_addon'>('daily');
  const [shippedFromLab, setShippedFromLab] = useState(false);
  const [notes, setNotes] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set(TEAMS));
  const [matchCheck, setMatchCheck] = useState<{ matched: number; unmatched: Array<{ sku: string; name: string }> } | null>(null);
  const [excludedSkus, setExcludedSkus] = useState<Set<string>>(new Set());
  const [orderTimes, setOrderTimes] = useState<Record<string, string>>({});
  const [creatingFicheSku, setCreatingFicheSku] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // All merged + consolidated lines across all uploaded files
  const mergedLines = mergeLines(parsedFiles.map(pf => pf.lines));
  const allWarnings = parsedFiles.flatMap(pf => pf.warnings);
  // Lines that will actually be published (user-excluded SKUs removed)
  const effectiveLines = mergedLines.filter(l => !excludedSkus.has(l.product_sku));
  const totalItems = effectiveLines.reduce((sum, l) => sum + l.total_qty, 0);

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null);
    setExcludedSkus(new Set());
    setMatchCheck(null);

    // First pass: parse all files to get raw lines
    type RawResult = { sourceType: 'sales_order' | 'replenishment'; filename: string; rawLines: any[]; warnings: string[] };
    const parseRaw: RawResult[] = [];
    for (const file of files) {
      try {
        const result = await parseExcelFile(file);
        if (result.errors.length && !result.lines.length) {
          setError(`${file.name}: ${result.errors[0]}`);
          return;
        }
        parseRaw.push({ sourceType: result.source_type, filename: file.name, rawLines: result.lines, warnings: result.errors });
      } catch (e: any) {
        setError(`${file.name}: ${e.message ?? 'Parse error'}`);
        return;
      }
    }
    if (!parseRaw.length) return;

    // Look up lab_fiche_variants to get actual variant labels per SKU
    const allRawSkus = Array.from(new Set(parseRaw.flatMap(r => r.rawLines.map((l: any) => l.product_sku)).filter(Boolean))) as string[];
    const variantLabelMap: Record<string, string> = {};
    if (allRawSkus.length) {
      const supabase = createClient();
      const { data: variantRows } = await supabase
        .from('lab_fiche_variants')
        .select('sku, label')
        .in('sku', allRawSkus);
      for (const v of variantRows ?? []) {
        if (v.sku) variantLabelMap[v.sku] = v.label;
      }
    }

    // Patch variant_label on each raw line, then consolidate
    const results: ParsedImport[] = parseRaw.map(r => ({
      sourceType: r.sourceType,
      filename: r.filename,
      warnings: r.warnings,
      lines: consolidateLines(
        r.rawLines.map((l: any) => ({
          ...l,
          variant_label: variantLabelMap[l.product_sku] ?? l.variant_label,
        }))
      ),
    }));

    setParsedFiles(results);
    setStep('preview');

    // Match check: SKUs must be in products OR lab_fiche_variants to be considered "matched"
    if (allRawSkus.length) {
      const supabase = createClient();
      const allLines = mergeLines(results.map(r => r.lines));
      Promise.all([
        supabase.from('products').select('sku').in('sku', allRawSkus),
        supabase.from('lab_fiche_variants').select('sku').in('sku', allRawSkus),
      ]).then(([{ data: prodData }, { data: varData }]) => {
        const matched = new Set([...(prodData ?? []), ...(varData ?? [])].map((p: any) => p.sku));
        setMatchCheck({
          matched: allRawSkus.filter(s => matched.has(s)).length,
          unmatched: allRawSkus
            .filter(s => !matched.has(s))
            .map(s => ({
              sku: s,
              name: allLines.find(l => l.product_sku === s)?.product_name_vi ?? s,
            })),
        });
      });
    }
  }, []);

  const toggleExclude = (sku: string) => {
    setExcludedSkus(prev => {
      const next = new Set(prev);
      next.has(sku) ? next.delete(sku) : next.add(sku);
      return next;
    });
  };

  const handleCreateFiche = async (sku: string, name: string) => {
    setCreatingFicheSku(sku);
    const { ficheId, error } = await createFicheFromSku(sku, name);
    if (error || !ficheId) {
      setCreatingFicheSku(null);
      setError(error ?? 'Failed to create fiche');
      return;
    }
    router.push(`/admin/fiches/${ficheId}`);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.xlsx') || f.name.endsWith('.xls'));
    if (files.length) handleFiles(files);
  }, [handleFiles]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) handleFiles(files);
  };

  async function publish(asDraft: boolean) {
    if (!parsedFiles.length) return;
    setStep('saving');
    const supabase = createClient();

    // Look up products by SKU to enrich assignments with image_url + product_id
    const skus = Array.from(new Set(effectiveLines.map(l => l.product_sku).filter(Boolean)));
    const { data: productRows } = skus.length
      ? await supabase.from('products').select('id, sku, main_image_url, name_en').in('sku', skus)
      : { data: [] };
    const productBySku: Record<string, { id: string; image_url: string | null; name_en: string | null }> = {};
    for (const p of productRows ?? []) {
      if (p.sku) productBySku[p.sku] = { id: p.id, image_url: p.main_image_url ?? null, name_en: p.name_en ?? null };
    }

    // Get next order number for this date
    const { count } = await supabase
      .from('lab_imports')
      .select('*', { count: 'exact', head: true })
      .eq('delivery_date', deliveryDate);

    const orderNumber = (count ?? 0) + 1;

    // Determine filenames
    const salesFile = parsedFiles.find(pf => pf.sourceType === 'sales_order');
    const replFile  = parsedFiles.find(pf => pf.sourceType === 'replenishment');

    const { data: importRow, error: importErr } = await supabase
      .from('lab_imports')
      .insert({
        delivery_date: deliveryDate,
        order_number: orderNumber,
        type: importType,
        shipped_from_lab: shippedFromLab,
        notes,
        status: asDraft ? 'draft' : 'published',
        filename_sales: salesFile?.filename ?? null,
        filename_repl: replFile?.filename ?? null,
        published_at: asDraft ? null : new Date().toISOString(),
      })
      .select('id')
      .single();

    if (importErr || !importRow) {
      setError(importErr?.message ?? 'Failed to create import');
      setStep('preview');
      return;
    }

    // Insert assignments — only lines with a valid team (CHECK constraint on lab_assignments)
    // Lines with unrecognised/empty team are kept in lab_order_lines only (for traceability)
    const assignableLines = effectiveLines.filter(l => (TEAMS as string[]).includes(l.team));
    const assignments = assignableLines.map((line, idx) => {
      const product = productBySku[line.product_sku] ?? null;
      return {
        import_id: importRow.id,
        team: line.team,
        product_id: product?.id ?? null,
        product_name_vi: line.product_name_vi,
        product_name_en: product?.name_en ?? '',
        image_url: product?.image_url ?? null,
        variant_label: line.variant_label,
        total_qty: line.total_qty,
        qty_to_produce: line.total_qty,
        qty_produced: 0,
        status: 'pending',
        sort_order: idx,
        breakdown: line.breakdown ?? [],
      };
    });

    const { error: assignErr } = await supabase.from('lab_assignments').insert(assignments);
    if (assignErr) {
      setError(assignErr.message);
      await supabase.from('lab_imports').delete().eq('id', importRow.id);
      setStep('preview');
      return;
    }

    // Insert raw order lines for traceability (also filtered by excludedSkus)
    const orderLines = parsedFiles.flatMap(pf =>
      pf.lines
        .filter(line => !excludedSkus.has(line.product_sku))
        .flatMap(line =>
          line.breakdown.map(b => ({
            import_id: importRow.id,
            source_type: pf.sourceType,
            order_ref: b.order_ref,
            shop_name: b.shop_name,
            product_sku: line.product_sku,
            product_name_vi: line.product_name_vi,
            team: line.team,
            variant_label: line.variant_label,
            qty: b.qty,
            delivery_date: deliveryDate,
            delivery_time: orderTimes[b.order_ref] || null,
          }))
        )
    );
    if (orderLines.length > 0) {
      await supabase.from('lab_order_lines').insert(orderLines);
    }

    setStep('done');
  }

  function reset() {
    setStep('upload');
    setParsedFiles([]);
    setError(null);
    setMatchCheck(null);
    setExcludedSkus(new Set());
    setOrderTimes({});
    if (fileRef.current) fileRef.current.value = '';
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
    lines: mergedLines.filter(l => l.team === team && !excludedSkus.has(l.product_sku)),
  })).filter(g => g.lines.length > 0);

  const unknownTeamLines = mergedLines.filter(l => !TEAMS.includes(l.team as Team));
  const emptyTeamLines = unknownTeamLines.filter(l => l.team === '' || l.team == null);
  const otherUnknownTeamLines = unknownTeamLines.filter(l => l.team !== '' && l.team != null);

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
          <button onClick={reset} className="btn-secondary">
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
          {lang === 'vi' ? 'Tải file Excel từ Odoo để tạo đơn sản xuất' : 'Upload Odoo Excel files to create production orders'}
        </p>
      </div>

      {/* Options */}
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

      {/* Upload zone */}
      {step === 'upload' && (
        <div className="space-y-4">
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`card border-2 border-dashed cursor-pointer transition-colors p-14 text-center
              ${dragging ? 'border-gold bg-gold/5' : 'border-border-soft hover:border-gold/50 hover:bg-cream/80'}`}
          >
            <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={onFileChange} className="hidden" />
            <FileSpreadsheet size={40} className={`mx-auto mb-3 ${dragging ? 'text-gold' : 'text-ink-light'}`} />
            <p className="font-medium text-navy">
              {lang === 'vi' ? 'Kéo file Excel vào đây' : 'Drop Excel files here'}
            </p>
            <p className="text-sm text-ink-light mt-1">
              {lang === 'vi' ? 'hoặc click để chọn file (có thể chọn nhiều file cùng lúc)' : 'or click to browse — multiple files supported'}
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

      {/* Preview */}
      {(step === 'preview' || step === 'saving') && parsedFiles.length > 0 && (
        <div className="space-y-4">
          {/* File chips */}
          <div className="flex flex-wrap gap-2">
            {parsedFiles.map((pf, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-cream border border-border-soft text-sm">
                <FileSpreadsheet size={14} className="text-navy" />
                <span className="font-medium text-navy">{pf.filename}</span>
                <span className="text-xs text-ink-light">
                  ({pf.sourceType === 'sales_order'
                    ? (lang === 'vi' ? 'Đơn bán' : 'Sales')
                    : (lang === 'vi' ? 'Bổ sung' : 'Repl.')})
                </span>
                <button onClick={() => {
                  const next = parsedFiles.filter((_, j) => j !== i);
                  if (next.length === 0) reset();
                  else setParsedFiles(next);
                }} className="text-ink-light hover:text-red-500 transition-colors">
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-gold/50 text-gold text-sm hover:bg-gold/5 transition-colors"
            >
              <Upload size={13} /> {lang === 'vi' ? 'Thêm file' : 'Add file'}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" multiple onChange={e => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) handleFiles([...parsedFiles.map(pf => new File([], pf.filename)), ...files].slice(parsedFiles.length));
              if (fileRef.current) fileRef.current.value = '';
            }} className="hidden" />
          </div>

          {/* Summary */}
          <div className="card p-4 flex items-center gap-4 flex-wrap">
            <div className="text-sm text-ink-light">
              <span className="font-semibold text-navy">{effectiveLines.length}</span> {lang === 'vi' ? 'sản phẩm' : 'products'}
              {' · '}
              <span className="font-semibold text-navy">{totalItems}</span> {lang === 'vi' ? 'cái tổng cộng' : 'items total'}
              {parsedFiles.length > 1 && (
                <span className="ml-2 text-gold font-medium">({parsedFiles.length} {lang === 'vi' ? 'file đã gộp' : 'files merged'})</span>
              )}
              {excludedSkus.size > 0 && (
                <span className="ml-2 text-red-500 font-medium">
                  · {excludedSkus.size} SKU{excludedSkus.size > 1 ? 's' : ''} {lang === 'vi' ? 'bị loại' : 'excluded'}
                </span>
              )}
            </div>
          </div>

          {/* Parse warnings (format issues from excel parser) */}
          {allWarnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200">
              <div className="flex items-center gap-2 text-amber-700 font-medium text-sm mb-1">
                <AlertCircle size={15} /> {lang === 'vi' ? 'Cảnh báo' : 'Warnings'}
              </div>
              <ul className="text-xs text-amber-700 space-y-0.5">
                {allWarnings.map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
            </div>
          )}

          {/* Unrecognized products — per-SKU Exclude / Keep toggles */}
          {matchCheck && matchCheck.unmatched.length > 0 && (
            <div className="rounded-xl border border-amber-200 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-amber-50 text-amber-700 font-medium text-sm">
                <AlertCircle size={15} />
                <span>
                  {matchCheck.unmatched.length}{' '}
                  {lang === 'vi' ? 'sản phẩm không có trong catalogue' : 'products not found in catalogue'}
                </span>
                {matchCheck.matched > 0 && (
                  <span className="ml-auto text-amber-600 font-normal text-xs">
                    {matchCheck.matched} {lang === 'vi' ? 'SKU khớp' : 'SKUs matched'}
                  </span>
                )}
              </div>
              <div className="divide-y divide-amber-100 bg-white">
                {matchCheck.unmatched.map(({ sku, name }) => {
                  const isExcluded = excludedSkus.has(sku);
                  const isCreating = creatingFicheSku === sku;
                  return (
                    <div key={sku} className={`flex items-center gap-2 px-4 py-2.5 transition-colors ${isExcluded ? 'opacity-50' : ''}`}>
                      <code className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 text-amber-800 shrink-0">{sku}</code>
                      <span className={`flex-1 text-sm min-w-0 truncate ${isExcluded ? 'line-through text-ink-light' : 'text-navy'}`}>{name}</span>
                      {!isExcluded && (
                        <button
                          onClick={() => handleCreateFiche(sku, name)}
                          disabled={isCreating || !!creatingFicheSku}
                          className="text-xs font-semibold px-3 py-1 rounded-full transition-colors shrink-0 bg-navy/10 text-navy hover:bg-navy/20 disabled:opacity-50 flex items-center gap-1"
                        >
                          <FilePlus size={11} />
                          {isCreating
                            ? '…'
                            : (lang === 'vi' ? 'Tạo phiếu' : 'Create fiche')}
                        </button>
                      )}
                      <button
                        onClick={() => toggleExclude(sku)}
                        className={`text-xs font-semibold px-3 py-1 rounded-full transition-colors shrink-0 ${
                          isExcluded
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-red-100 text-red-700 hover:bg-red-200'
                        }`}
                      >
                        {isExcluded
                          ? (lang === 'vi' ? 'Giữ lại' : 'Keep')
                          : (lang === 'vi' ? 'Loại bỏ' : 'Exclude')}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="px-4 py-2 bg-amber-50 text-xs text-amber-600">
                {lang === 'vi'
                  ? 'Tạo phiếu kỹ thuật trước hoặc giữ lại để nhập bình thường (không có ảnh hay phiếu).'
                  : 'Create a recipe card first, or keep to import normally (without photo or recipe card).'}
              </div>
            </div>
          )}

          {/* Empty team — kept in order history but not assigned to production */}
          {emptyTeamLines.length > 0 && (
            <div className="p-3 rounded-xl bg-blue-50 border border-blue-200">
              <div className="flex items-center gap-2 text-blue-700 text-sm">
                <AlertCircle size={15} className="shrink-0" />
                <span>
                  <span className="font-medium">
                    {emptyTeamLines.length} {lang === 'vi' ? 'dòng không có đội' : 'lines with no team assigned'}
                  </span>
                  {' — '}
                  {lang === 'vi'
                    ? 'sẽ được lưu vào lịch sử đơn hàng nhưng không giao cho đội nào.'
                    : 'saved to order history but not assigned to any production team.'}
                </span>
              </div>
            </div>
          )}

          {/* Other unrecognized teams (non-empty string, not in TEAMS list) */}
          {otherUnknownTeamLines.length > 0 && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200">
              <div className="flex items-center gap-2 text-red-700 font-medium text-sm mb-1">
                <AlertCircle size={15} /> {lang === 'vi' ? 'Đội chưa nhận dạng được' : 'Unrecognised teams'}
              </div>
              <ul className="text-xs text-red-700 space-y-0.5">
                {Array.from(new Set(otherUnknownTeamLines.map(l => l.team))).map(t => <li key={t}>· "{t}"</li>)}
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

          {/* Delivery time per order */}
          {(() => {
            const orderRefs = Array.from(new Set(
              mergedLines.flatMap(l => l.breakdown.map((b: any) => b.order_ref as string)).filter(Boolean)
            ));
            if (orderRefs.length === 0) return null;
            return (
              <div>
                <label className="label">
                  {lang === 'vi' ? 'Giờ cần xong theo đơn' : 'Ready time per order'}{' '}
                  <span className="font-normal text-ink-light">(optional)</span>
                </label>
                <div className="mt-2 card p-3 space-y-2">
                  {orderRefs.map(ref => (
                    <div key={ref} className="flex items-center gap-3">
                      <span className="text-sm font-mono font-medium text-navy w-40 truncate shrink-0">{ref}</span>
                      <input
                        type="time"
                        value={orderTimes[ref] ?? ''}
                        onChange={e => setOrderTimes(prev => ({ ...prev, [ref]: e.target.value }))}
                        className="input py-1 text-sm w-32"
                      />
                      {orderTimes[ref] && (
                        <button
                          onClick={() => setOrderTimes(prev => { const next = { ...prev }; delete next[ref]; return next; })}
                          className="text-ink-light hover:text-red-500 transition-colors"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* By team — excluded-SKU lines are hidden */}
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
            <button onClick={reset} disabled={step === 'saving'} className="btn-secondary">
              {lang === 'vi' ? 'Quay lại' : 'Back'}
            </button>
            <button onClick={() => publish(true)} disabled={step === 'saving'} className="btn-secondary">
              {step === 'saving' ? '…' : (lang === 'vi' ? 'Lưu nháp' : 'Save as draft')}
            </button>
            <button onClick={() => publish(false)} disabled={step === 'saving'} className="btn-primary">
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
