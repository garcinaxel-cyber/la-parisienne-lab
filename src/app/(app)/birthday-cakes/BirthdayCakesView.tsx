'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Store, Clock, Truck, Save, CheckCircle2, FileText, MapPin, Plus, X, Trash2 } from 'lucide-react';

type Cake = {
  id: string; source: 'odoo' | 'manual'; manualId: string | null; needsOdoo: boolean;
  order_ref: string; name: string; shop: string | null;
  delivery_date: string; delivery_time: string | null; qty: number;
  message: string; ready_time: string; delivered_by: string; delivery_address: string;
};
type ProductChoice = { ficheId: string; variantId: string | null; sku: string | null; nameVi: string; nameEn: string; imageUrl: string | null; team: string };
type Edit = { message: string; ready_time: string; delivered_by: string; delivery_address: string };

const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];

export default function BirthdayCakesView({ cakes, productChoices = [], today }: { cakes: Cake[]; productChoices?: ProductChoice[]; today: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, Edit>>(() => {
    const s: Record<string, Edit> = {};
    for (const c of cakes) s[c.id] = { message: c.message, ready_time: c.ready_time, delivered_by: c.delivered_by, delivery_address: c.delivery_address };
    return s;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const upd = (id: string, patch: Partial<Edit>) => {
    setEdits(p => ({ ...p, [id]: { ...p[id], ...patch } }));
    setSaved(p => { const n = new Set(p); n.delete(id); return n; });
  };
  const dirty = (c: Cake) => {
    const e = edits[c.id];
    return e.message !== c.message || e.ready_time !== c.ready_time || e.delivered_by !== c.delivered_by || e.delivery_address !== c.delivery_address;
  };

  async function save(c: Cake) {
    setSaving(c.id);
    const e = edits[c.id];
    const a = await import('./actions');
    const res = c.source === 'manual' && c.manualId
      ? await a.updateManualCakeAction(c.manualId, { message: e.message || null, readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null, deliveryAddress: e.delivery_address || null })
      : await a.saveBirthdayDetailAction(c.id, { message: e.message || null, readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null, deliveryAddress: e.delivery_address || null });
    setSaving(null);
    if (res.ok) { c.message = e.message; c.ready_time = e.ready_time; c.delivered_by = e.delivered_by; c.delivery_address = e.delivery_address; setSaved(p => new Set(p).add(c.id)); }
  }

  async function markEntered(c: Cake) {
    if (!c.manualId) return;
    setBusy(c.id);
    const { markManualCakeEnteredAction } = await import('./actions');
    await markManualCakeEnteredAction(c.manualId, true);
    setBusy(null); router.refresh();
  }
  async function removeCake(c: Cake) {
    if (!c.manualId) return;
    setBusy(c.id);
    const { deleteManualCakeAction } = await import('./actions');
    await deleteManualCakeAction(c.manualId);
    setBusy(null); router.refresh();
  }

  // ── New manual cake modal ──
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState({ idx: '', qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '' });
  const chosen = form.idx !== '' ? productChoices[Number(form.idx)] : null;

  async function createCake() {
    if (!chosen) { setCreateErr(vi ? 'Chọn sản phẩm' : 'Choisis un produit'); return; }
    setCreating(true); setCreateErr(null);
    const { createManualCakeAction } = await import('./actions');
    const res = await createManualCakeAction({
      ficheId: chosen.ficheId, variantId: chosen.variantId, sku: chosen.sku,
      nameVi: chosen.nameVi, nameEn: chosen.nameEn, imageUrl: chosen.imageUrl, team: chosen.team,
      qty: Math.max(1, parseInt(form.qty, 10) || 1), deliveryDate: form.date,
      readyTime: form.readyTime || null, deliveredBy: form.deliveredBy || null, deliveryAddress: form.deliveryAddress || null,
      message: form.message || null, customerName: form.customerName || null, customerPhone: form.customerPhone || null,
    });
    setCreating(false);
    if (res.error) { setCreateErr(res.error); return; }
    setShowNew(false);
    setForm({ idx: '', qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '' });
    router.refresh();
  }

  // Group by delivery date
  const byDate = new Map<string, Cake[]>();
  for (const c of cakes) (byDate.get(c.delivery_date) ?? byDate.set(c.delivery_date, []).get(c.delivery_date)!).push(c);
  const dates = Array.from(byDate.keys()).sort();

  const shopColor = (shop: string | null) => {
    const s = (shop ?? '').toLowerCase();
    if (s.includes('moon')) return { bg: '#F5EAF7', fg: '#722A5A' };
    if (s.includes('paris')) return { bg: '#E1F5EE', fg: '#085041' };
    return { bg: '#E6F1FB', fg: '#0C447C' };
  };
  const toProduceInOdoo = cakes.filter(c => c.source === 'manual' && c.needsOdoo).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            🎂 {vi ? 'Bánh sinh nhật' : 'Birthday cakes'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi ? 'Đọc từ đơn Odoo · thêm lời chúc, giờ cần xong, giao đến và địa chỉ.' : 'Lu depuis Odoo · ajoute le message, l’heure, la destination et l’adresse.'}
          </p>
        </div>
        <button onClick={() => setShowNew(true)}
          className="px-4 py-2 rounded-xl font-bold text-white text-sm inline-flex items-center gap-1.5" style={{ backgroundColor: '#1A4731' }}>
          <Plus size={15} /> {vi ? 'Bánh mới' : 'Nouveau gâteau'}
        </button>
      </div>

      {toProduceInOdoo > 0 && (
        <div className="rounded-xl px-4 py-2.5 text-sm font-medium flex items-center gap-2" style={{ backgroundColor: '#FFFBEB', color: '#92600A', border: '1px solid #FCD34D' }}>
          <FileText size={16} className="shrink-0" />
          {toProduceInOdoo} {vi ? 'bánh cần nhập vào Odoo' : (toProduceInOdoo > 1 ? 'gâteaux à saisir dans Odoo' : 'gâteau à saisir dans Odoo')}
        </div>
      )}

      {cakes.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="font-semibold text-navy">{vi ? 'Chưa có bánh sinh nhật sắp tới' : 'No upcoming birthday cakes'}</p>
          <p className="text-sm text-ink-light mt-1">{vi ? 'Bánh thuộc danh mục « Birthday cake » sẽ hiện ở đây.' : 'Cakes in the “Birthday cake” category will appear here.'}</p>
        </div>
      ) : (
        dates.map(date => (
          <div key={date} className="space-y-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-light">
              {vi ? 'Giao' : 'Livraison'} {new Date(date + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
              <span className="text-xs font-normal">· {byDate.get(date)!.length} {vi ? 'bánh' : 'gâteaux'}</span>
            </div>
            {byDate.get(date)!.map(c => {
              const e = edits[c.id];
              const col = shopColor(c.shop);
              const manual = c.source === 'manual';
              return (
                <div key={c.id} className="card p-4" style={manual ? { border: '1.5px solid #C4B5FD' } : undefined}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold text-navy flex items-center gap-2 flex-wrap">
                        ×{c.qty} · {c.name}
                        {manual && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>{vi ? 'Thủ công' : 'Manuel'}</span>}
                        {manual && c.needsOdoo && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{vi ? 'Cần nhập Odoo' : 'À saisir dans Odoo'}</span>}
                      </div>
                      <div className="text-xs text-ink-light mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="inline-flex items-center gap-1"><FileText size={13} /> {c.order_ref}</span>
                        {c.delivery_time && <span className="inline-flex items-center gap-1"><Clock size={13} /> {vi ? 'giao' : 'livr.'} {c.delivery_time.slice(0, 5)}</span>}
                      </div>
                    </div>
                    {c.shop && (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1" style={{ backgroundColor: col.bg, color: col.fg }}>
                        <Store size={12} /> {c.shop}
                      </span>
                    )}
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-[130px_1fr] gap-2 items-center">
                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Clock size={13} className="text-blue-600" /> {vi ? 'Cần xong lúc' : 'Prêt à'}</label>
                    <input type="time" value={e.ready_time} onChange={ev => upd(c.id, { ready_time: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-32" style={{ border: '1px solid #D1D5DB' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><span className="text-blue-600">✎</span> {vi ? 'Lời chúc' : 'Message'}</label>
                    <input type="text" value={e.message} onChange={ev => upd(c.id, { message: ev.target.value })}
                      placeholder={vi ? 'Chữ trên bánh…' : 'Texte sur le gâteau…'}
                      className="rounded-lg px-2 py-1.5 text-sm w-full" style={{ border: '1px solid', borderColor: '#93C5FD' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Truck size={13} className="text-blue-600" /> {vi ? 'Giao đến' : 'Livrer à'}</label>
                    <select value={e.delivered_by} onChange={ev => upd(c.id, { delivered_by: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-48" style={{ border: '1px solid #D1D5DB', backgroundColor: 'white' }}>
                      <option value="">{vi ? '— Chọn —' : '— Choisir —'}</option>
                      {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><MapPin size={13} className="text-blue-600" /> {vi ? 'Địa chỉ giao' : 'Adresse de livraison'}</label>
                    <input type="text" value={e.delivery_address} onChange={ev => upd(c.id, { delivery_address: ev.target.value })}
                      placeholder={vi ? 'Địa chỉ giao đến khách…' : 'Adresse de livraison client…'}
                      className="rounded-lg px-2 py-1.5 text-sm w-full" style={{ border: '1px solid #D1D5DB' }} />
                  </div>

                  <div className="mt-3 flex items-center justify-end gap-2 flex-wrap">
                    {manual && (
                      <button onClick={() => removeCake(c)} disabled={busy === c.id}
                        className="px-2.5 py-2 rounded-xl text-sm text-red-600 border border-red-200 inline-flex items-center gap-1 disabled:opacity-40">
                        <Trash2 size={14} />
                      </button>
                    )}
                    {manual && c.needsOdoo && (
                      <button onClick={() => markEntered(c)} disabled={busy === c.id}
                        className="px-3 py-2 rounded-xl text-sm font-semibold border inline-flex items-center gap-1.5 disabled:opacity-40" style={{ borderColor: '#C9A84C', color: '#92600A' }}>
                        <CheckCircle2 size={14} /> {busy === c.id ? '…' : (vi ? 'Đã nhập Odoo' : 'Saisi dans Odoo')}
                      </button>
                    )}
                    {saved.has(c.id) && <span className="text-xs text-green-600 inline-flex items-center gap-1"><CheckCircle2 size={14} /> {vi ? 'Đã lưu' : 'Enregistré'}</span>}
                    <button onClick={() => save(c)} disabled={saving === c.id || !dirty(c)}
                      className="px-4 py-2 rounded-xl font-bold text-white text-sm disabled:opacity-40 inline-flex items-center gap-1.5"
                      style={{ backgroundColor: '#1A4731' }}>
                      <Save size={14} /> {saving === c.id ? '…' : (vi ? 'Lưu' : 'Enregistrer')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      {showNew && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-navy text-lg">{vi ? 'Bánh sinh nhật mới' : 'Nouveau gâteau'}</h2>
              <button onClick={() => setShowNew(false)} className="p-1 text-ink-light"><X size={18} /></button>
            </div>

            <label className="text-xs font-semibold text-ink-light block">{vi ? 'Sản phẩm' : 'Produit'}</label>
            <select value={form.idx} onChange={ev => setForm(f => ({ ...f, idx: ev.target.value }))}
              className="w-full rounded-lg px-2 py-2 text-sm" style={{ border: '1px solid #D1D5DB' }}>
              <option value="">{vi ? '— Chọn bánh —' : '— Choisir un gâteau —'}</option>
              {productChoices.map((p, i) => <option key={p.ficheId} value={i}>{p.nameVi}</option>)}
            </select>
            {chosen && !['baby_mama', 'hung', 'entremet', 'baker'].includes(chosen.team) && (
              <p className="text-xs text-red-600">{vi ? 'Sản phẩm chưa có đội — hoàn thiện phiếu kỹ thuật.' : 'Produit sans équipe — complète la fiche technique.'}</p>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Số lượng' : 'Quantité'}</label>
                <input type="number" min={1} value={form.qty} onChange={ev => setForm(f => ({ ...f, qty: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Ngày giao' : 'Date livraison'}</label>
                <input type="date" value={form.date} onChange={ev => setForm(f => ({ ...f, date: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Cần xong lúc' : 'Prêt à'}</label>
                <input type="time" value={form.readyTime} onChange={ev => setForm(f => ({ ...f, readyTime: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Giao đến' : 'Livrer à'}</label>
                <select value={form.deliveredBy} onChange={ev => setForm(f => ({ ...f, deliveredBy: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB', backgroundColor: 'white' }}>
                  <option value="">{vi ? '— Chọn —' : '— Choisir —'}</option>
                  {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-ink-light block">{vi ? 'Địa chỉ giao' : 'Adresse de livraison'}</label>
              <input type="text" value={form.deliveryAddress} onChange={ev => setForm(f => ({ ...f, deliveryAddress: ev.target.value }))} placeholder={vi ? 'Địa chỉ khách…' : 'Adresse client…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink-light block">{vi ? 'Lời chúc' : 'Message'}</label>
              <input type="text" value={form.message} onChange={ev => setForm(f => ({ ...f, message: ev.target.value }))} placeholder={vi ? 'Chữ trên bánh…' : 'Texte sur le gâteau…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #93C5FD' }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Khách hàng' : 'Client'}</label>
                <input type="text" value={form.customerName} onChange={ev => setForm(f => ({ ...f, customerName: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'SĐT' : 'Téléphone'}</label>
                <input type="text" value={form.customerPhone} onChange={ev => setForm(f => ({ ...f, customerPhone: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
            </div>

            {createErr && <p className="text-xs text-red-600">{createErr}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowNew(false)} className="flex-1 py-2.5 rounded-xl font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Annuler'}</button>
              <button onClick={createCake} disabled={creating || !chosen} className="flex-1 py-2.5 rounded-xl font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                {creating ? '…' : (vi ? 'Tạo bánh' : 'Créer le gâteau')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
