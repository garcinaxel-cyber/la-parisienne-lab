'use client';
// Tasks · Delivery gaps (Axel, 2026-10-24): one screen, colour = what to do.
// Red = to do now · Amber = waiting for someone else · Green = done (collapsed per family).
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { reasonLabel } from '@/lib/delivery-check-reasons';
import type { ProdTask, RecountTask } from '@/lib/delivery-tasks';
import { RotateCcw, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

const RED = '#B42318', AMBER = '#B54708', GREEN = '#067647';

export default function TasksPanel({ open, resolved, recounts, receptionOpen, waitingShop, damagedNotBack, today }: {
  open: ProdTask[]; resolved: ProdTask[]; recounts: RecountTask[];
  receptionOpen: number; waitingShop: number; damagedNotBack: number; today: string;
}) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [greenOpen, setGreenOpen] = useState<string | null>(null);
  const total = open.length + receptionOpen;
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(vi ? 'vi-VN' : 'en-GB', { day: '2-digit', month: '2-digit' });

  async function retry(t: ProdTask) {
    setBusy(t.id);
    const { followUpLineAction } = await import('../actions');
    const r = await followUpLineAction(t.id);
    setBusy(null);
    if (r.error || r.result?.odooStatus === 'error') setMsg(m => ({ ...m, [t.id]: r.error ?? r.result?.error ?? 'Odoo error' }));
    router.refresh();
  }
  async function recountDone(r: RecountTask) {
    setBusy(r.id);
    const { closeRecountAlertAction } = await import('./actions');
    const res = await closeRecountAlertAction(r.id, null);
    setBusy(null);
    if (res.error) setMsg(m => ({ ...m, [r.id]: res.error! }));
    router.refresh();
  }

  const families = Object.entries(resolved.reduce<Record<string, ProdTask[]>>((acc, t) => { (acc[t.family] ??= []).push(t); return acc; }, {}));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-2xl border p-4" style={{ borderColor: total ? '#FECDCA' : '#ABEFC6', backgroundColor: total ? '#FEF3F2' : '#ECFDF3' }}>
        <div className="text-5xl font-black leading-none" style={{ color: total ? RED : GREEN }}>{total}</div>
        <div>
          <div className="font-bold text-stone-800">{total ? (vi ? 'việc cần làm' : 'tasks to do') : (vi ? 'Không còn việc nào 🎉' : 'Nothing left to do')}</div>
          <div className="text-xs text-stone-500">{vi ? 'Đỏ = làm ngay · Vàng = chờ người khác · Xanh = đã xong' : 'Red = do it now · Amber = waiting for someone else · Green = done'}</div>
        </div>
      </div>

      {/* ① Production → delivery */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: open.length ? RED : GREEN }}>
          ① {vi ? 'Sản xuất → giao hàng' : 'Production → delivery'} · {open.length}
        </h2>
        {open.length === 0 && <div className="text-sm text-stone-500">{vi ? 'Không có chênh lệch chưa xử lý.' : 'No unsettled difference.'}</div>}
        {open.map(t => (
          <div key={t.id} className="rounded-xl border-l-4 bg-white p-3 shadow-sm" style={{ borderLeftColor: RED }}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {t.deliveryDate < today && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{fmt(t.deliveryDate)}</span>}
              <span className="font-semibold text-stone-800">{t.product}</span>
              <span className="text-stone-500">{t.shop ?? ''} · {t.orderRef}</span>
              <span className="ml-auto font-mono text-sm"><b>{t.expected}</b> → <b style={{ color: RED }}>{t.checked}</b></span>
            </div>
            <div className="mt-1 text-xs text-stone-600">
              {t.reason ? reasonLabel(t.reason, vi) : (vi ? 'Chưa chọn lý do' : 'No reason chosen')}
              {t.note ? ` · “${t.note}”` : ''}
            </div>
            {(t.odooError || msg[t.id]) && <div className="mt-1 text-xs" style={{ color: RED }}>Odoo: {msg[t.id] ?? t.odooError}</div>}
            <div className="mt-2 flex flex-wrap gap-2">
              {t.reason && (
                <button onClick={() => retry(t)} disabled={busy === t.id} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: RED }}>
                  <RotateCcw size={13} className={busy === t.id ? 'animate-spin' : ''} />{vi ? 'Làm lại' : 'Do it again'}
                </button>
              )}
              <Link href={`/delivery-check/${t.deliveryDate}/${encodeURIComponent(t.orderRef)}`} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold text-stone-700">
                <ExternalLink size={13} />{vi ? 'Mở đơn' : 'Open order'}
              </Link>
            </div>
          </div>
        ))}
      </section>

      {/* Waiting for someone else */}
      {(recounts.length > 0 || waitingShop > 0 || damagedNotBack > 0) && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: AMBER }}>{vi ? 'Đang chờ người khác' : 'Waiting for someone else'}</h2>
          {waitingShop > 0 && <div className="rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>{waitingShop} {vi ? 'chênh lệch chờ cửa hàng trả lời (xem ② › Chờ shop)' : 'gaps waiting for the shop (see ② › Waiting shop)'}</div>}
          {damagedNotBack > 0 && <div className="rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>{damagedNotBack} {vi ? 'bánh hỏng chưa mang về Lab' : 'damaged items not back at the Lab yet'}</div>}
          {recounts.map(r => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border-l-4 bg-white p-3 text-sm" style={{ borderLeftColor: AMBER }}>
              <span>{vi ? 'Đếm lại kho' : 'Recount stock'}: <b>{r.product}</b> ({vi ? 'thiếu' : 'missing'} {r.missing}{r.orderRef ? ` · ${r.orderRef}` : ''})</span>
              {msg[r.id] && <span className="text-xs" style={{ color: RED }}>{msg[r.id]}</span>}
              <button onClick={() => recountDone(r)} disabled={busy === r.id} className="ml-auto rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50" style={{ backgroundColor: AMBER }}>
                {vi ? 'Đã đếm lại' : 'Recounted'}
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Done, collapsed per family */}
      {families.length > 0 && (
        <section className="space-y-1">
          <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: GREEN }}>{vi ? 'Đã xử lý' : 'Done'} · {resolved.length}</h2>
          {families.map(([fam, list]) => (
            <div key={fam} className="rounded-xl bg-emerald-50/60">
              <button onClick={() => setGreenOpen(g => g === fam ? null : fam)} className="flex w-full items-center gap-2 px-3 py-2 text-sm" style={{ color: GREEN }}>
                {greenOpen === fam ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<b>{fam}</b> · {list.length}
              </button>
              {greenOpen === fam && list.map(t => (
                <div key={t.id} className="px-8 pb-1 text-xs text-stone-600">
                  {fmt(t.deliveryDate)} · {t.product} · {t.orderRef} · {t.expected}→{t.checked} · {reasonLabel(t.resolution === 'auto_transfer' ? null : t.resolution, vi) || (vi ? 'Tự chuyển kho' : 'Auto transfer')}{t.ref ? ` · ${t.ref}` : ''}
                </div>
              ))}
            </div>
          ))}
        </section>
      )}

      <h2 className="pt-2 text-sm font-bold uppercase tracking-wide" style={{ color: receptionOpen ? RED : GREEN }}>
        ② {vi ? 'Giao hàng → cửa hàng' : 'Delivery → shop'} · {receptionOpen}
      </h2>
    </div>
  );
}
