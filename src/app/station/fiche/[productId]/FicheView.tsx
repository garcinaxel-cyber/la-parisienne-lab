'use client';
import { useI18n } from '@/lib/i18n';
import Link from 'next/link';
import { ArrowLeft, Printer, Timer, Thermometer } from 'lucide-react';

interface FicheMeta {
  doc_code: string | null;
  weight_grams: number | null;
  tolerance_pct: number | null;
  sensory_vi: string | null;
  sensory_en: string | null;
  warning_vi: string | null;
  warning_en: string | null;
}

interface FicheStep {
  step_type: string;
  step_number: number;
  description_vi: string;
  description_en: string;
  duration_minutes: number | null;
  temperature_celsius: number | null;
  quantity_grams: number | null;
  percentage: number | null;
}

interface Product {
  id: string;
  name_vi: string;
  name_en: string | null;
  main_image_url: string | null;
  sku: string | null;
  subcategory: string | null;
  weight_grams: number | null;
  categories: { name_vi: string; name_en: string } | null;
}

function renderSensory(text: string) {
  return text.split('\n').filter(Boolean).map((line, i) => {
    // **Title:** rest → <strong>Title:</strong> rest
    const m = line.match(/^\*\*(.+?)\*\*[:：]?\s*(.*)/);
    return (
      <li key={i} style={{ display: 'flex', gap: '6px', marginBottom: '4px', fontSize: '11px', color: '#444' }}>
        <span style={{ color: '#C5932A', flexShrink: 0 }}>•</span>
        <span>
          {m ? <><strong>{m[1]}:</strong> {m[2]}</> : line}
        </span>
      </li>
    );
  });
}

export default function FicheView({
  product, steps, meta, backUrl,
}: {
  product: Product;
  steps: FicheStep[];
  meta: FicheMeta | null;
  backUrl: string;
}) {
  const { lang, setLang } = useI18n();

  const ingredients = steps.filter(s => s.step_type === 'ingredient');
  const assemblySteps = steps.filter(s => s.step_type === 'step' || !s.step_type);
  const totalWeight = ingredients.reduce((s, i) => s + (i.quantity_grams ?? 0), 0);

  const sensoryText = lang === 'vi' ? (meta?.sensory_vi ?? '') : (meta?.sensory_en ?? '');
  const warning = lang === 'vi' ? meta?.warning_vi : meta?.warning_en;
  const categoryName = lang === 'vi'
    ? product.categories?.name_vi
    : product.categories?.name_en;

  const stdWeight = meta?.weight_grams ?? product.weight_grams;
  const tol = meta?.tolerance_pct ?? 3;

  return (
    <>
      {/* Global print CSS */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { margin: 15mm 15mm 15mm 15mm; size: A4; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .fiche-page { padding: 0 !important; max-width: 100% !important; }
          .fiche-table td, .fiche-table th { border: 1px solid #ccc !important; }
        }
      `}</style>

      {/* Screen-only controls bar */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-border-soft px-4 py-2 flex items-center justify-between gap-4 shadow-sm">
        <Link href={backUrl} className="flex items-center gap-1.5 text-sm text-ink-light hover:text-navy transition-colors">
          <ArrowLeft size={15} /> {lang === 'vi' ? 'Quay lại' : 'Back'}
        </Link>
        <div className="flex items-center gap-2">
          {/* Lang toggle */}
          <div className="flex gap-0.5 bg-cream rounded-lg p-0.5 border border-border-soft">
            {(['vi', 'en'] as const).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-2.5 py-1 rounded text-xs font-bold transition-colors ${lang === l ? 'bg-navy text-white' : 'text-ink-light'}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 text-sm font-semibold text-white bg-navy rounded-xl px-4 py-2 hover:bg-navy/80 transition-colors"
          >
            <Printer size={15} /> {lang === 'vi' ? 'In phiếu' : 'Print'}
          </button>
        </div>
      </div>

      {/* ── FICHE CONTENT ── */}
      <div className="fiche-page bg-white" style={{ maxWidth: '210mm', margin: '0 auto', padding: '20px 28px', fontFamily: "'Georgia', 'Times New Roman', serif" }}>

        {/* ── HEADER ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2.5px solid #1a1a2e', paddingBottom: '12px', marginBottom: '20px' }}>
          <div>
            <div style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '1px', color: '#1a1a2e', fontFamily: 'Arial, sans-serif' }}>LA PARISIENNE</div>
            <div style={{ fontSize: '9px', letterSpacing: '5px', color: '#888', fontWeight: 600, fontFamily: 'Arial, sans-serif', marginTop: '2px' }}>A R T I S A N A L &nbsp; B A K E R Y</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#1a1a2e', fontFamily: 'Arial, sans-serif', letterSpacing: '0.5px' }}>
              {lang === 'vi' ? 'PHIẾU NHẬN DẠNG KỸ THUẬT' : 'TECHNICAL IDENTITY SHEET'}
            </div>
            {meta?.doc_code && (
              <div style={{ fontSize: '10px', color: '#888', marginTop: '3px', fontFamily: 'Arial, sans-serif' }}>
                {lang === 'vi' ? 'MÃ TÀI LIỆU:' : 'DOC CODE:'} {meta.doc_code}
              </div>
            )}
          </div>
        </div>

        {/* ── PRODUCT TITLE BLOCK ── */}
        <div style={{ borderLeft: '4px solid #C5932A', paddingLeft: '14px', marginBottom: '20px', backgroundColor: '#fffbf2', padding: '12px 14px', borderRadius: '4px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 900, color: '#1a1a2e', margin: 0, fontFamily: 'Arial, sans-serif', letterSpacing: '0.5px' }}>
            {product.name_vi.toUpperCase()}
          </h1>
          {product.name_en && (
            <p style={{ fontSize: '12px', color: '#666', margin: '3px 0 0', fontFamily: 'Arial, sans-serif' }}>{product.name_en}</p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', marginTop: '8px', fontSize: '12px', color: '#555', fontFamily: 'Arial, sans-serif' }}>
            {categoryName && (
              <span>{lang === 'vi' ? 'Phân nhóm:' : 'Category:'} <strong>{categoryName}{product.subcategory ? ` (${product.subcategory})` : ''}</strong></span>
            )}
            {stdWeight && (
              <span>{lang === 'vi' ? 'Tổng trọng lượng chuẩn:' : 'Standard weight:'} <strong style={{ color: '#C5932A' }}>{stdWeight} gr</strong></span>
            )}
            {stdWeight && (
              <span>{lang === 'vi' ? 'Sai số cho phép:' : 'Tolerance:'} <strong>± {tol}% ({Math.round(stdWeight * (1 - tol / 100))}g – {Math.round(stdWeight * (1 + tol / 100))}g)</strong></span>
            )}
          </div>
        </div>

        {/* ── TWO COLUMNS: image+sensory | ingredients ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: '20px', marginBottom: '20px' }}>

          {/* Left: Image + sensory */}
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#1a1a2e', letterSpacing: '1.5px', fontFamily: 'Arial, sans-serif', marginBottom: '8px', borderBottom: '1px solid #ddd', paddingBottom: '4px' }}>
              {lang === 'vi' ? 'HÌNH ẢNH THÀNH PHẨM CHUẨN' : 'REFERENCE PRODUCT IMAGE'}
            </div>
            <div style={{ border: '1.5px solid #ddd', borderRadius: '6px', overflow: 'hidden', minHeight: '160px', backgroundColor: '#f9f9f9', marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {product.main_image_url ? (
                <img src={product.main_image_url} alt={product.name_vi} style={{ width: '100%', height: '180px', objectFit: 'cover', display: 'block' }} />
              ) : (
                <div style={{ fontSize: '11px', color: '#aaa', fontFamily: 'Arial, sans-serif', textAlign: 'center', padding: '20px' }}>
                  [ {lang === 'vi' ? 'Không gian dán ảnh chuẩn' : 'Reference photo placeholder'} ]
                </div>
              )}
            </div>
            {sensoryText && (
              <div style={{ border: '1px solid #e5e5e5', borderRadius: '4px', padding: '10px' }}>
                <div style={{ fontSize: '10px', fontWeight: 700, color: '#1a1a2e', fontFamily: 'Arial, sans-serif', marginBottom: '6px' }}>
                  {lang === 'vi' ? 'Tiêu chuẩn cảm quan:' : 'Quality standards:'}
                </div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {renderSensory(sensoryText)}
                </ul>
              </div>
            )}
          </div>

          {/* Right: Ingredients table */}
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#1a1a2e', letterSpacing: '1.5px', fontFamily: 'Arial, sans-serif', marginBottom: '8px', borderBottom: '1px solid #ddd', paddingBottom: '4px' }}>
              {lang === 'vi' ? 'CẤU TRÚC CÁC LỚP NGUYÊN LIỆU (LAYERS)' : 'INGREDIENT LAYERS STRUCTURE'}
            </div>
            {ingredients.length > 0 ? (
              <table className="fiche-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'Arial, sans-serif' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f0f0f0' }}>
                    <th style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center', width: '28px', fontWeight: 700 }}>STT</th>
                    <th style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'left', fontWeight: 700 }}>
                      {lang === 'vi' ? 'Thành phần nguyên liệu (Layers)' : 'Ingredient (Layers)'}
                    </th>
                    <th style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center', width: '60px', fontWeight: 700 }}>
                      {lang === 'vi' ? 'Định lượng' : 'Qty'}
                    </th>
                    <th style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center', width: '44px', fontWeight: 700 }}>
                      Tỷ lệ %
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ingredients.map((ing, i) => (
                    <tr key={i} style={{ backgroundColor: i % 2 === 1 ? '#fafafa' : '#fff' }}>
                      <td style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center', fontWeight: 700 }}>{i + 1}</td>
                      <td style={{ border: '1px solid #ccc', padding: '5px 6px' }}>
                        {lang === 'vi' ? ing.description_vi : (ing.description_en || ing.description_vi)}
                      </td>
                      <td style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center' }}>
                        {ing.quantity_grams != null ? `${ing.quantity_grams} gr` : '–'}
                      </td>
                      <td style={{ border: '1px solid #ccc', padding: '5px 6px', textAlign: 'center' }}>
                        {ing.percentage != null ? `${ing.percentage}%` : '–'}
                      </td>
                    </tr>
                  ))}
                  {/* Total row */}
                  <tr style={{ backgroundColor: '#FFF8E7' }}>
                    <td colSpan={2} style={{ border: '1px solid #ccc', padding: '6px 8px', textAlign: 'right', fontWeight: 700, fontSize: '11px', color: '#1a1a2e' }}>
                      {lang === 'vi' ? 'TỔNG TRỌNG LƯỢNG THÀNH PHẨM:' : 'TOTAL FINISHED WEIGHT:'}
                    </td>
                    <td style={{ border: '1px solid #ccc', padding: '6px 8px', textAlign: 'center', fontWeight: 900, color: '#C5932A' }}>
                      {totalWeight > 0 ? `${totalWeight} gr` : (stdWeight ? `${stdWeight} gr` : '–')}
                    </td>
                    <td style={{ border: '1px solid #ccc', padding: '6px 8px', textAlign: 'center', fontWeight: 900, color: '#C5932A' }}>
                      100%
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: '11px', color: '#aaa', fontStyle: 'italic', fontFamily: 'Arial, sans-serif' }}>
                {lang === 'vi' ? 'Chưa có danh sách nguyên liệu.' : 'No ingredients listed yet.'}
              </p>
            )}
          </div>
        </div>

        {/* ── ASSEMBLY STEPS ── */}
        {assemblySteps.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: '#1a1a2e', letterSpacing: '1.5px', fontFamily: 'Arial, sans-serif', marginBottom: '10px', borderBottom: '1px solid #ddd', paddingBottom: '4px' }}>
              {lang === 'vi' ? 'QUY TRÌNH TẠO HÌNH & LẮP RÁP (ASSEMBLY GUIDE)' : 'SHAPING & ASSEMBLY PROCESS (ASSEMBLY GUIDE)'}
            </div>
            <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {assemblySteps.map((step, i) => (
                <li key={i} style={{ display: 'flex', gap: '10px', marginBottom: '10px', fontSize: '12px', fontFamily: 'Arial, sans-serif', color: '#333' }}>
                  <span style={{ fontWeight: 700, minWidth: '18px', color: '#1a1a2e' }}>{i + 1}.</span>
                  <div>
                    <span>{lang === 'vi' ? step.description_vi : (step.description_en || step.description_vi)}</span>
                    {(step.temperature_celsius || step.duration_minutes) && (
                      <span style={{ marginLeft: '8px', fontSize: '10px', color: '#888' }}>
                        {step.temperature_celsius ? `${step.temperature_celsius}°C` : ''}
                        {step.temperature_celsius && step.duration_minutes ? ' · ' : ''}
                        {step.duration_minutes ? `${step.duration_minutes} min` : ''}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* ── WARNING NOTE ── */}
        {warning && (
          <div style={{ borderTop: '1px solid #e5e5e5', paddingTop: '12px', marginTop: '8px' }}>
            <p style={{ fontSize: '10px', color: '#666', fontStyle: 'italic', fontFamily: 'Arial, sans-serif', margin: 0 }}>
              * {warning}
            </p>
          </div>
        )}

        {/* ── FOOTER ── */}
        <div style={{ borderTop: '2px solid #e0e0e0', marginTop: '24px', paddingTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '9px', fontWeight: 700, color: '#C5932A', fontFamily: 'Arial, sans-serif', letterSpacing: '0.5px' }}>
            LA PARISIENNE • {lang === 'vi' ? 'Tiêu Chuẩn Kỹ Thuật Sản Phẩm' : 'Product Technical Standards'}
          </span>
          <span style={{ fontSize: '9px', color: '#aaa', fontFamily: 'Arial, sans-serif' }}>
            {product.sku ? `SKU: ${product.sku}` : ''}
          </span>
        </div>
      </div>
    </>
  );
}
