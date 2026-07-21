'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Store, Clock, Truck, Save, CheckCircle2, FileText, MapPin, Plus, X, Trash2, Search } from 'lucide-react';

type Cake = {
  id: string; source: 'odoo' | 'manual'; manualId: string | null; needsOdoo: boolean;
  suggestedRef?: string | null; suggestedShop?: string | null; sku?: string | null;
  order_ref: string; name: string; shop: string | null;
  delivery_date: string; delivery_time: string | null; qty: number;
  message: string; ready_time: string; delivered_by: string; delivery_address: string;
};
type ProductChoice = { ficheId: string; variantId: string | null; sku: string | null; nameVi: string; nameEn: string; imageUrl: string | null; team: string };
type Edit = { message: string; ready_time: string; delivered_by: string; delivery_address: string };

const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];
const TEAMS = ['baby_mama', 'hung', 'entremet', 'baker'];

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

  // Seed edit state for any cake not yet known (e.g. a freshly created manual cake after refresh),
  // otherwise edits[c.id] is undefined and the render would crash.
  useEffect(() => {
    setEdits(prev => {
      let changed = false;
      const next = { ...prev };
      for (const c of cakes) if (!next[c.id]) { next[c.id] = { message: c.message, ready_time: c.ready_time, delivered_by: c.delivered_by, delivery_address: c.delivery_address }; changed = true; }
      return changed ? next : prev;
    });
  }, [cakes]);

  const upd = (id: string, patch: Partial<Edit>) => {
    setEdits(p => ({ ...p, [id]: { ...p[id], ...patch } }));
    setSaved(p => { const n = new Set(p); n.delete(id); return n; });
  };
  // A freshly created cake isn't in `edits` until the seeding effect runs (post-render) — always
  // fall back to the cake's own values so render-time reads never crash.
  const editFor = (c: Cake): Edit => edits[c.id] ?? { message: c.message, ready_time: c.ready_time, delivered_by: c.delivered_by, delivery_address: c.delivery_address };
  const dirty = (c: Cake) => {
    const e = editFor(c);
    return e.message !== c.message || e.ready_time !== c.ready_time || e.delivered_by !== c.delivered_by || e.delivery_address !== c.delivery_address;
  };

  async function save(c: Cake) {
    setSaving(c.id);
    const e = editFor(c);
    const a = await import('./actions');
    const res = c.source === 'manual' && c.manualId
      ? await a.updateManualCakeAction(c.manualId, { message: e.message || null, readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null, deliveryAddress: e.delivery_address || null })
      : await a.saveBirthdayDetailAction(c.id, { message: e.message || null, readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null, deliveryAddress: e.delivery_address || null });
    setSaving(null);
    if (res.ok) { c.message = e.message; c.ready_time = e.ready_time; c.delivered_by = e.delivered_by; c.delivery_address = e.delivery_address; setSaved(p => new Set(p).add(c.id)); }
  }

  async function removeCake(c: Cake) {
    if (!c.manualId) return;
    setBusy(c.id);
    const { deleteManualCakeAction } = await import('./actions');
    await deleteManualCakeAction(c.manualId);
    setBusy(null); router.refresh();
  }
  async function confirmMatch(c: Cake) {
    if (!c.manualId || !c.suggestedRef) return;
    setBusy(c.id);
    const { confirmMatchAction } = await import('./actions');
    await confirmMatchAction(c.manualId, c.suggestedRef, c.sku ?? undefined);
    setBusy(null); router.refresh();
  }
  async function rejectMatch(c: Cake) {
    if (!c.manualId || !c.suggestedRef) return;
    setBusy(c.id);
    const { rejectMatchAction } = await import('./actions');
    await rejectMatchAction(c.manualId, c.suggestedRef);
    setBusy(null); router.refresh();
  }

  // Manual link: pick an Odoo order to link this manual cake to (fallback when auto-detect misses)
  const [linkFor, setLinkFor] = useState<Cake | null>(null);
  const odooCandidates = cakes.filter(c => c.source === 'odoo');
  async function doManualLink(target: Cake) {
    if (!linkFor?.manualId || !target.order_ref) return;
    setBusy(linkFor.id);
    const { confirmMatchAction } = await import('./actions');
    await confirmMatchAction(linkFor.manualId, target.order_ref, target.sku ?? undefined);
    setLinkFor(null); setBusy(null); router.refresh();
  }

  // ── New manual cake modal ──
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<ProductChoice | null>(null);
  const [form, setForm] = useState({ qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '', notes: '' });

  const filtered = query.trim().length === 0
    ? productChoices.slice(0, 8)
    : productChoices.filter(p => (p.nameVi + ' ' + p.nameEn).toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);

  function resetModal() {
    setShowNew(false); setCreating(false); setCreateErr(null); setQuery(''); setChosen(null);
    setForm({ qty: '1', date: today, readyTime: '', deliveredBy: '', deliveryAddress: '', message: '', customerName: '', customerPhone: '', notes: '' });
  }

  async function createCake() {
    if (!chosen) { setCreateErr(vi ? 'Chọn sản phẩm' : 'Choose a product'); return; }
    setCreating(true); setCreateErr(null);
    const { createManualCakeAction } = await import('./actions');
    const res = await createManualCakeAction({
      ficheId: chosen.ficheId, variantId: chosen.variantId, sku: chosen.sku,
      nameVi: chosen.nameVi, nameEn: chosen.nameEn, imageUrl: chosen.imageUrl, team: chosen.team,
      qty: Math.max(1, parseInt(form.qty, 10) || 1), deliveryDate: form.date,
      readyTime: form.readyTime || null, deliveredBy: form.deliveredBy || null, deliveryAddress: form.deliveryAddress || null,
      message: form.message || null, customerName: form.customerName.trim() || null, customerPhone: form.customerPhone.trim() || null,
      notes: form.notes.trim() || null,
    });
    setCreating(false);
    if (res.error) { setCreateErr(res.error); return; }
    resetModal();
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
  const toEnter = cakes.filter(c => c.source === 'manual' && c.needsOdoo).length;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
            🎂 {vi ? 'Bánh sinh nhật' : 'Birthday cakes'}
          </h1>
          <p className="text-ink-light text-sm mt-0.5">
            {vi ? 'Đọc từ đơn Odoo · thêm lời chúc, giờ cần xong, giao đến và địa chỉ.' : 'Read from Odoo · add the message, ready time, destination and address.'}
          </p>
        </div>
        <button onClick={() => setShowNew(true)}
          className="px-4 py-2 rounded-xl font-bold text-white text-sm inline-flex items-center gap-1.5" style={{ backgroundColor: '#1A4731' }}>
          <Plus size={15} /> {vi ? 'Bánh mới' : 'New cake'}
        </button>
      </div>

      {toEnter > 0 && (
        <div className="rounded-xl px-4 py-2.5 text-sm font-medium flex items-center gap-2" style={{ backgroundColor: '#FFFBEB', color: '#92600A', border: '1px solid #FCD34D' }}>
          <FileText size={16} className="shrink-0" />
          {toEnter} {vi ? 'bánh cần nhập vào Odoo' : (toEnter > 1 ? 'cakes to enter in Odoo' : 'cake to enter in Odoo')}
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
              {vi ? 'Giao' : 'Delivery'} {new Date(date + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
              <span className="text-xs font-normal">· {byDate.get(date)!.length} {vi ? 'bánh' : 'cakes'}</span>
            </div>
            {byDate.get(date)!.map(c => {
              // Fallback prevents a crash on the first render after a new cake appears (before the
              // seeding effect runs).
              const e = editFor(c);
              const col = shopColor(c.shop);
              const manual = c.source === 'manual';
              return (
                <div key={c.id} className="card p-4" style={manual ? { border: '1.5px solid #C4B5FD' } : undefined}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold text-navy flex items-center gap-2 flex-wrap">
                        ×{c.qty} · {c.name}
                        {manual && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#EDE9FE', color: '#6D28D9' }}>{vi ? 'Thủ công' : 'Manual'}</span>}
                        {manual && c.needsOdoo && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ backgroundColor: '#FEF3C7', color: '#92600A' }}>{vi ? 'Cần nhập Odoo' : 'To enter in Odoo'}</span>}
                      </div>
                      {c.order_ref && (
                        <div className="text-xs text-ink-light mt-0.5 flex items-center gap-3 flex-wrap">
                          <span className="inline-flex items-center gap-1"><FileText size={13} /> {c.order_ref}</span>
                          {c.delivery_time && <span className="inline-flex items-center gap-1"><Clock size={13} /> {vi ? 'giao' : 'delivery'} {c.delivery_time.slice(0, 5)}</span>}
                        </div>
                      )}
                    </div>
                    {c.shop && (
                      <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1" style={{ backgroundColor: col.bg, color: col.fg }}>
                        <Store size={12} /> {c.shop}
                      </span>
                    )}
                  </div>

                  {manual && c.needsOdoo && c.suggestedRef && (
                    <div className="mt-3 rounded-xl px-3 py-2.5 flex items-center gap-2 flex-wrap" style={{ backgroundColor: '#EFF6FF', border: '1px solid #93C5FD' }}>
                      <FileText size={15} style={{ color: '#1E40AF' }} className="shrink-0" />
                      <span className="text-xs flex-1" style={{ color: '#1E40AF' }}>
                        {vi ? 'Đơn Odoo' : 'Odoo order'} <span className="font-mono font-bold">{c.suggestedRef}</span>{c.suggestedShop ? ` · ${c.suggestedShop}` : ''} — {vi ? 'là bánh này?' : 'is this cake?'}
                      </span>
                      <button onClick={() => confirmMatch(c)} disabled={busy === c.id}
                        className="text-xs font-bold px-3 py-1.5 rounded-full text-white inline-flex items-center gap-1 disabled:opacity-40" style={{ backgroundColor: '#1E40AF' }}>
                        <CheckCircle2 size={13} /> {busy === c.id ? '…' : (vi ? 'Xác nhận' : 'Confirm')}
                      </button>
                      <button onClick={() => rejectMatch(c)} disabled={busy === c.id}
                        className="text-xs font-semibold px-3 py-1.5 rounded-full border inline-flex items-center gap-1 disabled:opacity-40" style={{ borderColor: '#93C5FD', color: '#1E40AF' }}>
                        {busy === c.id ? '…' : (vi ? 'Không phải' : 'Not this one')}
                      </button>
                    </div>
                  )}

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-[130px_1fr] gap-2 items-center">
                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Clock size={13} className="text-blue-600" /> {vi ? 'Cần xong lúc' : 'Ready by'}</label>
                    <input type="time" value={e.ready_time} onChange={ev => upd(c.id, { ready_time: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-32" style={{ border: '1px solid #D1D5DB' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><span className="text-blue-600">✎</span> {vi ? 'Lời chúc' : 'Message'}</label>
                    <input type="text" value={e.message} onChange={ev => upd(c.id, { message: ev.target.value })}
                      placeholder={vi ? 'Chữ trên bánh…' : 'Text on the cake…'}
                      className="rounded-lg px-2 py-1.5 text-sm w-full" style={{ border: '1px solid', borderColor: '#93C5FD' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Truck size={13} className="text-blue-600" /> {vi ? 'Giao đến' : 'Deliver to'}</label>
                    <select value={e.delivered_by} onChange={ev => upd(c.id, { delivered_by: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-48" style={{ border: '1px solid #D1D5DB', backgroundColor: 'white' }}>
                      <option value="">{vi ? '— Chọn —' : '— Select —'}</option>
                      {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><MapPin size={13} className="text-blue-600" /> {vi ? 'Địa chỉ giao' : 'Delivery address'}</label>
                    <input type="text" value={e.delivery_address} onChange={ev => upd(c.id, { delivery_address: ev.target.value })}
                      placeholder={vi ? 'Địa chỉ giao đến khách…' : 'Customer delivery address…'}
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
                      <button onClick={() => setLinkFor(c)} disabled={busy === c.id}
                        className="px-3 py-2 rounded-xl text-sm font-semibold border inline-flex items-center gap-1.5 disabled:opacity-40" style={{ borderColor: '#93C5FD', color: '#1E40AF' }}>
                        <FileText size={14} /> {vi ? 'Liên kết đơn Odoo' : 'Link Odoo order'}
                      </button>
                    )}
                    {/* "Mark as entered in Odoo" button removed — it only cleared the flag without
                        linking and caused accidental mis-clicks. Cakes clear via the auto-match /
                        "Link Odoo order" flow instead. */}
                    {saved.has(c.id) && <span className="text-xs text-green-600 inline-flex items-center gap-1"><CheckCircle2 size={14} /> {vi ? 'Đã lưu' : 'Saved'}</span>}
                    <button onClick={() => save(c)} disabled={saving === c.id || !dirty(c)}
                      className="px-4 py-2 rounded-xl font-bold text-white text-sm disabled:opacity-40 inline-flex items-center gap-1.5"
                      style={{ backgroundColor: '#1A4731' }}>
                      <Save size={14} /> {saving === c.id ? '…' : (vi ? 'Lưu' : 'Save')}
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
          onClick={resetModal}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-navy text-lg">{vi ? 'Bánh sinh nhật mới' : 'New cake'}</h2>
              <button onClick={resetModal} className="p-1 text-ink-light"><X size={18} /></button>
            </div>

            <label className="text-xs font-semibold text-ink-light block">{vi ? 'Sản phẩm' : 'Product'}</label>
            {chosen ? (
              <div className="flex items-center gap-3 rounded-xl p-2.5" style={{ backgroundColor: '#F0F9F4', border: '1.5px solid #2D6A4F' }}>
                {chosen.imageUrl
                  ? <img src={chosen.imageUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                  : <div className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FFF4CC' }}>🎂</div>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: '#1A4731' }}>{chosen.nameVi}</div>
                  {chosen.sku && <div className="text-[10px] font-mono text-ink-light">{chosen.sku}</div>}
                </div>
                <button onClick={() => { setChosen(null); setQuery(''); }} className="p-1 text-ink-light"><X size={16} /></button>
              </div>
            ) : (
              <div>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
                  <input value={query} onChange={ev => setQuery(ev.target.value)} autoFocus
                    placeholder={vi ? 'Tìm bánh…' : 'Search a cake…'}
                    className="w-full rounded-lg pl-9 pr-3 py-2 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                </div>
                {filtered.length > 0 && (
                  <div className="mt-2 rounded-lg" style={{ border: '1px solid #E5E7EB', maxHeight: '52vh', overflowY: 'auto' }}>
                    {filtered.map((p, i) => (
                      <button key={p.variantId ?? p.ficheId} onClick={() => setChosen(p)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-green-50" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                        {p.imageUrl
                          ? <img src={p.imageUrl} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                          : <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-sm" style={{ backgroundColor: '#FFF4CC' }}>🎂</div>}
                        <span className="flex-1 min-w-0 text-sm font-medium truncate" style={{ color: '#1A4731' }}>{p.nameVi || p.nameEn || p.sku || '—'}</span>
                        {p.sku && <span className="text-[10px] font-mono text-ink-light shrink-0">{p.sku}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {query.trim() && filtered.length === 0 && (
                  <p className="text-xs text-ink-light text-center py-2">{vi ? 'Không tìm thấy' : 'No match'}</p>
                )}
              </div>
            )}
            {chosen && !TEAMS.includes(chosen.team) && (
              <p className="text-xs text-red-600">{vi ? 'Sản phẩm chưa có đội — hoàn thiện phiếu kỹ thuật.' : 'Product has no team — complete the recipe card.'}</p>
            )}

            {chosen && (<>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Số lượng' : 'Quantity'}</label>
                <input type="number" min={1} value={form.qty} onChange={ev => setForm(f => ({ ...f, qty: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Ngày giao' : 'Delivery date'}</label>
                <input type="date" value={form.date} onChange={ev => setForm(f => ({ ...f, date: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Cần xong lúc' : 'Ready by'}</label>
                <input type="time" value={form.readyTime} onChange={ev => setForm(f => ({ ...f, readyTime: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Giao đến' : 'Deliver to'}</label>
                <select value={form.deliveredBy} onChange={ev => setForm(f => ({ ...f, deliveredBy: ev.target.value }))} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB', backgroundColor: 'white' }}>
                  <option value="">{vi ? '— Chọn —' : '— Select —'}</option>
                  {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-ink-light block">{vi ? 'Địa chỉ giao' : 'Delivery address'}</label>
              <input type="text" value={form.deliveryAddress} onChange={ev => setForm(f => ({ ...f, deliveryAddress: ev.target.value }))} placeholder={vi ? 'Địa chỉ khách…' : 'Customer address…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
            </div>
            <div>
              <label className="text-xs font-semibold text-ink-light block">{vi ? 'Lời chúc' : 'Message'}</label>
              <input type="text" value={form.message} onChange={ev => setForm(f => ({ ...f, message: ev.target.value }))} placeholder={vi ? 'Chữ trên bánh…' : 'Text on the cake…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #93C5FD' }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'Tên khách' : 'Customer name'}</label>
                <input type="text" value={form.customerName} onChange={ev => setForm(f => ({ ...f, customerName: ev.target.value }))} placeholder={vi ? 'Tên khách hàng…' : 'Customer…'} className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink-light block">{vi ? 'SĐT khách' : 'Customer phone'}</label>
                <input type="tel" value={form.customerPhone} onChange={ev => setForm(f => ({ ...f, customerPhone: ev.target.value }))} placeholder="090…" className="w-full rounded-lg px-2 py-1.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
              </div>
            </div>
            <div>
              <label className="text-xs font-semibold text-ink-light block">{vi ? 'Ghi chú' : 'Free note'}</label>
              <textarea value={form.notes} onChange={ev => setForm(f => ({ ...f, notes: ev.target.value }))} rows={2} placeholder={vi ? 'Ghi chú thêm…' : 'Anything useful…'} className="w-full rounded-lg px-2 py-1.5 text-sm resize-none" style={{ border: '1px solid #D1D5DB' }} />
            </div>
            </>)}

            {createErr && <p className="text-xs text-red-600">{createErr}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={resetModal} className="flex-1 py-2.5 rounded-xl font-semibold border border-gray-200 text-gray-500">{vi ? 'Hủy' : 'Cancel'}</button>
              <button onClick={createCake} disabled={creating || !chosen} className="flex-1 py-2.5 rounded-xl font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#1A4731' }}>
                {creating ? '…' : (vi ? 'Tạo bánh' : 'Create cake')}
              </button>
            </div>
          </div>
        </div>
      )}

      {linkFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => setLinkFor(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-3" style={{ maxHeight: '90vh', overflowY: 'auto' }} onClick={ev => ev.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-navy text-lg">{vi ? 'Liên kết đơn Odoo' : 'Link to an Odoo order'}</h2>
              <button onClick={() => setLinkFor(null)} className="p-1 text-ink-light"><X size={18} /></button>
            </div>
            <p className="text-xs text-ink-light">{vi ? 'Chọn đơn Odoo tương ứng với' : 'Pick the Odoo order that matches'} <span className="font-semibold text-navy">{linkFor.name}</span>.</p>
            {odooCandidates.length === 0 ? (
              <p className="text-sm text-ink-light text-center py-4">{vi ? 'Không có đơn Odoo nào' : 'No Odoo birthday-cake orders yet'}</p>
            ) : (
              <div className="rounded-lg" style={{ border: '1px solid #E5E7EB', maxHeight: '55vh', overflowY: 'auto' }}>
                {odooCandidates.map((o, i) => (
                  <button key={o.id} onClick={() => doManualLink(o)} disabled={busy === linkFor.id}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-green-50 disabled:opacity-40" style={{ borderTop: i > 0 ? '1px solid #F3F4F6' : undefined }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" style={{ color: '#1A4731' }}>{o.name}</div>
                      <div className="text-[11px] text-ink-light flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold">{o.order_ref}</span>
                        {o.shop && <span>· {o.shop}</span>}
                        <span>· {new Date(o.delivery_date + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: 'numeric', month: 'short' })}</span>
                      </div>
                    </div>
                    {o.sku && <span className="text-[10px] font-mono text-ink-light shrink-0">{o.sku}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
