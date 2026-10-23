'use client';
// Products a shop received that were on NO delivery slip (Axel, 2026-10-16) — Lab side, on top of
// the Delivery gaps page. One card per declared product: photo, the shop's note, a suggested
// customer order (same product delivered that day or the day before), and three causes:
//   customer_order : customer not charged (return + invoice back to draft) + the shop gets them
//   lab_extra      : the shop gets them only
// "The shop gets them" = a new adjustment REP closed automatically (REP shops), or a new line on
// the SO it was received with (Moon Flower) — so they show in Axel's REP / SO exports.
//   shop_error     : nothing in Odoo
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { PackagePlus, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getOffslipItemsAction, settleOffslipAction, type OffslipRow } from './actions';

type Cause = 'customer_order' | 'lab_extra' | 'shop_error';

// mode 'open' sits above the tabs (to settle); mode 'closed' sits in the « Clôturés » tab (Axel, 16/10).
export default function OffslipPanel({ mode = 'open' }: { mode?: 'open' | 'closed' }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const T = (v: string, f: string) => (vi ? v : f);
  const [rows, setRows] = useState<OffslipRow[] | null>(null);
  const [canSend, setCanSend] = useState(false);
  const [sel, setSel] = useState<Record<string, { cause: Cause | null; ref: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [zoom, setZoom] = useState<string | null>(null);

  const load = async () => {
    const r = await getOffslipItemsAction();
    if (r.items) {
      setRows(r.items); setCanSend(!!r.canSendOdoo);
      setSel(prev => {
        const n = { ...prev };
        for (const i of r.items!) if (!n[i.id]) n[i.id] = { cause: i.suggestions.length ? 'customer_order' : null, ref: i.suggestions[0]?.orderRef ?? '' };
        return n;
      });
    }
  };
  useEffect(() => { load(); }, []);

  if (!rows || !rows.length) return null;
  const open = rows.filter(r => r.status === 'open');
  const closed = rows.filter(r => r.status === 'closed');
  if (mode === 'open' && !open.length) return null;
  if (mode === 'closed' && !closed.length) return null;
  const showClosed = mode === 'closed';

  async function settle(r: OffslipRow) {
    const s = sel[r.id];
    if (!s?.cause) return;
    setBusy(r.id);
    const res = await settleOffslipAction({ id: r.id, cause: s.cause, sourceOrderRef: s.cause === 'customer_order' ? s.ref : null });
    setBusy(null);
    setMsg(m => ({ ...m, [r.id]: res.ok ? { ok: true, text: (res.done ?? []).join(' · ') || T('Xong', 'Fait') } : { ok: false, text: `${res.error}${res.done?.length ? ` — ${T('đã làm', 'déjà fait')}: ${res.done.join(' · ')}` : ''}` } }));
    if (res.ok) load();
  }

  const toShop = (r: OffslipRow) => r.orderRef && !r.orderRef.startsWith('REP')
    ? T(`xuất +${r.qty} từ Lab; thêm vào hoá đơn của ${r.orderRef} nếu chưa xuất VAT, nếu đã có VAT thì tạo đơn nhỏ riêng`, `sortie Lab +${r.qty} ; ajoutée à la facture de ${r.orderRef} si pas encore de VAT, sinon petite vente séparée`)
    : T(`tạo REP điều chỉnh +${r.qty} (xuất + nhận đã xác nhận, đóng REP)`, `nouvelle REP d'ajustement +${r.qty} (envoi + réception validés, REP clôturée)`);
  const causes: { k: Cause; t: string; d: (r: OffslipRow) => string }[] = [
    { k: 'customer_order', t: T('Đơn của khách, giao nhầm chỗ', "Commande d'un client, livrée au mauvais endroit"),
      d: r => T(`Odoo: trả hàng ${r.qty} trên phiếu giao của đơn → hoá đơn về nháp, bớt ${r.qty} → ${toShop(r)}. Khách không bị tính tiền, shop giữ bánh.`,
        `Odoo : retour de ${r.qty} sur la livraison de la commande → facture remise en brouillon sans ces ${r.qty} (la compta la reposte) → ${toShop(r)}. Le client n'est pas facturé, le shop garde les gâteaux.`) },
    { k: 'lab_extra', t: T('Lab gửi dư / không rõ nguồn', 'Envoyé en trop par le Lab / origine inconnue'),
      d: r => r.orderRef && !r.orderRef.startsWith('REP') ? T(`Odoo: ${toShop(r)}.`, `Odoo : ${toShop(r)}.`) : T(`Odoo: ${toShop(r)}. Không đụng hoá đơn.`, `Odoo : ${toShop(r)}. Aucune facture touchée.`) },
    { k: 'shop_error', t: T('Shop nhầm (không có hàng thừa)', 'Erreur du shop (rien en plus)'),
      d: () => T('Không làm gì trên Odoo.', 'Rien dans Odoo.') },
  ];

  return (
    <section className="bg-white rounded-2xl p-4 sm:p-5 space-y-3" style={{ border: '1.5px solid #C9A84C' }}>
      <div className="flex items-center gap-2">
        <PackagePlus size={18} style={{ color: '#8A6D14' }} />
        <h2 className="text-base font-bold text-navy flex-1">{T('Hàng ngoài phiếu', 'Produits hors livraison')} · {mode === 'closed' ? `${T('đã xử lý', 'réglés')} · ${closed.length}` : open.length}</h2>
      </div>
      {mode === 'open' && <p className="text-xs text-ink-light">{T('Shop nhận được sản phẩm không có trên phiếu nào. Shop giữ lại; chọn nguyên nhân để cập nhật Odoo.', "Le shop a reçu un produit qui n'est sur aucun bon. Il le garde ; choisir la cause pour mettre Odoo à jour.")}</p>}

      {mode === 'open' && open.map(r => {
        const s = sel[r.id] ?? { cause: null, ref: '' };
        const partial = !!r.decidedAt; // claimed but not closed: something failed mid-way
        return (
          <div key={r.id} className="rounded-xl p-3.5 space-y-3" style={{ border: `1px solid ${r.overdue ? '#FCA5A5' : '#E5E7EB'}`, backgroundColor: r.overdue ? '#FEF2F2' : undefined }}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex gap-1.5">
                {r.photoUrls.map(u => (
                  <button key={u} type="button" onClick={() => setZoom(u)} className="w-16 h-16 rounded-lg overflow-hidden" style={{ border: '1px solid #E5E7EB' }} aria-label={T('Xem ảnh', 'Voir la photo')}>
                    <img src={u} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold">{r.productName} <span className="font-semibold" style={{ color: '#8A6D14' }}>+{r.qty}</span></div>
                <div className="text-xs text-ink-light">{r.shopName} · {T('nhận cùng', 'reçu avec')} {r.orderRef} · {r.deliveryDate.slice(8, 10)}/{r.deliveryDate.slice(5, 7)} · {r.declaredBy}</div>
                {r.note && <div className="text-xs mt-0.5" style={{ color: '#374151' }}>“{r.note}”</div>}
                {r.overdue && <div className="text-[11px] font-bold mt-0.5" style={{ color: '#B91C1C' }}>{T('Quá 48h', 'Plus de 48 h')}</div>}
              </div>
            </div>

            {r.suggestions.length > 0 && (
              <div className="rounded-lg px-3 py-2 text-xs" style={{ backgroundColor: '#FFFAEE', border: '1px solid #E0D49A' }}>
                <b style={{ color: '#8A6D14' }}>{T('Gợi ý', 'Piste trouvée')} :</b>{' '}
                {r.suggestions.map(x => `${x.orderRef} · ${x.customer} · ${x.qty} (${x.deliveryDate.slice(8, 10)}/${x.deliveryDate.slice(5, 7)})`).join(' — ')}
              </div>
            )}

            {partial ? (
              <div className="text-xs rounded-lg px-3 py-2 flex items-start gap-2" style={{ backgroundColor: '#FEF2F2', color: '#991B1B' }}>
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{T('Gửi Odoo bị dừng giữa chừng — kiểm tra Odoo rồi báo Axel.', "L'envoi Odoo s'est arrêté en cours — vérifier Odoo puis prévenir Axel.")} {r.odooLog?.error ?? ''} {r.odooLog?.done?.length ? `(${r.odooLog.done.join(' · ')})` : ''}</span>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  {causes.map(c => {
                    const on = s.cause === c.k;
                    return (
                      <label key={c.k} className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 cursor-pointer" style={{ border: `${on ? 2 : 1}px solid ${on ? '#1A4731' : '#E5E7EB'}` }}>
                        <input type="radio" name={`c-${r.id}`} checked={on} onChange={() => setSel(m => ({ ...m, [r.id]: { ...s, cause: c.k } }))} className="mt-1" />
                        <span className="flex-1">
                          <span className="block text-sm font-bold">{c.t}</span>
                          {c.k === 'customer_order' && on && (
                            <span className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
                              {T('Đơn', 'Commande')} :
                              {r.suggestions.length > 0 ? (
                                <select value={s.ref} onChange={e => setSel(m => ({ ...m, [r.id]: { ...s, ref: e.target.value } }))} className="rounded-md px-2 py-1 font-semibold" style={{ border: '1px solid #D1D5DB' }}>
                                  {r.suggestions.map(x => <option key={x.orderRef} value={x.orderRef}>{x.orderRef} · {x.customer} · {x.qty}</option>)}
                                  <option value="">{T('Khác…', 'Autre…')}</option>
                                </select>
                              ) : null}
                              {(!r.suggestions.length || !s.ref || !r.suggestions.some(x => x.orderRef === s.ref)) && (
                                <input value={s.ref} onChange={e => setSel(m => ({ ...m, [r.id]: { ...s, ref: e.target.value.toUpperCase() } }))} placeholder="S0…" className="rounded-md px-2 py-1 w-28 font-mono" style={{ border: '1px solid #D1D5DB' }} />
                              )}
                            </span>
                          )}
                          <span className="block text-xs mt-1" style={{ color: '#6B7280' }}>{c.d(r)}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <button disabled={busy === r.id || !s.cause || (s.cause === 'customer_order' && !/^S\d+/.test(s.ref.trim())) || (s.cause !== 'shop_error' && !canSend)}
                    onClick={() => settle(r)} className="rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                    {busy === r.id ? <Loader2 size={14} className="animate-spin inline" /> : s.cause === 'shop_error' ? T('Xác nhận', 'Valider') : T('Xác nhận và gửi Odoo', 'Valider et envoyer à Odoo')}
                  </button>
                  {s.cause && s.cause !== 'shop_error' && !canSend && <span className="text-xs text-ink-light">{T('Chỉ Trish / admin gửi được Odoo.', 'Seuls Trish / un admin peuvent envoyer à Odoo.')}</span>}
                </div>
              </>
            )}
            {msg[r.id] && <div className="text-xs rounded-lg px-3 py-2" style={{ backgroundColor: msg[r.id].ok ? '#ECFDF3' : '#FEF2F2', color: msg[r.id].ok ? '#067647' : '#991B1B' }}>{msg[r.id].text}</div>}
          </div>
        );
      })}

      {showClosed && closed.map(r => (
        <div key={r.id} className="rounded-xl px-3.5 py-2.5 flex flex-wrap items-center gap-2 text-xs" style={{ border: '1px solid #E5E7EB' }}>
          <CheckCircle2 size={14} style={{ color: '#067647' }} />
          <b className="text-sm">{r.productName} +{r.qty}</b>
          <span className="text-ink-light">{r.shopName} · {r.orderRef}</span>
          <span className="flex-1" />
          <span style={{ color: '#374151' }}>
            {r.labCause === 'customer_order' ? `${T('Đơn khách', 'Commande client')} ${r.sourceOrderRef}` : r.labCause === 'lab_extra' ? T('Lab gửi dư', 'Envoyé en trop') : T('Shop nhầm', 'Erreur shop')}
            {r.odooMode === 'simulated' ? ` · ${T('mô phỏng', 'simulé')}` : ''} · {r.decidedBy}
          </span>
          {Array.isArray(r.odooLog?.done) && r.odooLog.done.length > 0 && (
            <div className="w-full font-mono text-[11px] leading-relaxed rounded-lg px-2.5 py-1.5" style={{ backgroundColor: '#EEF3EF', color: '#374151' }}>
              {r.odooLog.done.map((d: string, k: number) => <div key={k}>{d}</div>)}
            </div>
          )}
        </div>
      ))}

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(0,0,0,.7)' }} onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-w-full max-h-full rounded-xl" />
        </div>
      )}
    </section>
  );
}
