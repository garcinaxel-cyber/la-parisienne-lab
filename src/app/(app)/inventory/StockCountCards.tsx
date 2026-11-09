'use client';
// Inventory home: raw materials and packaging counts + missing photos (Axel, 2026-11-09).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Camera, Wheat, Package, Loader2 } from 'lucide-react';
import { listCountsAction, startCountAction, missingPhotosAction } from './stock-count-actions';

const NAVY = '#1A4731', GOLD_TEXT = '#8A6D14', BORDER = '#E0D49A';
type Row = Awaited<ReturnType<typeof listCountsAction>>['counts'] extends (infer T)[] | undefined ? T : never;

export default function StockCountCards() {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = (v: string, f: string) => (vi ? v : f);
  const router = useRouter();
  const [counts, setCounts] = useState<Row[] | null>(null);
  const [missing, setMissing] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    listCountsAction().then(r => setCounts(r.counts ?? []));
    missingPhotosAction().then(r => setMissing((r.items ?? []).filter(i => i.status !== 'not_in_stock').length));
  }, []);
  const start = async (kind: 'raw' | 'packaging') => {
    setBusy(kind); setErr(null);
    const r = await startCountAction(kind);
    setBusy(null);
    if (r.error || !r.id) { setErr(r.error ?? 'Error'); return; }
    router.push(`/inventory/count/${r.id}`);
  };
  const card = (kind: 'raw' | 'packaging') => {
    const draft = counts?.find(c => c.kind === kind && c.status === 'draft');
    const last = counts?.find(c => c.kind === kind && c.status === 'submitted');
    const Icon = kind === 'raw' ? Wheat : Package;
    return (
      <button key={kind} onClick={() => start(kind)} disabled={!!busy} className="card w-full p-4 text-left space-y-2.5" style={draft ? { border: `2px solid ${NAVY}` } : undefined}>
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-none" style={{ backgroundColor: '#E6EFE9' }}><Icon size={20} color={NAVY} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-extrabold text-navy">{kind === 'raw' ? L('Nguyên liệu', 'Matières premières') : L('Bao bì', 'Packaging')}</div>
            <div className="text-xs text-ink-light">{kind === 'raw' ? L('Khô · Mát · Đông lạnh', 'Sec · Frais · Surgelé') : L('Toàn bộ nhóm bao bì', 'Toute la catégorie packaging')}
              {last ? ` · ${L('lần trước', 'dernier')} ${last.countDate}` : ''}</div>
          </div>
          {busy === kind ? <Loader2 size={18} className="animate-spin" /> : <span className="text-xs font-bold text-navy">{draft ? L('Tiếp tục ›', 'Continuer ›') : L('Bắt đầu ›', 'Démarrer ›')}</span>}
        </div>
        {draft && <div className="space-y-1">
          <div className="h-2 rounded bg-[#EFE9CF] overflow-hidden"><div className="h-2" style={{ width: `${draft.scope ? (Math.min(draft.counted, draft.scope) / draft.scope) * 100 : 0}%`, backgroundColor: NAVY }} /></div>
          <div className="text-[11.5px] text-ink-light">{draft.counted}/{draft.scope} · {draft.countDate}{draft.unknownOpen ? ` · ${draft.unknownOpen} ${L('ảnh cần xác định', 'photo(s) à identifier')}` : ''}</div>
        </div>}
      </button>
    );
  };
  return (
    <div className="space-y-3">
      {missing != null && missing > 0 && (
        <button onClick={() => router.push('/inventory/photos')} className="w-full rounded-xl p-3.5 flex items-center gap-3 text-left" style={{ backgroundColor: '#FBF3DD', border: '1px solid #E8C979' }}>
          <Camera size={20} color={GOLD_TEXT} />
          <div className="flex-1"><div className="text-[13.5px] font-extrabold" style={{ color: '#1A2C24' }}>{missing} {L('mặt hàng chưa có ảnh', 'articles sans photo')}</div>
            <div className="text-[11.5px]" style={{ color: '#6B4A00' }}>{L('Nhờ kho chụp trước kiểm kê', 'À demander au storage avant l\'inventaire')}</div></div>
          <span className="text-[12px] font-extrabold text-white rounded-lg px-2.5 py-1.5" style={{ backgroundColor: GOLD_TEXT }}>{L('Xem', 'Voir')}</span>
        </button>
      )}
      {counts === null ? <div className="card p-6 text-center"><Loader2 className="animate-spin inline" /></div> : <>{card('raw')}{card('packaging')}</>}
      {err && <div className="text-sm font-semibold" style={{ color: '#DC2626' }}>{err}</div>}
      <div className="text-[11.5px] text-ink-light px-1" style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
        {L('Mỗi kiểm kê gửi lên Odoo thành một phiếu nháp riêng. Tồn kho chỉ thay đổi khi áp dụng trên Odoo.', 'Chaque inventaire part dans Odoo en brouillon séparé. Le stock ne change qu\'à l\'application dans Odoo.')}
      </div>
    </div>
  );
}
