'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, Plus, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';

type Session = {
  id: string; inventory_date: string; status: string;
  created_by_name: string | null; submitted_by_name: string | null; submitted_at: string | null;
  odoo_push_status: string | null; odoo_push_error: string | null;
};

function todayISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

export default function InventoryIndexView({ sessions }: { sessions: Session[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [date, setDate] = useState(todayISO());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setCreating(true); setError(null);
    const { getOrCreateSessionAction } = await import('./actions');
    const res = await getOrCreateSessionAction(date);
    setCreating(false);
    if (res.error) { setError(res.error); return; }
    router.push(`/inventory/${res.id}`);
  }

  return (
    <div className="space-y-4">
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy mb-1 flex items-center gap-2">
        <ClipboardList size={22} className="text-gold" />
        {vi ? 'Kiểm kê thành phẩm' : 'Inventaire produits finis'}
      </h1>
      <p className="text-sm text-ink-light">
        {vi
          ? 'Đếm số lượng thực tế (Macaron, Bánh quy du lịch, Tiramisu) và gửi lên Odoo.'
          : 'Compte les quantités réelles (Macaron, Biscuit Voyage, Tiramisu) et les envoie sur Odoo.'}
      </p>

      <div className="card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-sm font-semibold text-navy shrink-0">{vi ? 'Ngày kiểm kê' : "Date d'inventaire"}</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="rounded-lg px-3 py-2 text-sm" style={{ border: '1px solid #D1D5DB' }} />
        </div>
        <button onClick={start} disabled={creating}
          className="inline-flex items-center justify-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl text-white disabled:opacity-50"
          style={{ backgroundColor: '#1f2937' }}>
          <Plus size={16} /> {creating ? '…' : (vi ? 'Bắt đầu / tiếp tục kiểm kê' : 'Démarrer / continuer')}
        </button>
      </div>
      {error && <div className="text-sm font-semibold" style={{ color: '#DC2626' }}>{error}</div>}

      <div className="space-y-2">
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">{vi ? 'Gần đây' : 'Récents'}</h2>
        {sessions.length === 0 ? (
          <div className="card p-8 text-center text-sm text-ink-light">{vi ? 'Chưa có kiểm kê nào' : 'Aucun inventaire pour le moment'}</div>
        ) : (
          <div className="card divide-y divide-border-soft overflow-hidden">
            {sessions.map(s => (
              <button key={s.id} onClick={() => router.push(`/inventory/${s.id}`)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-cream/60">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-navy">{s.inventory_date}</div>
                  <div className="text-xs text-ink-light truncate">
                    {s.status === 'submitted'
                      ? `${vi ? 'Gửi bởi' : 'Envoyé par'} ${s.submitted_by_name ?? '—'}`
                      : `${vi ? 'Tạo bởi' : 'Créé par'} ${s.created_by_name ?? '—'}`}
                  </div>
                  {s.odoo_push_error && <div className="text-[11px] font-semibold" style={{ color: '#B45309' }}>{s.odoo_push_error}</div>}
                </div>
                {s.status === 'draft' ? (
                  <span className="inline-flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: '#6B7280' }}>
                    <Clock size={14} /> {vi ? 'Đang đếm' : 'En cours'}
                  </span>
                ) : s.odoo_push_status === 'success' ? (
                  <span className="inline-flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: '#059669' }}>
                    <CheckCircle2 size={14} /> {vi ? 'Đã gửi' : 'Envoyé'}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: '#DC2626' }}>
                    <AlertTriangle size={14} /> {vi ? 'Lỗi' : 'Erreur'}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
