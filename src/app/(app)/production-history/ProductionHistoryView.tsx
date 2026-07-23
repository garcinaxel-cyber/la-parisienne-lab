'use client';
import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { TEAM_LABELS, type Team } from '@/lib/types';
import { Download, FileSpreadsheet, ChevronDown, ChevronRight, Package, X, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

interface Day { date: string; pieces: number; cards: number; extras: number }
type Item = { product: string; variant: string | null; team: string | null; sku: string | null; qty: number; is_extra: boolean; produced_ahead: boolean; delivery_date: string | null };

export default function ProductionHistoryView({ days, today }: { days: Day[]; today: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const fmt = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, Item[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [odoo, setOdoo] = useState<{ date: string } | null>(null);
  const [odooDry, setOdooDry] = useState<any>(null);
  const [odooBusy, setOdooBusy] = useState(false);
  const [odooResult, setOdooResult] = useState<any>(null);
  const [pendingToday, setPendingToday] = useState<number | null>(null);

  // Reminder: how much of TODAY's production is not yet transferred to Odoo? (dry-run, read-only)
  useEffect(() => {
    let cancel = false;
    fetch(`/api/lab/production-to-odoo?date=${today}`)
      .then(r => r.json())
      .then(j => { if (!cancel) setPendingToday(j?.summary?.to_create ?? 0); })
      .catch(() => {});
    return () => { cancel = true; };
  }, [today]);

  async function toggleDetail(date: string) {
    if (open === date) { setOpen(null); return; }
    setOpen(date);
    if (!detail[date]) {
      setLoading(date);
      try {
        const r = await fetch(`/api/lab/production-day?date=${date}`);
        const j = await r.json();
        setDetail(prev => ({ ...prev, [date]: j.items ?? [] }));
      } finally { setLoading(null); }
    }
  }

  async function openOdoo(date: string) {
    setOdoo({ date }); setOdooDry(null); setOdooResult(null); setOdooBusy(true);
    try {
      const r = await fetch(`/api/lab/production-to-odoo?date=${date}`);
      setOdooDry(await r.json());
    } finally { setOdooBusy(false); }
  }
  async function confirmOdoo() {
    if (!odoo) return;
    setOdooBusy(true);
    try {
      const r = await fetch(`/api/lab/production-to-odoo?date=${odoo.date}&commit=1`);
      setOdooResult(await r.json());
      if (odoo.date === today) {
        fetch(`/api/lab/production-to-odoo?date=${today}`).then(r => r.json())
          .then(j => setPendingToday(j?.summary?.to_create ?? 0)).catch(() => {});
      }
    } finally { setOdooBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-black text-navy flex items-center gap-2">
          <FileSpreadsheet size={20} />
          {vi ? 'Lịch sử sản xuất' : 'Historique de production'}
        </h1>
        <p className="text-sm text-ink-light mt-1">
          {vi
            ? 'Tổng sản xuất mỗi ngày theo NGÀY LÀM (gồm extra & làm trước). Bấm vào một ngày để xem chi tiết. Xuất Excel hoặc tạo Lệnh SX nháp trên Odoo.'
            : 'Production par jour de fabrication (extra & fait en avance inclus). Clique une journée pour le détail. Exporte l’Excel ou crée les ordres de fabrication (brouillon) dans Odoo.'}
        </p>
      </div>

      {/* Reminder — only shows when today has production not yet sent to Odoo */}
      {pendingToday !== null && pendingToday > 0 && (
        <div className="rounded-xl border flex items-center gap-3 px-4 py-3" style={{ borderColor: '#FCD34D', backgroundColor: '#FFFBEB' }}>
          <AlertCircle size={18} className="shrink-0" style={{ color: '#B45309' }} />
          <span className="text-sm flex-1 min-w-0" style={{ color: '#92600A' }}>
            {vi
              ? `${pendingToday} sản phẩm hôm nay chưa chuyển sang Odoo`
              : `${pendingToday} produit${pendingToday > 1 ? 's' : ''} produit${pendingToday > 1 ? 's' : ''} aujourd’hui pas encore transféré${pendingToday > 1 ? 's' : ''} dans Odoo`}
          </span>
          <button onClick={() => openOdoo(today)}
            className="btn-primary text-sm py-2 px-4 inline-flex items-center gap-1.5 shrink-0">
            <Package size={14} />{vi ? 'Chuyển ngay' : 'Transférer'}
          </button>
        </div>
      )}

      {days.length === 0 ? (
        <div className="card p-6 text-center text-ink-light text-sm">
          {vi ? 'Chưa có sản xuất nào.' : 'Aucune production enregistrée.'}
        </div>
      ) : (
        <div className="card divide-y divide-border-soft overflow-hidden">
          {days.map(d => {
            const isOpen = open === d.date;
            const items = detail[d.date];
            return (
              <div key={d.date}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button onClick={() => toggleDetail(d.date)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                    {isOpen ? <ChevronDown size={16} className="text-ink-light shrink-0" /> : <ChevronRight size={16} className="text-ink-light shrink-0" />}
                    <span className="min-w-0">
                      <span className="font-bold text-navy block truncate">
                        {fmt(d.date)}
                        {d.date === today && (
                          <span className="ml-2 text-[11px] font-black rounded-full px-2 py-0.5" style={{ backgroundColor: '#F0F9F4', color: '#2D6A4F' }}>
                            {vi ? 'Hôm nay' : 'Aujourd’hui'}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-ink-light">
                        <span className="font-semibold text-navy">{d.pieces}</span> {vi ? 'sản phẩm' : 'pièces'}
                        {' · '}{d.cards} {vi ? 'thẻ' : 'cartes'}
                        {d.extras > 0 && <> · {d.extras} extra</>}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => openOdoo(d.date)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold border border-border-soft text-navy hover:bg-cream transition-colors shrink-0"
                    title={vi ? 'Tạo Lệnh sản xuất nháp trên Odoo' : 'Créer les OF (brouillon) dans Odoo'}
                  >
                    <Package size={15} /> Odoo
                  </button>
                  <a
                    href={`/api/lab/production-export?date=${d.date}`}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold bg-navy text-white hover:bg-navy/90 transition-colors shrink-0"
                  >
                    <Download size={15} />
                    {vi ? 'Xuất' : 'Export'}
                  </a>
                </div>

                {isOpen && (
                  <div className="px-4 pb-3 bg-cream/40">
                    {loading === d.date ? (
                      <div className="text-xs text-ink-light py-2">{vi ? 'Đang tải…' : 'Chargement…'}</div>
                    ) : !items || items.length === 0 ? (
                      <div className="text-xs text-ink-light py-2">{vi ? 'Không có chi tiết.' : 'Aucun détail.'}</div>
                    ) : (
                      <div className="rounded-xl overflow-hidden mt-1" style={{ border: '1px solid #E5E7EB' }}>
                        {items.map((it, i) => {
                          const meta = it.team ? TEAM_LABELS[it.team as Team] : null;
                          return (
                            <div key={i} className="flex items-center gap-2 px-3 py-2 text-sm bg-white" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                              <span className="flex-1 min-w-0 truncate text-navy">
                                {it.product}
                                {it.variant && it.variant !== 'Standard' && <span className="text-ink-light"> · {it.variant}</span>}
                              </span>
                              {it.produced_ahead && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full inline-flex items-center gap-1 shrink-0" style={{ backgroundColor: '#EFF6FF', color: '#1D4ED8' }}>
                                  <Clock size={9} />{vi ? 'Làm trước' : 'En avance'}
                                </span>
                              )}
                              {it.is_extra && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: '#FEF3C7', color: '#D97706' }}>+Extra</span>}
                              {meta && <span className="text-[10px] font-semibold shrink-0" style={{ color: meta.color }}>{vi ? meta.vi : meta.en}</span>}
                              <span className="font-bold text-navy shrink-0">×{it.qty}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Odoo create modal */}
      {odoo && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/40" onClick={() => setOdoo(null)}>
          <div className="card w-full max-w-lg p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-navy flex items-center gap-2"><Package size={18} /> {vi ? 'Tạo Lệnh SX (nháp) trên Odoo' : 'Créer les OF (brouillon) dans Odoo'}</h3>
              <button onClick={() => setOdoo(null)} className="p-1 text-ink-light"><X size={18} /></button>
            </div>
            <p className="text-xs text-ink-light">{fmt(odoo.date)}</p>

            {odooBusy && !odooResult && <div className="text-sm text-ink-light py-3">{vi ? 'Đang xử lý…' : 'Traitement…'}</div>}

            {/* Dry-run preview */}
            {odooDry && !odooResult && (() => {
              const s = odooDry.summary ?? {};
              return (
                <div className="space-y-3">
                  {odooDry.error ? (
                    <div className="text-sm text-red-600 flex items-start gap-2"><AlertCircle size={15} className="mt-0.5 shrink-0" />{odooDry.error}</div>
                  ) : (
                    <>
                      <div className="text-sm text-navy">
                        <span className="font-bold">{s.to_create}</span> {vi ? 'sẽ được tạo' : 'à créer'}
                        {s.already_created > 0 && <> · <span className="font-semibold">{s.already_created}</span> {vi ? 'đã tạo' : 'déjà créés'}</>}
                        {s.no_odoo_product > 0 && <> · <span className="text-amber-600 font-semibold">{s.no_odoo_product}</span> {vi ? 'không có SP Odoo' : 'sans produit Odoo'}</>}
                      </div>
                      {(odooDry.toCreate ?? []).length > 0 && (
                        <div className="rounded-lg text-xs max-h-52 overflow-y-auto" style={{ border: '1px solid #E5E7EB' }}>
                          {odooDry.toCreate.map((r: any, i: number) => (
                            <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-white" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                              <span className="truncate text-navy">{r.product}</span>
                              <span className="font-bold text-navy shrink-0 ml-2">×{r.qty}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {(odooDry.noProduct ?? []).length > 0 && (
                        <div className="text-[11px] text-amber-700">
                          {vi ? 'Bỏ qua (không khớp SKU Odoo): ' : 'Ignorés (SKU introuvable dans Odoo) : '}
                          {odooDry.noProduct.map((n: any) => n.sku || n.name).join(', ')}
                        </div>
                      )}
                      <div className="flex justify-end gap-2 pt-1">
                        <button onClick={() => setOdoo(null)} className="btn-secondary text-sm">{vi ? 'Hủy' : 'Annuler'}</button>
                        <button onClick={confirmOdoo} disabled={odooBusy || s.to_create === 0}
                          className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                          <Package size={14} />{odooBusy ? '…' : (vi ? `Tạo ${s.to_create} lệnh` : `Créer ${s.to_create} OF`)}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}

            {/* Result */}
            {odooResult && (() => {
              const s = odooResult.summary ?? {};
              return (
                <div className="space-y-3">
                  {odooResult.error ? (
                    <div className="text-sm text-red-600 flex items-start gap-2"><AlertCircle size={15} className="mt-0.5 shrink-0" />{odooResult.error}</div>
                  ) : (
                    <>
                      <div className="text-sm flex items-center gap-2" style={{ color: '#16A34A' }}>
                        <CheckCircle2 size={16} /><span className="font-bold">{s.created}</span> {vi ? 'lệnh đã tạo (nháp)' : 'OF créés (brouillon)'}
                        {s.errors > 0 && <span className="text-red-600 ml-1">· {s.errors} {vi ? 'lỗi' : 'erreurs'}</span>}
                      </div>
                      {(odooResult.created ?? []).length > 0 && (
                        <div className="rounded-lg text-xs max-h-52 overflow-y-auto" style={{ border: '1px solid #E5E7EB' }}>
                          {odooResult.created.map((r: any, i: number) => (
                            <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-white" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                              <span className="truncate text-navy">{r.product}</span>
                              <span className="font-mono text-[11px] shrink-0 ml-2" style={{ color: '#2D6A4F' }}>{r.mo} · ×{r.qty}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {(odooResult.errors ?? []).length > 0 && (
                        <div className="text-[11px] text-red-600">
                          {odooResult.errors.map((e: any, i: number) => <div key={i}>{e.product}: {e.error}</div>)}
                        </div>
                      )}
                      <div className="flex justify-end pt-1">
                        <button onClick={() => setOdoo(null)} className="btn-primary text-sm">{vi ? 'Xong' : 'Terminé'}</button>
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
