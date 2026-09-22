'use client';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCheck, Loader2, Minus, Plus, ShieldCheck } from 'lucide-react';
import type { ShopStaffName } from './actions';
import type { OfficialInventoryLine, OfficialInventorySession } from './official-inventory-actions';
import { thumb } from '@/lib/img-thumb';
import { NamePicker, NAVY, GOLD, GOLD_LIGHT, GOLD_PALE, INK, BORDER, GREEN, RED } from './ShopView';

// "Kiểm kê chính thức" — the monthly official inventory (Axel, 2026-09-22): last day of the month
// only, pushes to Odoo (unlike the daily Kiểm kho, which never does), reuses the same cut-off/diff
// mechanism as the lab. See src/app/shop/official-inventory-actions.ts for the full server side.

const NAME_KEY = 'lab_shop_official_inventory_name';

export default function OfficialInventoryTab({ shopName, readOnly, staffNames, onManageStaff }: {
  shopName: string; readOnly: boolean; staffNames: ShopStaffName[] | null; onManageStaff: () => void;
}) {
  const shopArg = readOnly ? shopName : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLastDay, setIsLastDay] = useState(false);
  const [hasWarehouse, setHasWarehouse] = useState(true);
  const [period, setPeriod] = useState<string | null>(null);
  const [session, setSession] = useState<OfficialInventorySession | null>(null);
  const [lines, setLines] = useState<OfficialInventoryLine[]>([]);
  const [name, setName] = useState('');
  const [starting, setStarting] = useState(false);
  const [screen, setScreen] = useState<'count' | 'recap' | 'confirm1' | 'confirm2'>('count');
  const [savingSku, setSavingSku] = useState<string | null>(null);
  const [certified, setCertified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ pushStatus: string; errorCount: number } | null>(null);

  useEffect(() => { try { setName(localStorage.getItem(NAME_KEY) ?? ''); } catch { /* ignore */ } }, []);
  useEffect(() => { try { if (name) localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ } }, [name]);

  async function load() {
    setLoading(true);
    setError(null);
    const actions = await import('./official-inventory-actions');
    const res = await actions.getOfficialInventoryStateAction(shopArg);
    if (res.error) { setError(res.error); setLoading(false); return; }
    setIsLastDay(!!res.isLastDay);
    setHasWarehouse(res.hasWarehouse !== false);
    setPeriod(res.period ?? null);
    setSession(res.session ?? null);
    setLines(res.lines ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function handleStart() {
    if (!name.trim()) { setError('Chọn tên trước khi bắt đầu'); return; }
    setStarting(true);
    setError(null);
    const actions = await import('./official-inventory-actions');
    const res = await actions.startOfficialInventoryAction(name.trim(), shopArg);
    setStarting(false);
    if (res.error) { setError(res.error); return; }
    await load();
  }

  function updateLocalQty(sku: string, qty: number) {
    setLines(prev => prev.map(l => l.sku === sku ? { ...l, qtyCounted: qty } : l));
  }

  async function commitQty(sku: string, qty: number) {
    if (!session) return;
    setSavingSku(sku);
    const actions = await import('./official-inventory-actions');
    await actions.saveOfficialInventoryLineAction(session.id, sku, qty, name.trim(), shopArg);
    setSavingSku(null);
  }

  async function handleSubmit() {
    if (!session) return;
    setSubmitting(true);
    setSubmitError(null);
    const actions = await import('./official-inventory-actions');
    const res = await actions.submitOfficialInventoryAction(session.id, name.trim(), shopArg);
    setSubmitting(false);
    if (res.error) { setSubmitError(res.error); return; }
    setSubmitResult({ pushStatus: res.pushStatus ?? 'success', errorCount: res.errorCount ?? 0 });
    await load();
  }

  if (loading) return <div className="text-center py-10 text-sm" style={{ color: '#6B7280' }}>Đang tải…</div>;
  if (error && !session) return <div className="text-center py-10 text-sm font-semibold" style={{ color: RED }}>{error}</div>;

  if (!hasWarehouse) {
    return (
      <div className="rounded-xl px-3.5 py-3 text-sm" style={{ backgroundColor: GOLD_PALE, border: `1px solid ${BORDER}`, color: INK }}>
        Boutique sans entrepôt Odoo — l'inventaire officiel n'est pas disponible ici.
      </div>
    );
  }

  const countedCount = lines.filter(l => l.qtyCounted > 0).length;
  const isSubmitted = session?.status === 'submitted';

  // ── Not started yet today ──
  if (!session) {
    return (
      <div className="space-y-3">
        {isLastDay ? (
          <div className="rounded-xl px-3.5 py-3 flex items-start gap-2" style={{ backgroundColor: '#FBEAE8', border: `1px solid #EFC3BE` }}>
            <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: RED }} />
            <div className="text-sm" style={{ color: RED }}>
              <span className="font-bold">Hôm nay là ngày kiểm kê chính thức.</span> Bắt buộc — kết quả sẽ được gửi lên Odoo.
            </div>
          </div>
        ) : (
          <div className="rounded-xl px-3.5 py-3 text-sm" style={{ backgroundColor: '#F5F5F0', border: `1px solid ${BORDER}`, color: '#6B7280' }}>
            Kiểm kê chính thức chỉ mở vào ngày cuối cùng của tháng. Kiểm kho hằng ngày (tab "Kiểm kho") không bị ảnh hưởng.
          </div>
        )}
        {isLastDay && (
          <div className="rounded-xl p-4 space-y-3" style={{ background: `linear-gradient(135deg, ${NAVY}, #0F2E1F)` }}>
            <div className="text-sm font-bold" style={{ color: GOLD_LIGHT }}>Inventaire officiel du mois</div>
            <NamePicker value={name} onChange={setName} names={staffNames} onManage={onManageStaff} />
            {error && <div className="text-xs font-semibold" style={{ color: '#FFD9D2' }}>{error}</div>}
            <button onClick={handleStart} disabled={starting}
              className="w-full rounded-lg py-3 text-sm font-bold flex items-center justify-center gap-2"
              style={{ backgroundColor: GOLD, color: NAVY }}>
              {starting ? <Loader2 size={16} className="animate-spin" /> : <ClipboardCheck size={16} />}
              Commencer l'inventaire officiel
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Submitted (this period done) ──
  if (isSubmitted) {
    return (
      <div className="rounded-xl p-5 text-center space-y-2" style={{ backgroundColor: GOLD_PALE, border: `1px solid ${BORDER}` }}>
        <CheckCircle2 size={32} className="mx-auto" style={{ color: GREEN }} />
        <div className="font-bold text-sm" style={{ color: INK }}>Inventaire officiel {period} envoyé</div>
        <div className="text-xs" style={{ color: '#6B7280' }}>
          {lines.length} sản phẩm · gửi bởi {session.submittedByName ?? '—'}
          {session.odooPushStatus === 'partial' && <span style={{ color: RED }}> · une partie a échoué, à vérifier avec l'équipe</span>}
        </div>
      </div>
    );
  }

  // ── Confirmation step 1/2 ──
  if (screen === 'confirm1' || screen === 'confirm2') {
    return (
      <div className="rounded-xl p-4 space-y-3" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
        {screen === 'confirm1' ? (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: RED }}>Étape 1 sur 2</div>
            <div className="font-bold text-base" style={{ color: INK }}>Valider l'inventaire ?</div>
            <div className="text-sm" style={{ color: '#5C6B60' }}>{countedCount}/{lines.length} sản phẩm đã nhập. Sau khi xác nhận, số liệu không thể sửa nữa.</div>
            <div className="flex gap-2">
              <button onClick={() => setScreen('recap')} className="flex-1 rounded-lg py-3 text-sm font-semibold" style={{ border: `1px solid ${BORDER}`, color: INK }}>Quay lại</button>
              <button onClick={() => setScreen('confirm2')} className="flex-1 rounded-lg py-3 text-sm font-bold text-white" style={{ backgroundColor: NAVY }}>Valider l'inventaire</button>
            </div>
          </>
        ) : (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: RED }}>Étape 2 sur 2</div>
            <div className="font-bold text-base" style={{ color: INK }}>Envoyer à la comptabilité ?</div>
            <div className="text-sm" style={{ color: '#5C6B60' }}>Cette action pousse les quantités sur le stock actuel dans Odoo. Elle est définitive.</div>
            <button onClick={() => setCertified(c => !c)} type="button"
              className="w-full flex items-start gap-2.5 rounded-lg p-3 text-left"
              style={{ backgroundColor: GOLD_PALE, border: `1px solid ${BORDER}` }}>
              <div className="w-5 h-5 rounded shrink-0 flex items-center justify-center mt-0.5" style={{ border: `2px solid ${NAVY}`, background: certified ? NAVY : 'transparent' }}>
                {certified && <ShieldCheck size={12} color="#fff" />}
              </div>
              <div className="text-sm" style={{ color: INK }}>Tôi xác nhận đã đếm thực tế từng sản phẩm trong danh sách này.</div>
            </button>
            {submitError && <div className="text-xs font-semibold" style={{ color: RED }}>{submitError}</div>}
            <div className="flex gap-2">
              <button onClick={() => setScreen('confirm1')} className="flex-1 rounded-lg py-3 text-sm font-semibold" style={{ border: `1px solid ${BORDER}`, color: INK }}>Retour</button>
              <button onClick={handleSubmit} disabled={!certified || submitting}
                className="flex-1 rounded-lg py-3 text-sm font-bold text-white flex items-center justify-center gap-2"
                style={{ backgroundColor: certified ? RED : '#C9C2AE' }}>
                {submitting ? <Loader2 size={16} className="animate-spin" /> : null} Gửi lên Odoo
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Recap ──
  if (screen === 'recap') {
    return (
      <div className="space-y-3">
        <button onClick={() => setScreen('count')} className="text-xs font-semibold" style={{ color: NAVY }}>‹ Quay lại đếm</button>
        <div className="rounded-xl p-3 text-center" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
          <div className="text-xl font-bold" style={{ color: NAVY }}>{lines.length}</div>
          <div className="text-[11px]" style={{ color: '#8A9A8F' }}>sản phẩm sẽ gửi lên Odoo</div>
        </div>
        <div className="space-y-1.5 max-h-[50vh] overflow-auto">
          {lines.map(l => (
            <div key={l.sku} className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
              <div className="flex-1 min-w-0 text-sm font-semibold truncate" style={{ color: INK }}>{l.productName}</div>
              <div className="text-sm font-bold tabular-nums" style={{ color: NAVY }}>{l.qtyCounted}</div>
            </div>
          ))}
        </div>
        <button onClick={() => setScreen('confirm1')} className="w-full rounded-lg py-3 text-sm font-bold" style={{ backgroundColor: GOLD, color: NAVY }}>
          Valider l'inventaire officiel
        </button>
      </div>
    );
  }

  // ── Count (default) ──
  return (
    <div className="space-y-3">
      <div className="rounded-xl p-3 flex items-center gap-3" style={{ backgroundColor: NAVY }}>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.18)' }}>
          <div className="h-full rounded-full" style={{ width: `${lines.length ? Math.round((countedCount / lines.length) * 100) : 0}%`, backgroundColor: GOLD }} />
        </div>
        <div className="text-xs font-bold whitespace-nowrap" style={{ color: GOLD_LIGHT }}>{countedCount}/{lines.length}</div>
      </div>
      <div className="space-y-1.5">
        {lines.map(l => (
          <div key={l.sku} className="flex items-center gap-2.5 rounded-xl p-2" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}` }}>
            {l.imageUrl ? (
              <img src={thumb(l.imageUrl, 96)} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
            ) : (
              <div className="w-12 h-12 rounded-lg shrink-0 flex items-center justify-center text-white text-[11px] font-bold"
                style={{ background: `linear-gradient(135deg, ${GOLD}, #8A6B22)` }}>
                {l.productName.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold truncate" style={{ color: INK }}>{l.productName}</div>
              <div className="text-[11px] truncate" style={{ color: '#8A9A8F' }}>{l.sku}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => { const q = Math.max(0, l.qtyCounted - 1); updateLocalQty(l.sku, q); commitQty(l.sku, q); }}
                className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ border: `1px solid ${BORDER}` }}>
                <Minus size={14} style={{ color: NAVY }} />
              </button>
              <div className="min-w-[22px] text-center text-sm font-bold tabular-nums" style={{ color: NAVY }}>
                {savingSku === l.sku ? <Loader2 size={12} className="animate-spin inline" /> : l.qtyCounted}
              </div>
              <button onClick={() => { const q = l.qtyCounted + 1; updateLocalQty(l.sku, q); commitQty(l.sku, q); }}
                className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ border: `1px solid ${BORDER}` }}>
                <Plus size={14} style={{ color: NAVY }} />
              </button>
            </div>
            {l.qtyCounted > 0 && <CheckCircle2 size={16} style={{ color: GREEN }} className="shrink-0" />}
          </div>
        ))}
      </div>
      <button onClick={() => setScreen('recap')} className="w-full rounded-lg py-3 text-sm font-bold text-white" style={{ backgroundColor: NAVY }}>
        Xem tổng kết
      </button>
    </div>
  );
}
