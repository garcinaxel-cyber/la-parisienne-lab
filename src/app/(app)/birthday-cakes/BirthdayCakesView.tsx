'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Store, Clock, Truck, Save, CheckCircle2, FileText } from 'lucide-react';

type Cake = {
  id: string; order_ref: string; name: string; shop: string | null;
  delivery_date: string; delivery_time: string | null; qty: number;
  message: string; ready_time: string; delivered_by: string;
};

const DELIVERERS = ['Lab', 'La Parisienne', 'Moon Flower', 'Paris'];

export default function BirthdayCakesView({ cakes }: { cakes: Cake[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const [edits, setEdits] = useState<Record<string, { message: string; ready_time: string; delivered_by: string }>>(() => {
    const s: Record<string, { message: string; ready_time: string; delivered_by: string }> = {};
    for (const c of cakes) s[c.id] = { message: c.message, ready_time: c.ready_time, delivered_by: c.delivered_by };
    return s;
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const upd = (id: string, patch: Partial<{ message: string; ready_time: string; delivered_by: string }>) => {
    setEdits(p => ({ ...p, [id]: { ...p[id], ...patch } }));
    setSaved(p => { const n = new Set(p); n.delete(id); return n; });
  };
  const dirty = (c: Cake) => {
    const e = edits[c.id];
    return e.message !== c.message || e.ready_time !== c.ready_time || e.delivered_by !== c.delivered_by;
  };

  async function save(c: Cake) {
    setSaving(c.id);
    const { saveBirthdayDetailAction } = await import('./actions');
    const e = edits[c.id];
    const res = await saveBirthdayDetailAction(c.id, { message: e.message || null, readyTime: e.ready_time || null, deliveredBy: e.delivered_by || null });
    setSaving(null);
    if (res.ok) { c.message = e.message; c.ready_time = e.ready_time; c.delivered_by = e.delivered_by; setSaved(p => new Set(p).add(c.id)); }
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2">
          🎂 {vi ? 'Bánh sinh nhật' : 'Birthday cakes'}
        </h1>
        <p className="text-ink-light text-sm mt-0.5">
          {vi ? 'Đọc từ đơn Odoo · thêm lời chúc, giờ cần xong và ai giao.' : 'Read from Odoo orders · add the message, ready time and who delivers.'}
        </p>
      </div>

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
              const e = edits[c.id];
              const col = shopColor(c.shop);
              return (
                <div key={c.id} className="card p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold text-navy">×{c.qty} · {c.name}</div>
                      <div className="text-xs text-ink-light mt-0.5 flex items-center gap-3 flex-wrap">
                        <span className="inline-flex items-center gap-1"><FileText size={13} /> {c.order_ref}</span>
                        {c.delivery_time && <span className="inline-flex items-center gap-1"><Clock size={13} /> {vi ? 'giao' : 'delivery'} {c.delivery_time.slice(0, 5)}</span>}
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1" style={{ backgroundColor: col.bg, color: col.fg }}>
                      <Store size={12} /> {c.shop}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-[130px_1fr] gap-2 items-center">
                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Clock size={13} className="text-blue-600" /> {vi ? 'Cần xong lúc' : 'Ready by'}</label>
                    <input type="time" value={e.ready_time} onChange={ev => upd(c.id, { ready_time: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-32" style={{ border: '1px solid #D1D5DB' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><span className="text-blue-600">✎</span> {vi ? 'Lời chúc' : 'Message'}</label>
                    <input type="text" value={e.message} onChange={ev => upd(c.id, { message: ev.target.value })}
                      placeholder={vi ? 'Chữ trên bánh…' : 'Text on the cake…'}
                      className="rounded-lg px-2 py-1.5 text-sm w-full" style={{ border: '1px solid', borderColor: '#93C5FD' }} />

                    <label className="text-xs font-semibold text-ink-light flex items-center gap-1.5"><Truck size={13} className="text-blue-600" /> {vi ? 'Ai giao' : 'Delivered by'}</label>
                    <select value={e.delivered_by} onChange={ev => upd(c.id, { delivered_by: ev.target.value })}
                      className="rounded-lg px-2 py-1.5 text-sm w-48" style={{ border: '1px solid #D1D5DB', backgroundColor: 'white' }}>
                      <option value="">{vi ? '— Chọn —' : '— Select —'}</option>
                      {DELIVERERS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>

                  <div className="mt-3 flex items-center justify-end gap-2">
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
    </div>
  );
}
