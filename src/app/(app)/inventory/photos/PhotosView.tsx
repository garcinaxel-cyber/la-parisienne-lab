'use client';
// Photos missing before an inventory (Axel, 2026-11-09): the storage (purchasing) is asked, assistants
// can take them too. A photo taken here goes to the app and to the Odoo product. "Pas en stock" =
// nothing to photograph now.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import ItemPhoto from '@/components/raw/ItemPhoto';
import { RAW_TYPES } from '@/lib/raw-materials';
import { ChevronLeft, Loader2, Send } from 'lucide-react';
import { missingPhotosAction, requestPhotosAction, setPhotoStatusAction, type PhotoTodo } from '../stock-count-actions';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', BORDER = '#E0D49A', OK = '#067647';

export default function PhotosView() {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = (v: string, f: string) => (vi ? v : f);
  const router = useRouter();
  const [items, setItems] = useState<PhotoTodo[] | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'todo' | 'done' | 'nis'>('todo');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { missingPhotosAction().then(r => setItems(r.items ?? [])); }, []);

  const groups = useMemo(() => {
    const list = (items ?? []).filter(i => (tab === 'done' ? done.has(i.tmplId) : tab === 'nis' ? !done.has(i.tmplId) && i.status === 'not_in_stock' : !done.has(i.tmplId) && i.status !== 'not_in_stock'));
    const g = new Map<string, PhotoTodo[]>();
    for (const i of list) {
      const k = i.kind === 'packaging' ? L('Bao bì', 'Packaging') : `${L(RAW_TYPES[i.type as 'dry']?.vi ?? '', ({ dry: 'Sec', fresh: 'Frais', frozen: 'Surgelé' } as any)[i.type] ?? '')}`;
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return Array.from(g.entries());
  }, [items, tab, done, vi]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = { todo: (items ?? []).filter(i => !done.has(i.tmplId) && i.status !== 'not_in_stock').length, done: done.size, nis: (items ?? []).filter(i => !done.has(i.tmplId) && i.status === 'not_in_stock').length };
  const ask = async () => {
    setBusy(true);
    const r = await requestPhotosAction((items ?? []).filter(i => !done.has(i.tmplId) && i.status !== 'not_in_stock').map(i => i.tmplId));
    setBusy(false); setMsg(r.error ?? L('Đã gửi yêu cầu cho kho.', 'Demande envoyée au storage.'));
    setItems(x => (x ?? []).map(i => (i.status ? i : { ...i, status: 'open' })));
  };
  const nis = async (i: PhotoTodo, on: boolean) => {
    setItems(x => (x ?? []).map(y => (y.tmplId === i.tmplId ? { ...y, status: on ? 'not_in_stock' : 'open' } : y)));
    await setPhotoStatusAction(i.tmplId, on ? 'not_in_stock' : 'open');
  };

  return (
    <div className="max-w-2xl mx-auto -mx-4 sm:mx-auto min-h-screen" style={{ backgroundColor: '#FAF7EE' }}>
      <div className="sticky top-0 z-20 text-white px-4 pt-3 pb-3 space-y-2.5" style={{ backgroundColor: NAVY }}>
        <div className="flex items-center gap-2">
          <button aria-label="Back" onClick={() => router.push('/inventory')} className="p-1 -ml-1"><ChevronLeft size={22} /></button>
          <div className="flex-1"><div className="text-[16px] font-extrabold">{L('Ảnh cần chụp', 'Photos à prendre')}</div>
            <div className="text-[11.5px]" style={{ color: '#D7E3DC' }}>{L('Ảnh chụp ở đây cập nhật cả Odoo', 'La photo met aussi à jour Odoo')}</div></div>
          <div className="text-[13px] font-extrabold" style={{ color: '#E9D9A0' }}>{counts.done}/{(items ?? []).length}</div>
        </div>
        <div className="flex gap-1.5">
          {([['todo', L('Cần chụp', 'À faire')], ['done', L('Đã chụp', 'Faites')], ['nis', L('Hết hàng', 'Pas en stock')]] as const).map(([k, l]) =>
            <button key={k} onClick={() => setTab(k)} className="rounded-full px-3 py-1.5 text-[12px] font-extrabold" style={tab === k ? { backgroundColor: GOLD, color: '#1A2C24' } : { backgroundColor: 'rgba(255,255,255,.14)' }}>{l} · {counts[k]}</button>)}
        </div>
      </div>
      <div className="px-3 py-3 space-y-2 pb-24">
        {items === null && <div className="p-10 text-center"><Loader2 className="animate-spin inline" /></div>}
        {items && !groups.length && <div className="card p-8 text-center text-sm" style={{ color: '#5B6B63' }}>{L('Không còn gì.', 'Rien ici.')}</div>}
        {groups.map(([g, list]) => (
          <div key={g} className="space-y-2">
            <div className="text-[11.5px] font-extrabold tracking-wide px-1 pt-1" style={{ color: GOLD_TEXT }}>{g.toUpperCase()} · {list.length}</div>
            {list.map(i => (
              <div key={i.tmplId} className="bg-white rounded-2xl p-2.5 flex items-center gap-3" style={{ border: `1px solid ${BORDER}` }}>
                <ItemPhoto tmplId={i.tmplId} sku={i.sku} size={60} canAdd onAdded={() => setDone(d => new Set(d).add(i.tmplId))} />
                <div className="flex-1 min-w-0"><div className="text-[13.5px] font-extrabold leading-tight">{vi && i.nameVi ? i.nameVi : i.name}</div>
                  <div className="text-[11px]" style={{ color: '#5B6B63' }}>{[i.sku, vi ? i.name : i.nameVi].filter(Boolean).join(' · ')}</div></div>
                {done.has(i.tmplId) ? <span className="text-[12px] font-extrabold flex-none" style={{ color: OK }}>✓</span>
                  : <button onClick={() => nis(i, i.status !== 'not_in_stock')} className="flex-none rounded-lg px-2.5 py-2 text-[11.5px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#5B6B63' }}>
                    {i.status === 'not_in_stock' ? L('Có hàng lại', 'De nouveau en stock') : L('Hết hàng', 'Pas en stock')}</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {items && counts.todo > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-20 bg-white px-3 pt-2 pb-3 max-w-2xl mx-auto" style={{ borderTop: '1px solid #EFE9CF' }}>
          {msg && <div className="text-[12px] pb-1.5 font-semibold" style={{ color: NAVY }}>{msg}</div>}
          <button disabled={busy} onClick={ask} className="w-full rounded-xl py-3 text-[14px] font-extrabold text-white disabled:opacity-60 flex items-center justify-center gap-2" style={{ backgroundColor: GOLD_TEXT }}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} {L(`Báo kho chụp ${counts.todo} ảnh`, `Demander ${counts.todo} photos au storage`)}</button>
        </div>
      )}
    </div>
  );
}
