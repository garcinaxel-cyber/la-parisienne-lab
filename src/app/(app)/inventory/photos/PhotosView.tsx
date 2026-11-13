'use client';
// Photos missing before an inventory: each role photographs its own items (Axel, 2026-11-11 —
// storage the raw materials, assistants the packaging; no request sent to another person).
// A photo taken here goes to the app and to the Odoo product. "Pas en stock" = nothing to photograph now.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import ItemPhoto from '@/components/raw/ItemPhoto';
import { RAW_TYPES } from '@/lib/raw-materials';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { missingPhotosAction, setPhotoStatusAction, type PhotoTodo } from '../stock-count-actions';

const NAVY = '#2A1810', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', BORDER = '#E6DCCF', OK = '#067647';

export default function PhotosView({ kinds }: { kinds: ('raw' | 'packaging')[] }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = (v: string, f: string) => (vi ? v : f);
  const router = useRouter();
  const [items, setItems] = useState<PhotoTodo[] | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<'todo' | 'done' | 'nis'>('todo');
  // Separate lists per kind (Axel, 2026-11-09): raw materials and packaging are never mixed.
  const [kind, setKind] = useState<'raw' | 'packaging'>(kinds[0] ?? 'raw');
  useEffect(() => { missingPhotosAction().then(r => setItems(r.items ?? [])); }, []);

  const groups = useMemo(() => {
    const list = (items ?? []).filter(i => i.kind === kind).filter(i => (tab === 'done' ? done.has(i.tmplId) : tab === 'nis' ? !done.has(i.tmplId) && i.status === 'not_in_stock' : !done.has(i.tmplId) && i.status !== 'not_in_stock'));
    const g = new Map<string, PhotoTodo[]>();
    for (const i of list) {
      const k = i.kind === 'packaging' ? L('Bao bì', 'Packaging') : `${L(RAW_TYPES[i.type as 'dry']?.vi ?? '', ({ dry: 'Sec', fresh: 'Frais', frozen: 'Surgelé' } as any)[i.type] ?? '')}`;
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return Array.from(g.entries());
  }, [items, tab, done, vi, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const ofKind = (items ?? []).filter(i => i.kind === kind);
  const counts = { todo: ofKind.filter(i => !done.has(i.tmplId) && i.status !== 'not_in_stock').length, done: ofKind.filter(i => done.has(i.tmplId)).length, nis: ofKind.filter(i => !done.has(i.tmplId) && i.status === 'not_in_stock').length };
  const kindTodo = (k: 'raw' | 'packaging') => (items ?? []).filter(i => i.kind === k && !done.has(i.tmplId) && i.status !== 'not_in_stock').length;
  const nis = async (i: PhotoTodo, on: boolean) => {
    setItems(x => (x ?? []).map(y => (y.tmplId === i.tmplId ? { ...y, status: on ? 'not_in_stock' : 'open' } : y)));
    await setPhotoStatusAction(i.tmplId, on ? 'not_in_stock' : 'open');
  };

  return (
    <div className="w-full max-w-2xl mx-auto min-h-screen" style={{ backgroundColor: '#FAF7EE' }}>
      <div className="sticky top-0 z-20 text-white px-4 pt-3 pb-3 space-y-2.5" style={{ backgroundColor: NAVY }}>
        <div className="flex items-center gap-2">
          <button aria-label="Back" onClick={() => router.push('/inventory')} className="p-1 -ml-1"><ChevronLeft size={22} /></button>
          <div className="flex-1"><div className="text-[16px] font-extrabold">{L('Ảnh cần chụp', 'Photos à prendre')}</div>
            <div className="text-[11.5px]" style={{ color: '#D7E3DC' }}>{L('Ảnh chụp ở đây cập nhật cả Odoo', 'La photo met aussi à jour Odoo')}</div></div>
          <div className="text-[13px] font-extrabold" style={{ color: '#E9D9A0' }}>{counts.done}/{ofKind.length}</div>
        </div>
        {kinds.length > 1 && <div className="grid grid-cols-2 gap-1 rounded-xl p-1" style={{ backgroundColor: 'rgba(255,255,255,.12)' }}>
          {([['raw', L('Nguyên liệu', 'Matières premières')], ['packaging', L('Bao bì', 'Packaging')]] as const).map(([k, l]) =>
            <button key={k} onClick={() => setKind(k)} className="rounded-lg py-2 text-[13px] font-extrabold" style={kind === k ? { backgroundColor: '#fff', color: NAVY } : { color: '#fff' }}>{l} · {kindTodo(k)}</button>)}
        </div>}
        <div className="flex gap-1.5">
          {([['todo', L('Cần chụp', 'À faire')], ['done', L('Đã chụp', 'Faites')], ['nis', L('Hết hàng', 'Pas en stock')]] as const).map(([k, l]) =>
            <button key={k} onClick={() => setTab(k)} className="rounded-full px-3 py-1.5 text-[12px] font-extrabold" style={tab === k ? { backgroundColor: GOLD, color: '#2E1B12' } : { backgroundColor: 'rgba(255,255,255,.14)' }}>{l} · {counts[k]}</button>)}
        </div>
      </div>
      <div className="px-3 py-3 space-y-2 pb-10">
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
    </div>
  );
}
