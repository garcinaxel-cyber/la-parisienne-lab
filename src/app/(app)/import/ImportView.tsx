'use client';
import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileSpreadsheet, CheckCircle2, AlertCircle, X, ChevronDown, ChevronUp, FilePlus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { parseExcelFile, consolidateLines, type ConsolidatedLine, type SkippedLine } from '@/lib/excel-parser';
import { TEAM_LABELS, TEAMS, type Team } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';
import { createFicheFromSku } from './actions';

type Step = 'upload' | 'preview' | 'saving' | 'done';

interface ParsedImport {
  sourceType: 'sales_order' | 'replenishment';
  filename: string;
  lines: ConsolidatedLine[];
  skipped: SkippedLine[];
  warnings: string[];
}

/** Lab fiche variant matched by SKU — the ONLY product reference used (no B2C catalogue) */
interface VariantMatch {
  variant_id: string;
  fiche_id: string;
  label: string;
  image_url: string | null;
}

/** Merge consolidated lines from multiple files: same SKU+variant+team → sum qty, merge breakdown */
function mergeLines(groups: ConsolidatedLine[][]): ConsolidatedLine[] {
  const map = new Map<string, ConsolidatedLine>();
  for (const group of groups) {
    for (const line of group) {
      const key = `${line.team}||${line.product_sku}||${line.variant_label}||${line.delivery_date}`;
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
  const [importedDate, setImportedDate] = useState('');
  const [importType, setImportType] = useState<'daily' | 'cake_addon'>('daily');
  const [shippedFromLab, setShippedFromLab] = useState(false);
  const [notes, setNotes] = useState('');
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set(TEAMS));
  const [matchCheck, setMatchCheck] = useState<{ matched: number; unmatched: Array<{ sku: string; name: string }> } | null>(null);
  const [variantBySku, setVariantBySku] = useState<Record<string, VariantMatch>>({});
  const [excludedSkus, setExcludedSkus] = useState<Set<string>>(new Set());
  const [orderTimes, setOrderTimes] = useState<Record<string, string>>({});
  const [reportSection, setReportSection] = useState<'orders' | 'products' | null>(null);
  const [creatingFicheSku, setCreatingFicheSku] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Odoo status per order ref (draft/sent/sale, draft/submitted/approved) — from the sync
  const [odooStates, setOdooStates] = useState<Record<string, string>>({});
  // Orders modified/cancelled in Odoo AFTER being imported — detected by the sync
  type OdooChange = { order_ref: string; cancelled: boolean; items: { sku: string; name: string; old_qty: number; new_qty: number }[] };
  const [odooChanges, setOdooChanges] = useState<OdooChange[]>([]);
  const [applyingChanges, setApplyingChanges] = useState(false);
  const [changesApplied, setChangesApplied] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // All merged + consolidated lines across all uploaded files
  const mergedLines = mergeLines(parsedFiles.map(pf => pf.lines));
  const allWarnings = parsedFiles.flatMap(pf => pf.warnings);
  // Lines that will actually be published (user-excluded SKUs removed)
  const effectiveLines = mergedLines.filter(l => !excludedSkus.has(l.product_sku));
  const totalItems = effectiveLines.reduce((sum, l) => sum + l.total_qty, 0);

  type RawResult = { sourceType: 'sales_order' | 'replenishment'; filename: string; rawLines: any[]; skipped: SkippedLine[]; warnings: string[] };

  // Shared post-parse pipeline: fiche-variant lookup, consolidation, match check.
  // Used by both the Excel upload and the Odoo sync.
  const processRaw = useCallback(async (parseRaw: RawResult[]) => {
    if (!parseRaw.length) return;

    // Look up lab fiche variants by SKU — the only product reference (no B2C catalogue)
    const allRawSkus = Array.from(new Set(parseRaw.flatMap(r => r.rawLines.map((l: any) => l.product_sku)).filter(Boolean))) as string[];
    const vMap: Record<string, VariantMatch> = {};
    if (allRawSkus.length) {
      const supabase = createClient();
      const { data: variantRows } = await supabase
        .from('lab_fiche_variants')
        .select('id, sku, label, fiche_id, image_url')
        .in('sku', allRawSkus);
      for (const v of variantRows ?? []) {
        if (v.sku) vMap[v.sku] = { variant_id: v.id, fiche_id: v.fiche_id, label: v.label, image_url: v.image_url ?? null };
      }
    }
    setVariantBySku(vMap);

    // Patch variant_label on each raw line, then consolidate
    const results: ParsedImport[] = parseRaw.map(r => ({
      sourceType: r.sourceType,
      filename: r.filename,
      skipped: r.skipped,
      warnings: r.warnings,
      lines: consolidateLines(
        r.rawLines.map((l: any) => ({
          ...l,
          variant_label: vMap[l.product_sku]?.label ?? l.variant_label,
        }))
      ),
    }));

    setParsedFiles(results);
    setStep('preview');

    // Match check: a SKU is "matched" only if a lab fiche variant carries it
    if (allRawSkus.length) {
      const allLines = mergeLines(results.map(r => r.lines));
      setMatchCheck({
        matched: allRawSkus.filter(s => !!vMap[s]).length,
        unmatched: allRawSkus
          .filter(s => !vMap[s])
          .map(s => ({
            sku: s,
            name: allLines.find(l => l.product_sku === s)?.product_name_vi ?? s,
          })),
      });
    }
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    setError(null);
    setExcludedSkus(new Set());
    setMatchCheck(null);

    // First pass: parse all files to get raw lines
    const parseRaw: RawResult[] = [];
    for (const file of files) {
      try {
        const result = await parseExcelFile(file);
        if (result.errors.length && !result.lines.length) {
          setError(`${file.name}: ${result.errors[0]}`);
          return;
        }
        parseRaw.push({ sourceType: result.source_type, filename: file.name, rawLines: result.lines, skipped: result.skipped, warnings: result.errors });
      } catch (e: any) {
        setError(`${file.name}: ${e.message ?? 'Parse error'}`);
        return;
      }
    }
    await processRaw(parseRaw);
  }, [processRaw]);

  // ── Sync from Odoo (read-only API) — replaces the manual Excel export ──
  const syncFromOdoo = useCallback(async () => {
    setError(null);
    setExcludedSkus(new Set());
    setMatchCheck(null);
    setSyncing(true);
    try {
      const res = await fetch('/api/odoo/sync');
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Odoo sync failed (${res.status})`);
      const lines: any[] = j.lines ?? [];
      const stats = j.stats ?? {};
      setOdooStates(stats.order_states ?? {});
      setOdooChanges(j.changes ?? []);
      setChangesApplied(null);
      const unconfirmed = Object.values(stats.order_states ?? {}).filter(s => s !== 'sale' && s !== 'approved').length;
      const warnings: string[] = [];
      if (unconfirmed > 0) {
        warnings.push(`⚠ ${unconfirmed} ${lang === 'vi' ? 'đơn chưa được xác nhận trong Odoo (nháp/đã gửi) — kiểm tra trước khi phát hành' : 'orders not yet confirmed in Odoo (draft/submitted) — review before publishing'}`);
      }
      if ((stats.already_imported ?? []).length > 0) {
        warnings.push(`${stats.already_imported.length} ${lang === 'vi' ? 'đơn đã nhập trước đó — bỏ qua' : 'orders already imported — skipped'}: ${stats.already_imported.slice(0, 8).join(', ')}${stats.already_imported.length > 8 ? '…' : ''}`);
      }
      if ((stats.multi_team_skus ?? []).length > 0) {
        warnings.push(`${stats.multi_team_skus.length} ${lang === 'vi' ? 'SKU có nhiều đội — đã chọn đội mặc định của fiche' : 'SKUs have multiple teams — fiche default team applied'}`);
      }
      const stamp = new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const parseRaw: RawResult[] = [];
      const sales = lines.filter(l => l.source_type === 'sales_order');
      const repl = lines.filter(l => l.source_type === 'replenishment');
      if (sales.length) parseRaw.push({ sourceType: 'sales_order', filename: `Odoo Sales (${stamp})`, rawLines: sales, skipped: [], warnings });
      if (repl.length) parseRaw.push({ sourceType: 'replenishment', filename: `Odoo Replenishment (${stamp})`, rawLines: repl, skipped: [], warnings: sales.length ? [] : warnings });
      if (!parseRaw.length) {
        if (!(j.changes ?? []).length) {
          setError(lang === 'vi'
            ? `Không có đơn mới nào từ Odoo (${stats.sales_orders ?? 0} đơn bán, ${stats.replenishments ?? 0} bổ sung đã kiểm tra).`
            : `No new orders from Odoo (checked ${stats.sales_orders ?? 0} sales orders, ${stats.replenishments ?? 0} replenishments).`);
        }
        return;
      }
      await processRaw(parseRaw);
    } catch (e: any) {
      setError(e?.message ?? 'Odoo sync failed');
    } finally {
      setSyncing(false);
    }
  }, [processRaw, lang]);

  /** Apply Odoo modifications (qty changes / cancellations) to already-imported cards */
  const applyOdooChanges = async () => {
    if (!odooChanges.length) return;
    setApplyingChanges(true);
    try {
      const res = await fetch('/api/odoo/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: odooChanges }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Failed to apply changes');
      setChangesApplied(j.applied ?? []);
      setOdooChanges([]);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to apply changes');
    } finally {
      setApplyingChanges(false);
    }
  };

  /** Assign a team manually to all lines of a SKU (fiche has no team or several) */
  const assignTeam = (sku: string, team: string) => {
    setParsedFiles(prev => prev.map(pf => ({
      ...pf,
      lines: pf.lines.map(l => l.product_sku === sku ? { ...l, team } : l),
    })));
  };

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

    const today = new Date().toISOString().split('T')[0];
    const salesFile = parsedFiles.find(pf => pf.sourceType === 'sales_order');
    const replFile  = parsedFiles.find(pf => pf.sourceType === 'replenishment');

    // Enrich from lab fiches only (name_en + image with variant→fiche fallback). No B2C catalogue reads.
    const ficheIds = Array.from(new Set(
      effectiveLines.map(l => variantBySku[l.product_sku]?.fiche_id).filter(Boolean)
    )) as string[];
    const { data: ficheRows } = ficheIds.length
      ? await supabase.from('lab_fiche_meta').select('id, name_en, image_url').in('id', ficheIds)
      : { data: [] };
    const ficheById: Record<string, { name_en: string | null; image_url: string | null }> = {};
    for (const f of ficheRows ?? []) {
      ficheById[f.id] = { name_en: f.name_en ?? null, image_url: f.image_url ?? null };
    }

    // Control report — lets assistants verify the import against the Odoo Excel
    const allSkipped = parsedFiles.flatMap(pf => pf.skipped.map(s => ({ ...s, file: pf.filename })));
    const excludedLines = mergedLines.filter(l => excludedSkus.has(l.product_sku));
    const excelQty = mergedLines.reduce((s, l) => s + l.total_qty, 0) + allSkipped.reduce((s, l) => s + (l.qty || 0), 0);
    const orderRefsAll = Array.from(new Set(effectiveLines.flatMap(l => l.breakdown.map(b => b.order_ref)).filter(Boolean)));
    const controlReport = {
      totals: {
        excel_lines: mergedLines.length + allSkipped.length,
        excel_qty: excelQty,
        kept_lines: effectiveLines.length,
        kept_qty: totalItems,
        orders: orderRefsAll.length,
        skipped: allSkipped.length,
        excluded: excludedLines.length,
      },
      by_order: orderRefsAll.map(ref => {
        const items = effectiveLines.flatMap(l => l.breakdown.filter(b => b.order_ref === ref).map(b => b.qty));
        return { order_ref: ref, lines: items.length, qty: items.reduce((a, b) => a + b, 0) };
      }),
      skipped: allSkipped,
      excluded: excludedLines.map(l => ({ sku: l.product_sku, name: l.product_name_vi, qty: l.total_qty })),
      files: parsedFiles.map(pf => pf.filename),
      // Odoo status per order ref (filled when the import came from the Odoo sync)
      order_states: Object.keys(odooStates).length > 0 ? odooStates : undefined,
    };

    // Group assignable lines by delivery_date — one lab_imports record per date
    const assignableLines = effectiveLines.filter(l => (TEAMS as string[]).includes(l.team));
    const byDate = new Map<string, typeof assignableLines>();
    for (const line of assignableLines) {
      const date = line.delivery_date || today;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(line);
    }

    // Group raw order lines by delivery_date for traceability
    const orderLinesByDate = new Map<string, any[]>();
    for (const pf of parsedFiles) {
      for (const line of pf.lines) {
        if (excludedSkus.has(line.product_sku)) continue;
        const date = line.delivery_date || today;
        if (!orderLinesByDate.has(date)) orderLinesByDate.set(date, []);
        for (const b of line.breakdown) {
          orderLinesByDate.get(date)!.push({
            source_type: pf.sourceType,
            order_ref: b.order_ref,
            shop_name: b.shop_name,
            product_sku: line.product_sku,
            product_name_vi: line.product_name_vi,
            team: line.team,
            variant_label: line.variant_label,
            qty: b.qty,
            delivery_date: date,
            delivery_time: orderTimes[b.order_ref] || b.delivery_time || null,
          });
        }
      }
    }

    const allDates = Array.from(byDate.keys()).sort();
    const earliestDate = allDates[0] ?? today;
    let sortOffset = 0;

    // Create one lab_imports + assignments per delivery date
    for (const date of allDates) {
      const linesForDate = byDate.get(date)!;

      const { count } = await supabase
        .from('lab_imports')
        .select('*', { count: 'exact', head: true })
        .eq('delivery_date', date);
      const orderNumber = (count ?? 0) + 1;

      const { data: importRow, error: importErr } = await supabase
        .from('lab_imports')
        .insert({
          delivery_date: date,
          order_number: orderNumber,
          type: importType,
          shipped_from_lab: shippedFromLab,
          notes,
          status: asDraft ? 'draft' : 'published',
          filename_sales: salesFile?.filename ?? null,
          filename_repl: replFile?.filename ?? null,
          published_at: asDraft ? null : new Date().toISOString(),
          control_report: controlReport,
        })
        .select('id')
        .single();

      if (importErr || !importRow) {
        setError(importErr?.message ?? `Failed to create import for ${date}`);
        setStep('preview');
        return;
      }

      const assignments = linesForDate.map((line, idx) => {
        const variant = variantBySku[line.product_sku] ?? null;
        const fiche = variant ? ficheById[variant.fiche_id] ?? null : null;
        return {
          import_id: importRow.id,
          team: line.team,
          fiche_id: variant?.fiche_id ?? null,
          variant_id: variant?.variant_id ?? null,
          product_name_vi: line.product_name_vi,
          product_name_en: fiche?.name_en ?? '',
          image_url: variant?.image_url ?? fiche?.image_url ?? null,
          variant_label: line.variant_label,
          total_qty: line.total_qty,
          qty_to_produce: line.total_qty,
          qty_produced: 0,
          status: 'pending',
          sort_order: sortOffset + idx,
          breakdown: line.breakdown ?? [],
        };
      });
      sortOffset += linesForDate.length;

      const { error: assignErr } = await supabase.from('lab_assignments').insert(assignments);
      if (assignErr) {
        setError(assignErr.message);
        await supabase.from('lab_imports').delete().eq('id', importRow.id);
        setStep('preview');
        return;
      }

      // Insert raw order lines for this date (with fiche link when SKU is known)
      const olForDate = (orderLinesByDate.get(date) ?? []).map(ol => ({
        ...ol,
        import_id: importRow.id,
        fiche_id: variantBySku[ol.product_sku]?.fiche_id ?? null,
        variant_id: variantBySku[ol.product_sku]?.variant_id ?? null,
      }));
      if (olForDate.length > 0) {
        await supabase.from('lab_order_lines').insert(olForDate);
      }
    }

    setImportedDate(earliestDate);
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
          <button onClick={() => router.push(`/orders/${importedDate}`)} className="btn-primary">
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

      {/* Orders modified in Odoo after import — proposed updates */}
      {odooChanges.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#FCA5A5' }}>
          <div className="flex items-center gap-2 px-4 py-3 text-sm font-medium" style={{ backgroundColor: '#FEF2F2', color: '#B91C1C' }}>
            <AlertCircle size={16} />
            <span className="flex-1">
              {odooChanges.length} {lang === 'vi' ? 'đơn đã thay đổi trong Odoo sau khi nhập' : 'orders changed in Odoo after import'}
            </span>
            <button onClick={applyOdooChanges} disabled={applyingChanges}
              className="text-xs font-bold px-4 py-2 rounded-xl text-white disabled:opacity-60"
              style={{ backgroundColor: '#B91C1C' }}>
              {applyingChanges
                ? (lang === 'vi' ? 'Đang cập nhật…' : 'Updating…')
                : (lang === 'vi' ? 'Cập nhật sản xuất' : 'Update production')}
            </button>
          </div>
          <div className="divide-y bg-white" style={{ borderColor: '#FEE2E2' }}>
            {odooChanges.map(ch => (
              <div key={ch.order_ref} className="px-4 py-2.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs font-semibold text-navy">{ch.order_ref}</span>
                  {ch.cancelled && (
                    <span className="text-[10px] font-bold rounded-full px-2 py-0.5" style={{ backgroundColor: '#FEE2E2', color: '#B91C1C' }}>
                      {lang === 'vi' ? 'ĐÃ HỦY' : 'CANCELLED'}
                    </span>
                  )}
                </div>
                <div className="mt-1 space-y-0.5">
                  {ch.items.map(it => (
                    <div key={it.sku} className="flex items-center gap-2 text-xs text-ink-light">
                      <code className="font-mono text-[10px]">{it.sku}</code>
                      <span className="flex-1 truncate">{it.name}</span>
                      <span>×{it.old_qty} → <span className={`font-bold ${it.new_qty > it.old_qty ? 'text-green-600' : 'text-red-600'}`}>×{it.new_qty}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {changesApplied && (
        <div className="p-3 rounded-xl bg-green-50 text-green-700 text-sm">
          ✓ {changesApplied.length} {lang === 'vi' ? 'dòng đã được cập nhật theo Odoo' : 'lines updated from Odoo'}
        </div>
      )}

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

          {/* Sync directly from Odoo — no manual export needed */}
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t border-border-soft" />
            <span className="text-xs text-ink-light uppercase tracking-wider">{lang === 'vi' ? 'hoặc' : 'or'}</span>
            <div className="flex-1 border-t border-border-soft" />
          </div>
          <button
            onClick={syncFromOdoo}
            disabled={syncing}
            className="w-full card p-5 flex items-center justify-center gap-3 hover:border-gold/60 border-2 border-transparent transition-colors disabled:opacity-60"
            style={{ borderStyle: 'solid' }}
          >
            <span className={`inline-block w-4 h-4 rounded-full border-2 border-navy ${syncing ? 'border-t-transparent animate-spin' : ''}`}
              style={!syncing ? { borderStyle: 'double' } : undefined} />
            <span className="font-semibold text-navy">
              {syncing
                ? (lang === 'vi' ? 'Đang đồng bộ từ Odoo…' : 'Syncing from Odoo…')
                : (lang === 'vi' ? 'Đồng bộ từ Odoo' : 'Sync from Odoo')}
            </span>
            <span className="text-xs text-ink-light">
              {lang === 'vi' ? '(đơn đã xác nhận, giao từ hôm nay)' : '(confirmed orders, delivering today onwards)'}
            </span>
          </button>

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

          {/* ── Control report: Excel vs import (3 levels) ── */}
          {(() => {
            const allSkipped = parsedFiles.flatMap(pf => pf.skipped.map(s => ({ ...s, file: pf.filename })));
            const skippedQty = allSkipped.reduce((s, l) => s + (l.qty || 0), 0);
            const excludedList = mergedLines.filter(l => excludedSkus.has(l.product_sku));
            const excludedQty = excludedList.reduce((s, l) => s + l.total_qty, 0);
            const excelLines = mergedLines.length + allSkipped.length;
            const excelQty = mergedLines.reduce((s, l) => s + l.total_qty, 0) + skippedQty;
            const qtyDelta = excelQty - totalItems;
            const ok = qtyDelta === 0;
            // Level 2 — per order
            const orderRows = Array.from(new Set(
              effectiveLines.flatMap(l => l.breakdown.map(b => b.order_ref)).filter(Boolean)
            )).map(ref => {
              const bs = effectiveLines.flatMap(l => l.breakdown.filter(b => b.order_ref === ref));
              return { ref, lines: bs.length, qty: bs.reduce((a, b) => a + b.qty, 0) };
            });
            // Level 3 — per product: Excel qty vs kept qty
            const perSku = new Map<string, { name: string; excel: number; kept: number; note: string }>();
            for (const l of mergedLines) {
              const kept = excludedSkus.has(l.product_sku) ? 0 : l.total_qty;
              const cur = perSku.get(l.product_sku) ?? { name: l.product_name_vi, excel: 0, kept: 0, note: '' };
              cur.excel += l.total_qty; cur.kept += kept;
              if (excludedSkus.has(l.product_sku)) cur.note = lang === 'vi' ? 'bị loại' : 'excluded';
              perSku.set(l.product_sku, cur);
            }
            for (const s of allSkipped) {
              const key = s.sku || `(row ${s.row})`;
              const cur = perSku.get(key) ?? { name: s.name || key, excel: 0, kept: 0, note: '' };
              cur.excel += s.qty || 0;
              cur.note = s.reason === 'no_sku' ? (lang === 'vi' ? 'thiếu SKU' : 'missing SKU') : (lang === 'vi' ? 'thiếu số lượng' : 'missing qty');
              perSku.set(key, cur);
            }
            const productRows = Array.from(perSku.entries()).map(([sku, v]) => ({ sku, ...v }));
            const diffRows = productRows.filter(r => r.excel !== r.kept);
            return (
              <div className={`rounded-xl border overflow-hidden ${ok ? 'border-green-200' : 'border-red-200'}`}>
                {/* Level 1 — banner */}
                <div className={`px-4 py-3 flex items-center gap-3 text-sm ${ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {ok ? <CheckCircle2 size={18} className="shrink-0" /> : <AlertCircle size={18} className="shrink-0" />}
                  <div className="flex-1">
                    <span className="font-bold">
                      {lang === 'vi' ? 'Đối chiếu với Excel Odoo : ' : 'Check vs Odoo Excel: '}
                      {ok
                        ? (lang === 'vi' ? 'khớp 100%' : '100% match')
                        : (lang === 'vi' ? `lệch ${qtyDelta} cái` : `${qtyDelta} items missing`)}
                    </span>
                    <div className="text-xs mt-0.5 opacity-80">
                      Excel: {excelLines} {lang === 'vi' ? 'dòng' : 'lines'} · {excelQty} {lang === 'vi' ? 'cái' : 'items'} · {orderRows.length} {lang === 'vi' ? 'đơn' : 'orders'}
                      {' → '}
                      {lang === 'vi' ? 'Nhập' : 'Import'}: {effectiveLines.length} {lang === 'vi' ? 'dòng' : 'lines'} · {totalItems} {lang === 'vi' ? 'cái' : 'items'}
                      {allSkipped.length > 0 && ` · ${allSkipped.length} ${lang === 'vi' ? 'dòng bị bỏ qua' : 'skipped'}`}
                      {excludedList.length > 0 && ` · ${excludedList.length} ${lang === 'vi' ? 'SKU bị loại' : 'excluded'} (−${excludedQty})`}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => setReportSection(reportSection === 'orders' ? null : 'orders')}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${reportSection === 'orders' ? 'bg-white' : 'bg-transparent hover:bg-white/50'}`}>
                      {lang === 'vi' ? 'Theo đơn' : 'By order'}
                    </button>
                    <button onClick={() => setReportSection(reportSection === 'products' ? null : 'products')}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${reportSection === 'products' ? 'bg-white' : 'bg-transparent hover:bg-white/50'}`}>
                      {lang === 'vi' ? 'Theo sản phẩm' : 'By product'}
                    </button>
                  </div>
                </div>

                {/* Level 3 quick view — always show discrepancies if any */}
                {diffRows.length > 0 && reportSection === null && (
                  <div className="divide-y divide-red-100 bg-white">
                    {diffRows.map(r => (
                      <div key={r.sku} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <code className="text-[10px] font-mono px-2 py-0.5 rounded bg-red-50 text-red-700 shrink-0">{r.sku}</code>
                        <span className="flex-1 truncate text-navy">{r.name}</span>
                        <span className="text-xs text-ink-light">Excel ×{r.excel} → {lang === 'vi' ? 'nhập' : 'import'} ×{r.kept}</span>
                        <span className="text-[10px] font-semibold text-red-600 uppercase">{r.note}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Level 2 — by order */}
                {reportSection === 'orders' && (
                  <div className="bg-white max-h-72 overflow-y-auto">
                    <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 sticky top-0">
                      <div className="col-span-5">{lang === 'vi' ? 'Đơn hàng' : 'Order'}</div>
                      <div className="col-span-2">{lang === 'vi' ? 'Trạng thái' : 'Status'}</div>
                      <div className="col-span-2 text-center">{lang === 'vi' ? 'Dòng' : 'Lines'}</div>
                      <div className="col-span-3 text-center">{lang === 'vi' ? 'SL' : 'Qty'}</div>
                    </div>
                    {orderRows.map(r => {
                      const st = odooStates[r.ref];
                      const confirmed = st === 'sale' || st === 'approved';
                      return (
                        <div key={r.ref} className="grid grid-cols-12 px-4 py-2 text-sm border-t border-border-soft items-center">
                          <div className="col-span-5 font-mono text-xs text-navy truncate">{r.ref}</div>
                          <div className="col-span-2">
                            {st && (
                              <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${confirmed ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                {confirmed
                                  ? (lang === 'vi' ? 'Đã xác nhận' : 'Confirmed')
                                  : st === 'submitted' || st === 'sent'
                                    ? (lang === 'vi' ? 'Đã gửi' : 'Submitted')
                                    : (lang === 'vi' ? 'Nháp' : 'Draft')}
                              </span>
                            )}
                          </div>
                          <div className="col-span-2 text-center text-ink-light">{r.lines}</div>
                          <div className="col-span-3 text-center font-bold text-navy">×{r.qty}</div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Level 3 — by product (full) */}
                {reportSection === 'products' && (
                  <div className="bg-white max-h-72 overflow-y-auto">
                    <div className="grid grid-cols-12 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-light bg-cream/50 sticky top-0">
                      <div className="col-span-2">SKU</div>
                      <div className="col-span-5">{lang === 'vi' ? 'Sản phẩm' : 'Product'}</div>
                      <div className="col-span-2 text-center">Excel</div>
                      <div className="col-span-2 text-center">{lang === 'vi' ? 'Nhập' : 'Import'}</div>
                      <div className="col-span-1" />
                    </div>
                    {productRows.map(r => (
                      <div key={r.sku} className={`grid grid-cols-12 px-4 py-2 text-sm border-t border-border-soft ${r.excel !== r.kept ? 'bg-red-50' : ''}`}>
                        <div className="col-span-2 font-mono text-[10px] text-ink-light truncate">{r.sku}</div>
                        <div className="col-span-5 truncate text-navy">{r.name}</div>
                        <div className="col-span-2 text-center">×{r.excel}</div>
                        <div className={`col-span-2 text-center font-bold ${r.excel !== r.kept ? 'text-red-600' : 'text-navy'}`}>×{r.kept}</div>
                        <div className="col-span-1 text-[10px] text-red-600 text-right">{r.note}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

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
                  {lang === 'vi' ? 'SKU chưa có fiche kỹ thuật lab' : 'SKUs without a lab fiche'}
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

          {/* Empty team — assign manually, otherwise kept in history only */}
          {emptyTeamLines.length > 0 && (
            <div className="rounded-xl bg-blue-50 border border-blue-200 overflow-hidden">
              <div className="flex items-center gap-2 text-blue-700 text-sm px-3 py-3">
                <AlertCircle size={15} className="shrink-0" />
                <span>
                  <span className="font-medium">
                    {emptyTeamLines.length} {lang === 'vi' ? 'dòng không có đội' : 'lines with no team assigned'}
                  </span>
                  {' — '}
                  {lang === 'vi'
                    ? 'chọn đội bên dưới, nếu không sẽ chỉ lưu vào lịch sử.'
                    : 'pick a team below, otherwise saved to order history only.'}
                </span>
              </div>
              <div className="divide-y divide-blue-100 bg-white">
                {Array.from(new Map(emptyTeamLines.map(l => [l.product_sku, l])).values()).map(l => (
                  <div key={l.product_sku} className="flex items-center gap-3 px-3 py-2">
                    <code className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-800 shrink-0">{l.product_sku}</code>
                    <span className="flex-1 text-sm text-navy truncate">{l.product_name_vi}</span>
                    <select
                      value=""
                      onChange={e => { if (e.target.value) assignTeam(l.product_sku, e.target.value); }}
                      className="input py-1 text-xs w-40"
                    >
                      <option value="">{lang === 'vi' ? 'Chọn đội…' : 'Pick team…'}</option>
                      {TEAMS.map(t => (
                        <option key={t} value={t}>{lang === 'vi' ? TEAM_LABELS[t].vi : TEAM_LABELS[t].en}</option>
                      ))}
                    </select>
                  </div>
                ))}
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
