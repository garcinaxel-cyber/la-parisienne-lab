'use client';
// Inventaire Lab home (Axel, 2026-11-09: "l'historique prend toute la place, on ne voit même pas
// l'inventaire room chef et produits finis"): the four inventories as equal tiles at the top, the
// missing-photos reminder on one line, and one short history (5 latest, all kinds) below.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ClipboardList, ClipboardCheck, CheckCircle2, AlertTriangle, Clock, Wheat, Package, Box, Camera, Loader2, ChevronRight } from 'lucide-react';
import { listCountsAction, startCountAction, missingPhotosAction } from './stock-count-actions';

type Session = {
  id: string; inventory_date: string; status: string;
  created_by_name: string | null; submitted_by_name: string | null; submitted_at: string | null;
  odoo_push_status: string | null; odoo_push_error: string | null;
};
type Count = NonNullable<Awaited<ReturnType<typeof listCountsAction>>['counts']>[number];
type Hist = { key: string; kind: 'finished' | 'raw' | 'packaging'; date: string; who: string; status: 'draft' | 'ok' | 'error'; href: string; at: string };

const NAVY = '#1A4731', GOLD_TEXT = '#8A6D14', BORDER = '#E0D49A';
function todayISO() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); }

export default function InventoryIndexView({ sessions, role }: { sessions: Session[]; role?: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = (v: string, f: string) => (vi ? v : f);
  const router = useRouter();
  const purchasingOnly = role === 'purchasing';
  const [counts, setCounts] = useState<Count[] | null>(null);
  const [missing, setMissing] = useState<{ raw: number; packaging: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fgOpen, setFgOpen] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [allHist, setAllHist] = useState(false);

  useEffect(() => {
    listCountsAction().then(r => setCounts(r.counts ?? []));
    missingPhotosAction().then(r => { const open = (r.items ?? []).filter(i => i.status !== 'not_in_stock'); setMissing({ raw: open.filter(i => i.kind === 'raw').length, packaging: open.filter(i => i.kind === 'packaging').length }); });
  }, []);

  const startStock = async (kind: 'raw' | 'packaging') => {
    setBusy(kind); setError(null);
    const r = await startCountAction(kind);
    setBusy(null);
    if (r.error || !r.id) { setError(r.error ?? 'Error'); return; }
    router.push(`/inventory/count/${r.id}`);
  };
  const startFinished = async () => {
    setBusy('finished'); setError(null);
    const { getOrCreateSessionAction } = await import('./actions');
    const res = await getOrCreateSessionAction(date);
    setBusy(null);
    if (res.error) { setError(res.error); return; }
    router.push(`/inventory/${res.id}`);
  };

  const draftOf = (k: 'raw' | 'packaging') => counts?.find(c => c.kind === k && c.status === 'draft');
  const fgDraft = sessions.find(s => s.status === 'draft');

  const hist: Hist[] = [
    ...(purchasingOnly ? [] : sessions.map(s => ({
      key: `f-${s.id}`, kind: 'finished' as const, date: s.inventory_date, at: s.submitted_at ?? s.inventory_date,
      who: (s.status === 'submitted' ? s.submitted_by_name : s.created_by_name) ?? '—',
      status: s.status === 'draft' ? 'draft' as const : s.odoo_push_status === 'success' ? 'ok' as const : 'error' as const, href: `/inventory/${s.id}`,
    }))),
    ...(counts ?? []).map(c => ({
      key: `c-${c.id}`, kind: c.kind, date: c.countDate, at: c.submittedAt ?? c.createdAt,
      who: (c.status === 'submitted' ? c.submittedBy : c.createdBy) ?? '—',
      status: c.status === 'draft' ? 'draft' as const : c.pushStatus === 'success' ? 'ok' as const : 'error' as const, href: `/inventory/count/${c.id}`,
    })),
  ].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
  const shownHist = allHist ? hist : hist.slice(0, 5);
  const kindLabel = (k: Hist['kind']) => (k === 'raw' ? L('Nguyên liệu', 'Matières') : k === 'packaging' ? L('Bao bì', 'Packaging') : L('Thành phẩm', 'Produits finis'));

  const Tile = ({ icon: Icon, title, sub, onClick, progress, action, spin }: { icon: any; title: string; sub: string; onClick: () => void; progress?: { done: number; total: number; extra?: string }; action: string; spin?: boolean }) => (
    <button onClick={onClick} disabled={!!busy} className="card p-3 text-left flex flex-col gap-2 min-h-[118px] min-w-0" style={progress ? { border: `2px solid ${NAVY}` } : undefined}>
      <div className="flex items-center gap-2">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-none" style={{ backgroundColor: '#E6EFE9' }}><Icon size={16} color={NAVY} /></span>
        <div className="text-[14px] font-extrabold text-navy leading-tight min-w-0">{title}</div>
      </div>
      <div className="text-[11.5px] text-ink-light leading-snug line-clamp-2">{sub}</div>
      <div className="mt-auto space-y-1">
        {progress && <>
          <div className="h-1.5 rounded bg-[#EFE9CF] overflow-hidden"><div className="h-1.5" style={{ width: `${progress.total ? (Math.min(progress.done, progress.total) / progress.total) * 100 : 0}%`, backgroundColor: NAVY }} /></div>
          <div className="text-[11px] text-ink-light">{progress.done}/{progress.total}{progress.extra ? ` · ${progress.extra}` : ''}</div>
        </>}
        <div className="text-[12.5px] font-extrabold text-navy flex items-center gap-1">{spin ? <Loader2 size={14} className="animate-spin" /> : null}{action} <ChevronRight size={14} /></div>
      </div>
    </button>
  );

  const raw = draftOf('raw'), pk = draftOf('packaging');
  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy flex items-center gap-2">
        <ClipboardList size={22} className="text-gold" /> {L('Kiểm kê Lab', 'Inventaire Lab')}
      </h1>

      {missing != null && missing.raw + missing.packaging > 0 && (
        <button onClick={() => router.push('/inventory/photos')} className="w-full rounded-xl px-3.5 py-2.5 flex items-center gap-2.5 text-left" style={{ backgroundColor: '#FBF3DD', border: '1px solid #E8C979' }}>
          <Camera size={17} color={GOLD_TEXT} className="flex-none" />
          <span className="flex-1 text-[13px]" style={{ color: '#1A2C24' }}>{L('Chưa có ảnh', 'Sans photo')} : <b>{missing.raw}</b> {L('nguyên liệu', 'matières')} · <b>{missing.packaging}</b> {L('bao bì', 'packaging')} <span className="text-ink-light">— {L('nhờ kho chụp trước kiểm kê', 'à demander au storage avant l\'inventaire')}</span></span>
          <ChevronRight size={16} color={GOLD_TEXT} />
        </button>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Tile icon={Wheat} title={L('Nguyên liệu', 'Matières premières')} sub={L('Khô · Mát · Đông lạnh', 'Sec · Frais · Surgelé')} onClick={() => startStock('raw')}
          progress={raw ? { done: raw.counted, total: raw.scope, extra: raw.unknownOpen ? `${raw.unknownOpen} ${L('ảnh', 'photo(s)')}` : raw.countDate } : undefined}
          action={raw ? L('Tiếp tục', 'Continuer') : L('Bắt đầu', 'Démarrer')} spin={busy === 'raw'} />
        <Tile icon={Package} title={L('Bao bì', 'Packaging')} sub={L('Toàn bộ nhóm bao bì', 'Toute la catégorie packaging')} onClick={() => startStock('packaging')}
          progress={pk ? { done: pk.counted, total: pk.scope, extra: pk.unknownOpen ? `${pk.unknownOpen} ${L('ảnh', 'photo(s)')}` : pk.countDate } : undefined}
          action={pk ? L('Tiếp tục', 'Continuer') : L('Bắt đầu', 'Démarrer')} spin={busy === 'packaging'} />
        {!purchasingOnly && <>
          <Tile icon={Box} title={L('Thành phẩm', 'Produits finis')} sub={L('Macaron, bánh quy, tiramisu', 'Macaron, biscuit voyage, tiramisu')}
            onClick={() => (fgDraft ? router.push(`/inventory/${fgDraft.id}`) : setFgOpen(true))}
            action={fgDraft ? `${L('Tiếp tục', 'Continuer')} · ${fgDraft.inventory_date}` : L('Bắt đầu', 'Démarrer')} spin={busy === 'finished'} />
          <Tile icon={ClipboardCheck} title={L('Room các team', 'Rooms des chefs')} sub={L('Đã đếm, = 0, không đếm, cảnh báo đơn vị', 'Comptés, = 0, hors inventaire, alertes d\'unité')}
            onClick={() => router.push('/inventory/rooms')} action={L('Xem', 'Voir')} />
        </>}
      </div>
      {error && <div className="text-sm font-semibold" style={{ color: '#DC2626' }}>{error}</div>}
      <div className="text-[11.5px] text-ink-light px-1">{L('Mỗi kiểm kê gửi lên Odoo thành một phiếu nháp riêng. Tồn kho chỉ thay đổi khi áp dụng trên Odoo.', 'Chaque inventaire part dans Odoo en brouillon séparé. Le stock ne change qu\'à l\'application dans Odoo.')}</div>

      <div className="space-y-2 pt-1">
        <div className="flex items-center justify-between">
          <h2 className="text-[12px] font-bold text-navy uppercase tracking-wide">{L('Lịch sử', 'Historique')}</h2>
          {hist.length > 5 && <button onClick={() => setAllHist(v => !v)} className="text-[12px] font-bold" style={{ color: GOLD_TEXT }}>{allHist ? L('Thu gọn', 'Réduire') : `${L('Xem tất cả', 'Tout voir')} (${hist.length})`}</button>}
        </div>
        {counts === null ? <div className="card p-4 text-center"><Loader2 size={16} className="animate-spin inline" /></div>
          : !hist.length ? <div className="card p-5 text-center text-sm text-ink-light">{L('Chưa có kiểm kê nào', 'Aucun inventaire pour le moment')}</div>
          : <div className="card divide-y divide-border-soft overflow-hidden">
            {shownHist.map(h => (
              <button key={h.key} onClick={() => router.push(h.href)} className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-cream/60">
                <span className="text-[10.5px] font-extrabold rounded-md px-1.5 py-0.5 flex-none w-[92px] text-center" style={{ backgroundColor: '#F3EBD2', color: GOLD_TEXT }}>{kindLabel(h.kind)}</span>
                <span className="flex-1 min-w-0"><span className="text-[13px] font-bold text-navy">{h.date}</span> <span className="text-[11.5px] text-ink-light truncate">· {h.who}</span></span>
                {h.status === 'draft' ? <span className="inline-flex items-center gap-1 text-[11.5px] font-bold flex-none" style={{ color: '#6B7280' }}><Clock size={13} /> {L('Đang đếm', 'En cours')}</span>
                  : h.status === 'ok' ? <span className="inline-flex items-center gap-1 text-[11.5px] font-bold flex-none" style={{ color: '#059669' }}><CheckCircle2 size={13} /> {L('Đã gửi', 'Envoyé')}</span>
                  : <span className="inline-flex items-center gap-1 text-[11.5px] font-bold flex-none" style={{ color: '#DC2626' }}><AlertTriangle size={13} /> {L('Lỗi', 'Erreur')}</span>}
              </button>
            ))}
          </div>}
      </div>

      {fgOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center" onClick={() => setFgOpen(false)}>
          <div className="bg-white w-full max-w-sm rounded-t-2xl sm:rounded-2xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="text-[15px] font-extrabold text-navy">{L('Kiểm kê thành phẩm', 'Inventaire produits finis')}</div>
            <label className="flex items-center gap-2 text-sm font-semibold text-navy">{L('Ngày kiểm kê', "Date d'inventaire")}
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="flex-1 rounded-lg px-3 py-2 text-sm" style={{ border: `1px solid ${BORDER}` }} /></label>
            <button onClick={startFinished} disabled={!!busy} className="w-full rounded-xl py-3 text-[14px] font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: NAVY }}>
              {busy === 'finished' ? <Loader2 size={16} className="animate-spin inline" /> : L('Bắt đầu', 'Démarrer')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
