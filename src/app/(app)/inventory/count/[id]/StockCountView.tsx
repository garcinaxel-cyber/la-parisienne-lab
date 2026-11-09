'use client';
// Lab inventory of raw materials / packaging (Axel, 2026-11-09). Everything is loaded once; search,
// zones and progress run on the phone; each quantity is saved in the background (debounced, retried
// when the network is back). Odoo is touched only on "Calculer les écarts" and "Envoyer".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { compressImage } from '@/lib/compress-image';
import { RAW_TYPES } from '@/lib/raw-materials';
import ItemPhoto from '@/components/raw/ItemPhoto';
import { ChevronLeft, Search, Camera, Loader2, Check, AlertCircle, X, Download, Send, AlertTriangle } from 'lucide-react';
import {
  getCountAction, saveCountLineAction, addUnknownAction, resolveUnknownAction, recapCountAction, submitCountAction,
  type CountItem, type CountLine, type Unknown, type CountHeader, type RecapLine,
} from '../../stock-count-actions';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FAF7EE', BORDER = '#E0D49A', HAIR = '#EFE9CF', LATE = '#B42318', OK = '#067647';

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase();
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 3 });
const vnd = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} ₫`;
const parseNum = (s: string): number | null => { const t = s.trim().replace(',', '.'); if (!t) return null; const n = Number(t); return Number.isFinite(n) && n >= 0 ? n : NaN; };

// Packaging: no zones — groups from the name (Axel: "pas possible de raisonner en zone").
const PK_GROUPS: { key: string; vi: string; fr: string; words: string[] }[] = [
  { key: 'box', vi: 'Hộp', fr: 'Boîtes', words: ['hop', 'box', 'tin', 'thiec', 'mica', 'carton', 'thung'] },
  { key: 'bag', vi: 'Túi', fr: 'Sacs', words: ['tui', 'bag', 'zip', 'nylon', 'nilon'] },
  { key: 'label', vi: 'Tem, nhãn, đai', fr: 'Étiquettes & bandes', words: ['tem', 'label', 'sticker', 'nhan', 'dai ', 'band', 'sleeve', 'phong bi', 'envelope', 'card', 'thiep', 'flyer', 'ruy bang', 'ribbon', 'tape', 'bang dinh'] },
  { key: 'tray', vi: 'Khay, đế, cốc, hũ', fr: 'Plateaux, socles, pots', words: ['khay', 'tray', 'de ', 'base', 'board', 'cup', 'coc', 'hu ', 'jar', 'bottle', 'lon', ' can', 'lid', 'nap', 'chai'] },
];
function pkGroup(name: string): string {
  const n = ` ${norm(name)} `;
  for (const g of PK_GROUPS) if (g.words.some(w => n.includes(w))) return g.key;
  return 'other';
}

type Line = CountLine & { saving?: boolean; failed?: boolean };
type View = 'count' | 'recap';

export default function StockCountView({ id }: { id: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const L = (v: string, f: string) => (vi ? v : f);
  const router = useRouter();
  const [header, setHeader] = useState<CountHeader | null>(null);
  const [items, setItems] = useState<CountItem[]>([]);
  const [lines, setLines] = useState<Record<number, Line>>({});
  const [unknowns, setUnknowns] = useState<Unknown[]>([]);
  const [aliases, setAliases] = useState<Map<number, string[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [zone, setZone] = useState<string>('');
  const [onlyTodo, setOnlyTodo] = useState(true);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [view, setView] = useState<View>('count');
  const [unkOpen, setUnkOpen] = useState(false);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    getCountAction(id).then(r => {
      if (r.error || !r.header) { setError(r.error ?? 'Error'); return; }
      setHeader(r.header); setItems(r.items ?? []); setUnknowns(r.unknowns ?? []);
      const m: Record<number, Line> = {}; for (const l of r.lines ?? []) m[l.tmplId] = l; setLines(m);
      const al = new Map<number, string[]>(); for (const [t, a] of r.aliases ?? []) al.set(t, [...(al.get(t) ?? []), a]); setAliases(al);
      setZone(r.header.kind === 'raw' ? 'dry' : 'all');
    });
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', on); on();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
  }, [id]);

  const byTmpl = useMemo(() => new Map(items.map(i => [i.tmplId, i])), [items]);
  const kind = header?.kind ?? 'raw';
  const locked = header?.status !== 'draft';
  const zoneOf = useCallback((i: CountItem) => (kind === 'raw' ? i.type : pkGroup(i.name)), [kind]);
  const nameOf = (i: CountItem) => (vi && i.nameVi ? i.nameVi : i.name);
  // search text: names (vi/en), code, brands, the team's own words
  const hay = useMemo(() => new Map(items.map(i => [i.tmplId, norm([i.name, i.nameVi, i.sku, ...i.brands, ...(aliases.get(i.tmplId) ?? [])].filter(Boolean).join(' '))])), [items, aliases]);
  const scopeIds = useMemo(() => new Set(Object.values(lines).filter(l => l.inScope).map(l => l.tmplId)), [lines]);
  const isCounted = (t: number) => { const l = lines[t]; return !!l && (l.qty != null || l.notFound); };

  const zones = useMemo(() => {
    if (kind === 'raw') return (['dry', 'fresh', 'frozen'] as const).map(k => ({ key: k, label: L({ dry: 'Khô', fresh: 'Mát / tươi', frozen: 'Đông lạnh' }[k], { dry: 'Sec', fresh: 'Frais', frozen: 'Surgelé' }[k]) }));
    return [{ key: 'all', label: L('Tất cả', 'Tout') }, ...PK_GROUPS.map(g => ({ key: g.key, label: L(g.vi, g.fr) })), { key: 'other', label: L('Khác', 'Autres') }];
  }, [kind, vi]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoneStats = useMemo(() => {
    const s: Record<string, { done: number; total: number }> = {};
    for (const t of Array.from(scopeIds)) { const i = byTmpl.get(t); if (!i) continue; const z = zoneOf(i); s[z] ??= { done: 0, total: 0 }; s[z].total++; if (isCounted(t)) s[z].done++; }
    return s;
  }, [scopeIds, byTmpl, lines, zoneOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = scopeIds.size, done = Array.from(scopeIds).filter(isCounted).length;

  const shown = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    let list: CountItem[];
    if (words.length) list = items.filter(i => words.every(w => hay.get(i.tmplId)!.includes(w)));   // search: whole catalogue
    else list = items.filter(i => scopeIds.has(i.tmplId) && (zone === 'all' || zoneOf(i) === zone) && (!onlyTodo || !isCounted(i.tmplId)));
    const subOrder = kind === 'raw' ? Object.keys(RAW_TYPES.dry.subs).concat(Object.keys(RAW_TYPES.fresh.subs), Object.keys(RAW_TYPES.frozen.subs)) : [];
    return list.sort((a, b) => (kind === 'raw' ? subOrder.indexOf(a.sub) - subOrder.indexOf(b.sub) : 0) || nameOf(a).localeCompare(nameOf(b)));
  }, [q, items, hay, scopeIds, zone, onlyTodo, lines, kind, vi]); // eslint-disable-line react-hooks/exhaustive-deps

  // long lists render in steps of 60 while scrolling (433 cards at once is slow on a phone)
  const [limit, setLimit] = useState(60);
  useEffect(() => { setLimit(60); }, [q, zone, onlyTodo]);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current; if (!el) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setLimit(l => l + 60); }, { rootMargin: '600px' });
    io.observe(el); return () => io.disconnect();
  }, [shown.length, limit]);

  // ---- background saving: one timer per item, retried while offline / failing
  const timers = useRef<Map<number, any>>(new Map());
  const queue = useRef<Map<number, { qty: number | null; entry: any; notFound: boolean }>>(new Map());
  const flush = useCallback(async (t: number) => {
    const v = queue.current.get(t); if (!v) return;
    queue.current.delete(t);
    const r = await saveCountLineAction(id, t, v).catch(() => ({ error: 'network' } as any));
    if (r.error) {
      if (!queue.current.has(t)) queue.current.set(t, v);
      setLines(m => ({ ...m, [t]: { ...m[t], saving: false, failed: true } }));
      timers.current.set(t, setTimeout(() => flush(t), 5000));
      return;
    }
    setLines(m => ({ ...m, [t]: { ...m[t], saving: queue.current.has(t), failed: false, countedAt: r.countedAt ?? null } }));
  }, [id]);
  const setQty = (t: number, qty: number | null, entry: any, notFound = false) => {
    setLines(m => ({ ...m, [t]: { ...(m[t] ?? { tmplId: t, inScope: false, countedBy: null, countedAt: null }), qty, entry, notFound, saving: true } }));
    queue.current.set(t, { qty, entry, notFound });
    clearTimeout(timers.current.get(t));
    timers.current.set(t, setTimeout(() => flush(t), 700));
  };
  const pending = Object.values(lines).filter(l => l.saving || l.failed).length;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (queue.current.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);

  if (error) return <div className="card p-6 text-sm" style={{ color: LATE }}>{error}</div>;
  if (!header) return <div className="p-10 text-center"><Loader2 className="animate-spin inline" /></div>;
  const openUnknown = unknowns.filter(u => u.status === 'open').length;

  return (
    <div className="w-full max-w-2xl mx-auto" style={{ backgroundColor: PALE, minHeight: '100vh' }}>
      <div className="sticky top-0 z-20 text-white px-4 pt-3 pb-3 space-y-2.5" style={{ backgroundColor: NAVY }}>
        <div className="flex items-center gap-2">
          <button aria-label="Back" onClick={() => (view === 'recap' ? setView('count') : router.push('/inventory'))} className="p-1 -ml-1"><ChevronLeft size={22} /></button>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-extrabold truncate">{kind === 'raw' ? L('Kiểm kê nguyên liệu', 'Matières premières') : L('Kiểm kê bao bì', 'Packaging')}{view === 'recap' ? ` · ${L('Tổng kết', 'Récap')}` : ''}</div>
            <div className="text-[11.5px]" style={{ color: '#D7E3DC' }}>{header.countDate} · LAB/Stock{locked ? ` · ${L('đã gửi', 'envoyé')}` : ''}</div>
          </div>
          <div className="text-right text-[12px] font-extrabold" style={{ color: '#E9D9A0' }}>{done}/{total}
            <div className="text-[10.5px] font-semibold flex items-center gap-1 justify-end" style={{ color: online && !Object.values(lines).some(l => l.failed) ? '#D7E3DC' : '#FFD6A5' }}>
              {!online ? <><AlertCircle size={11} /> {L('Mất mạng', 'Hors ligne')}</> : pending ? <><Loader2 size={11} className="animate-spin" /> {pending}</> : <><Check size={11} /> {L('Đã lưu', 'Enregistré')}</>}
            </div>
          </div>
        </div>
        <div className="h-1.5 rounded bg-white/20 overflow-hidden"><div className="h-1.5" style={{ width: `${total ? (done / total) * 100 : 0}%`, backgroundColor: GOLD }} /></div>
        {view === 'count' && (<>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
            {zones.map(z => {
              const st = z.key === 'all' ? { done, total } : zoneStats[z.key] ?? { done: 0, total: 0 };
              const on = zone === z.key && !q;
              return <button key={z.key} onClick={() => { setZone(z.key); setQ(''); }} className="flex-none rounded-full px-3 py-1.5 text-[12px] font-extrabold"
                style={on ? { backgroundColor: GOLD, color: '#1A2C24' } : { backgroundColor: 'rgba(255,255,255,.14)', color: '#fff' }}>
                {z.label} · {st.done === st.total && st.total ? '✓ ' : ''}{st.done}/{st.total}</button>;
            })}
          </div>
          <div className="flex gap-2">
            <label className="flex-1 min-w-0 flex items-center gap-2 bg-white rounded-lg px-2.5 py-2">
              <Search size={16} color="#5B6B63" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tìm: tên, mã, hiệu…', 'Chercher : nom, code, marque…')} className="flex-1 min-w-0 outline-none text-[15px] text-[#1A2C24] bg-transparent" />
              {q && <button aria-label="Clear" onClick={() => setQ('')}><X size={15} color="#5B6B63" /></button>}
            </label>
            {!locked && <button onClick={() => setUnkOpen(true)} aria-label={L('Không tìm thấy — chụp ảnh', 'Introuvable — photo')} className="flex-none flex flex-col items-center justify-center rounded-lg w-[64px] text-[10px] font-extrabold leading-tight" style={{ backgroundColor: GOLD_TEXT }}>
              <Camera size={17} /> {L('Không thấy', 'Introuvable')}</button>}
          </div>
        </>)}
      </div>

      {view === 'count' ? (
        <div className="px-3 pt-2 pb-28 space-y-2">
          {!q && <div className="flex items-center justify-between px-1 text-[12px]" style={{ color: '#5B6B63' }}>
            <span>{shown.length} {L('mặt hàng', 'articles')}</span>
            <button onClick={() => setOnlyTodo(v => !v)} className="font-bold" style={{ color: GOLD_TEXT }}>{onlyTodo ? L('Hiện cả đã đếm', 'Voir aussi les comptés') : L('Chỉ chưa đếm', 'Seulement non comptés')}</button>
          </div>}
          {q && <div className="px-1 text-[12px]" style={{ color: '#5B6B63' }}>{shown.length} {L('kết quả trong toàn bộ danh mục', 'résultats dans tout le catalogue')}</div>}
          {shown.length === 0 && <div className="card p-8 text-center text-sm" style={{ color: '#5B6B63' }}>{q ? L('Không thấy. Bấm "Không tìm thấy" để chụp ảnh.', 'Rien trouvé. « Introuvable » pour prendre une photo.') : L('Khu này đã đếm xong ✓', 'Zone terminée ✓')}</div>}
          <div className="space-y-2">
            {shown.slice(0, limit).map(i => <ItemCard key={i.tmplId} item={i} line={lines[i.tmplId]} name={nameOf(i)} vi={vi} locked={locked} open={open === i.tmplId}
              onOpen={() => setOpen(open === i.tmplId ? null : i.tmplId)} onSet={(qty, entry, nf) => setQty(i.tmplId, qty, entry, nf)} outOfList={!scopeIds.has(i.tmplId)} />)}
          </div>
          {shown.length > limit && <div ref={more} className="py-4 text-center text-[12px]" style={{ color: '#5B6B63' }}><Loader2 size={14} className="animate-spin inline" /></div>}
        </div>
      ) : (
        <Recap id={id} vi={vi} header={header} items={items} byTmpl={byTmpl} lines={lines} scopeIds={scopeIds} unknowns={unknowns} setUnknowns={setUnknowns}
          hay={hay} nameOf={nameOf} zoneOf={zoneOf} zones={zones} onLinesChanged={() => getCountAction(id).then(r => { const m: Record<number, Line> = {}; for (const l of r.lines ?? []) m[l.tmplId] = l; setLines(m); })}
          onSent={h => setHeader(h)} />
      )}

      {view === 'count' && (
        <div className="fixed bottom-0 left-0 right-0 z-20 bg-white px-3 pt-2 pb-3 flex gap-2 max-w-2xl mx-auto" style={{ borderTop: `1px solid ${HAIR}` }}>
          <button onClick={() => setView('recap')} className="flex-1 rounded-xl py-3 text-[14px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>
            {L('Tổng kết', 'Récap')}{openUnknown ? ` · ${openUnknown} ${L('ảnh cần xác định', 'photo(s) à identifier')}` : ''} ›</button>
        </div>
      )}
      {unkOpen && <UnknownSheet countId={id} vi={vi} zone={zone} onClose={() => setUnkOpen(false)} onAdded={u => { setUnknowns(x => [...x, u]); setUnkOpen(false); }} />}
    </div>
  );
}

// ---- one product card ---------------------------------------------------------------------------
function ItemCard({ item, line, name, vi, locked, open, onOpen, onSet, outOfList }: {
  item: CountItem; line?: Line; name: string; vi: boolean; locked: boolean; open: boolean; outOfList: boolean;
  onOpen: () => void; onSet: (qty: number | null, entry: any, notFound?: boolean) => void;
}) {
  const L = (v: string, f: string) => (vi ? v : f);
  const counted = !!line && (line.qty != null || line.notFound);
  const pack = item.packs[0] ?? null;
  const brands = item.brands.length > 1 ? item.brands : [];
  const e = line?.entry ?? {};
  const [n, setN] = useState<string>(e.n != null ? String(e.n) : '');
  const [x, setX] = useState<string>(e.x != null ? String(e.x) : (!pack && !brands.length && line?.qty != null ? String(line.qty) : ''));
  const [b, setB] = useState<Record<string, string>>(() => Object.fromEntries(brands.map(br => [br, e.b?.[br] != null ? String(e.b[br]) : ''])));
  const push = (nn: string, xx: string, bb: Record<string, string>) => {
    if (brands.length) {
      const vals = brands.map(br => parseNum(bb[br] ?? ''));
      if (vals.some(v => Number.isNaN(v))) return;
      const any = vals.some(v => v != null);
      onSet(any ? vals.reduce<number>((s, v) => s + (v ?? 0), 0) : null, any ? { b: Object.fromEntries(brands.map((br, k) => [br, vals[k]])) } : null);
      return;
    }
    const pn = parseNum(nn), px = parseNum(xx);
    if (Number.isNaN(pn) || Number.isNaN(px)) return;
    if (pn == null && px == null) { onSet(null, null); return; }
    onSet((pn ?? 0) * (pack?.factor ?? 0) + (px ?? 0), pack ? { n: pn, x: px } : null);
  };
  const step = (d: number) => { const v = Math.max(0, (parseNum(n) || 0) + d); const s = String(v); setN(s); push(s, x, b); };
  const summary = line?.notFound ? L('Không thấy', 'Pas trouvé') : line?.qty != null ? `${fmt(line.qty)} ${item.uom}` : null;
  const otherName = vi ? item.name : item.nameVi;
  const other = otherName && norm(otherName) !== norm(name) ? otherName : null;
  return (
    <div className="bg-white rounded-2xl overflow-hidden" style={{ border: open ? `2px solid ${NAVY}` : `1px solid ${counted ? '#BFD9C8' : BORDER}` }}>
      <button onClick={onOpen} className="w-full text-left flex items-center gap-3 p-2.5">
        <ItemPhoto tmplId={item.tmplId} sku={item.sku} size={open ? 76 : 60} canAdd={!locked} />
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="text-[14px] font-extrabold leading-snug line-clamp-2" style={{ color: '#1A2C24' }}>{name}</div>
          <div className="text-[11.5px] leading-snug line-clamp-2" style={{ color: '#5B6B63' }}>{[other, item.sku, pack ? pack.label : item.uom].filter(Boolean).join(' · ')}</div>
          {outOfList && <div className="text-[10.5px] font-bold" style={{ color: GOLD_TEXT }}>{L('Ngoài danh sách', 'Hors liste')}</div>}
          {line?.saving && <div className="text-[10.5px]" style={{ color: '#5B6B63' }}>…</div>}
          {line?.failed && <div className="text-[10.5px] font-bold" style={{ color: LATE }}>{L('Chưa lưu, đang thử lại', 'Pas encore enregistré, nouvel essai')}</div>}
        </div>
        {summary && !open
          ? <span className="flex-none text-[12px] font-extrabold rounded-lg px-2 py-1 text-white max-w-[38%] truncate" style={{ backgroundColor: line?.notFound || line?.qty === 0 ? '#5B6B63' : OK }}>✓ {summary}</span>
          : !open ? <span className="flex-none w-9 h-9 rounded-full flex items-center justify-center text-[20px] font-extrabold text-white" style={{ backgroundColor: NAVY }} aria-hidden>+</span> : null}
      </button>
      {open && !locked && (
        <div className="px-3 pb-3 space-y-2.5">
          {brands.length ? (
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, brands.length)}, minmax(0,1fr))` }}>
              {brands.map(br => <label key={br} className="text-[11px] font-bold space-y-1" style={{ color: '#5B6B63' }}>{br}
                <input inputMode="decimal" value={b[br] ?? ''} onChange={ev => { const nb = { ...b, [br]: ev.target.value }; setB(nb); push(n, x, nb); }} placeholder={item.uom}
                  className="w-full rounded-lg px-2.5 py-2.5 text-[16px] font-extrabold" style={{ border: '1px solid #D1D5DB', color: '#1A2C24' }} /></label>)}
            </div>
          ) : pack ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button aria-label="-1" onClick={() => step(-1)} className="w-11 h-11 rounded-lg text-[20px] font-extrabold" style={{ border: '1px solid #D1D5DB', color: NAVY }}>−</button>
              <input inputMode="decimal" value={n} onChange={ev => { setN(ev.target.value); push(ev.target.value, x, b); }} aria-label={pack.label}
                className="w-16 h-11 rounded-lg text-center text-[17px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
              <button aria-label="+1" onClick={() => step(1)} className="w-11 h-11 rounded-lg text-[20px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>+</button>
              <span className="text-[12px]" style={{ color: '#5B6B63' }}>{pack.label} +</span>
              <input inputMode="decimal" value={x} onChange={ev => { setX(ev.target.value); push(n, ev.target.value, b); }} aria-label={item.uom}
                className="w-16 h-11 rounded-lg text-center text-[16px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
              <span className="text-[12px]" style={{ color: '#5B6B63' }}>{item.uom}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input inputMode="decimal" autoFocus value={x} onChange={ev => { setX(ev.target.value); push(n, ev.target.value, b); }} placeholder={item.uom}
                className="flex-1 h-12 rounded-lg px-3 text-[18px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
              <span className="text-[13px] font-bold" style={{ color: '#5B6B63' }}>{item.uom}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[14px] font-extrabold" style={{ color: line?.qty != null ? OK : '#5B6B63' }}>{line?.qty != null ? `= ${fmt(line.qty)} ${item.uom}` : ''}</span>
            <button onClick={() => { setN(''); setX(''); setB(Object.fromEntries(brands.map(br => [br, '']))); onSet(0, null); }} className="rounded-lg px-3 py-2 text-[13px] font-extrabold" style={{ border: `1px solid ${NAVY}`, color: NAVY }}>= 0</button>
            <button onClick={() => { setN(''); setX(''); onSet(null, null, true); }} className="rounded-lg px-2.5 py-2 text-[12px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#5B6B63' }}>{L('Không thấy', 'Pas trouvé')}</button>
            {counted && <button aria-label="Reset" onClick={() => { setN(''); setX(''); setB(Object.fromEntries(brands.map(br => [br, '']))); onSet(null, null); }} className="p-2" style={{ color: '#5B6B63' }}><X size={16} /></button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- "Je ne trouve pas": photo + quantity + a word ----------------------------------------------
function UnknownSheet({ countId, vi, zone, onClose, onAdded }: { countId: string; vi: boolean; zone: string; onClose: () => void; onAdded: (u: Unknown) => void }) {
  const L = (v: string, f: string) => (vi ? v : f);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [qty, setQty] = useState(''); const [unit, setUnit] = useState('kg'); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.click(); }, []);
  const pick = async (f?: File) => { if (!f) return; const c = await compressImage(f, 1280, 0.8).catch(() => f); setFile(c); setPreview(URL.createObjectURL(c)); };
  const send = async () => {
    if (!file && !note.trim()) { setErr(L('Chụp ảnh hoặc ghi chú', 'Photo ou un mot requis')); return; }
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.set('countId', countId); if (file) fd.set('file', file, 'photo.jpg');
    fd.set('qty', qty); fd.set('unit', unit); fd.set('note', note); fd.set('zone', zone);
    const r = await addUnknownAction(fd); setBusy(false);
    if (r.error || !r.unknown) { setErr(r.error ?? 'Error'); return; }
    onAdded(r.unknown);
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between"><div className="text-[16px] font-extrabold" style={{ color: NAVY }}>{L('Không tìm thấy sản phẩm', 'Article introuvable')}</div>
          <button aria-label="Close" onClick={onClose}><X size={20} /></button></div>
        <button onClick={() => input.current?.click()} className="w-full h-48 rounded-xl flex items-center justify-center overflow-hidden" style={{ backgroundColor: '#F3EBD2' }}>
          {preview ? <img src={preview} alt="" className="w-full h-full object-cover" /> : <span className="flex flex-col items-center gap-1 text-[13px] font-bold" style={{ color: GOLD_TEXT }}><Camera size={28} />{L('Chụp ảnh', 'Prendre la photo')}</span>}
        </button>
        <input ref={input} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => pick(e.target.files?.[0])} />
        <div className="flex gap-2">
          <input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} placeholder={L('Số lượng', 'Quantité')} className="w-24 rounded-lg px-3 py-2.5 text-[16px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
          <select value={unit} onChange={e => setUnit(e.target.value)} className="rounded-lg px-2 text-[14px] bg-white" style={{ border: '1px solid #D1D5DB' }}>
            {['kg', 'g', 'L', vi ? 'gói' : 'sachet', vi ? 'hộp' : 'boîte', vi ? 'chai' : 'bouteille', vi ? 'cái' : 'pièce'].map(u => <option key={u}>{u}</option>)}
          </select>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={L('Tên gọi (vd: miến khô)', 'Un mot (ex : miến khô)')} className="flex-1 min-w-0 rounded-lg px-3 py-2.5 text-[14px]" style={{ border: '1px solid #D1D5DB' }} />
        </div>
        {err && <div className="text-[13px] font-semibold" style={{ color: LATE }}>{err}</div>}
        <button disabled={busy} onClick={send} className="w-full rounded-xl py-3 text-[14px] font-extrabold text-white disabled:opacity-60" style={{ backgroundColor: GOLD_TEXT }}>
          {busy ? <Loader2 size={16} className="animate-spin inline" /> : L('Gửi "cần xác định" và đếm tiếp', 'Envoyer « à identifier » et continuer')}</button>
      </div>
    </div>
  );
}

// ---- Recap: photos to identify, not counted, gaps, send ------------------------------------------
function Recap({ id, vi, header, items, byTmpl, lines, scopeIds, unknowns, setUnknowns, hay, nameOf, zoneOf, zones, onLinesChanged, onSent }: {
  id: string; vi: boolean; header: CountHeader; items: CountItem[]; byTmpl: Map<number, CountItem>; lines: Record<number, Line>; scopeIds: Set<number>;
  unknowns: Unknown[]; setUnknowns: (f: (u: Unknown[]) => Unknown[]) => void; hay: Map<number, string>; nameOf: (i: CountItem) => string;
  zoneOf: (i: CountItem) => string; zones: { key: string; label: string }[]; onLinesChanged: () => void; onSent: (h: CountHeader) => void;
}) {
  const L = (v: string, f: string) => (vi ? v : f);
  const [gaps, setGaps] = useState<RecapLine[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const all = Object.values(lines);
  const counted = all.filter(l => l.qty != null && l.qty > 0).length;
  const zeros = all.filter(l => l.qty === 0).length;
  const notFound = all.filter(l => l.notFound).length;
  const todo = Array.from(scopeIds).filter(t => { const l = lines[t]; return !l || (l.qty == null && !l.notFound); }).map(t => byTmpl.get(t)).filter(Boolean) as CountItem[];
  const openU = unknowns.filter(u => u.status === 'open');
  const zoneLabel = (i: CountItem) => zones.find(z => z.key === zoneOf(i))?.label ?? '';
  const locked = header.status !== 'draft';

  const csv = () => {
    const rows = [['SKU', 'Name', 'Tên', 'Zone', 'UoM'], ...todo.map(i => [i.sku ?? '', i.name, i.nameVi ?? '', zoneLabel(i), i.uom])];
    const text = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `lab-inventory-${header.countDate}-${header.kind}-not-counted.csv`; a.click();
  };
  const calc = async () => { setBusy('calc'); setErr(null); const r = await recapCountAction(id); setBusy(null); if (r.error) setErr(r.error); else setGaps(r.lines ?? []); };
  const send = async () => {
    if (!window.confirm(L('Gửi lên Odoo dạng nháp (chưa áp dụng)?', 'Envoyer dans Odoo en brouillon (non appliqué) ?'))) return;
    setBusy('send'); setErr(null); const r = await submitCountAction(id); setBusy(null);
    if (r.error) { setErr(r.error); return; }
    setSent(L(`Đã gửi ${r.lines} dòng. Phiếu Odoo #${r.inventoryId} ở trạng thái nháp.`, `${r.lines} lignes envoyées. Feuille Odoo #${r.inventoryId} en brouillon.`));
    onSent({ ...header, status: 'submitted', odooInventoryId: r.inventoryId ?? null });
  };
  const top = (gaps ?? []).filter(g => g.alert || Math.abs(g.value ?? 0) > 0).sort((a, b) => (b.alert ? 1e15 : Math.abs(b.value ?? 0)) - (a.alert ? 1e15 : Math.abs(a.value ?? 0))).slice(0, 15);
  const net = (gaps ?? []).reduce((s, g) => s + (g.value ?? 0), 0);

  return (
    <div className="px-3 pt-3 pb-28 space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {[[counted, L('đã đếm', 'comptés')], [zeros, '= 0'], [notFound, L('không thấy', 'pas trouvés')], [todo.length, L('chưa đếm', 'non comptés')]].map(([v, l], k) =>
          <div key={k} className="bg-white rounded-xl p-2.5" style={{ border: `1px solid ${k === 3 && todo.length ? '#E8C979' : BORDER}`, backgroundColor: k === 3 && todo.length ? '#FFF6E0' : '#fff' }}>
            <div className="text-[19px] font-extrabold" style={{ color: NAVY }}>{v}</div><div className="text-[11px]" style={{ color: '#5B6B63' }}>{l}</div></div>)}
      </div>

      {!!unknowns.length && (
        <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `2px solid ${openU.length ? GOLD : BORDER}` }}>
          <div className="text-[14px] font-extrabold flex items-center gap-2"><Camera size={16} color={GOLD_TEXT} /> {L('Ảnh cần xác định', 'Photos à identifier')} · {openU.length}/{unknowns.length}</div>
          {openU.length ? <div className="text-[12px]" style={{ color: '#6B4A00' }}>{L('Phải xử lý trước khi gửi.', 'À traiter avant l\'envoi.')}</div> : null}
          {unknowns.map(u => <UnknownRow key={u.id} u={u} vi={vi} items={items} hay={hay} nameOf={nameOf} locked={locked}
            onDone={(nu) => { setUnknowns(x => x.map(y => (y.id === u.id ? nu : y))); onLinesChanged(); }} />)}
        </div>
      )}

      <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between"><div className="text-[14px] font-extrabold">{todo.length} {L('chưa đếm', 'non comptés')}</div>
          {!!todo.length && <button onClick={csv} className="flex items-center gap-1 text-[12px] font-bold" style={{ color: GOLD_TEXT }}><Download size={14} /> Excel</button>}</div>
        <div className="text-[12px]" style={{ color: '#5B6B63' }}>{L('Giữ nguyên trên Odoo (không đưa về 0).', 'Laissés tels quels dans Odoo (pas mis à 0).')}</div>
        <div className="max-h-56 overflow-y-auto">
          {todo.slice(0, 200).map(i => <div key={i.tmplId} className="flex justify-between gap-2 py-1.5 text-[12.5px]" style={{ borderTop: `1px solid ${HAIR}` }}><span className="truncate">{nameOf(i)}</span><span className="flex-none" style={{ color: '#5B6B63' }}>{zoneLabel(i)}</span></div>)}
        </div>
      </div>

      <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between"><div className="text-[14px] font-extrabold">{L('Chênh lệch', 'Écarts')}</div>
          <button disabled={!!busy} onClick={calc} className="rounded-lg px-3 py-1.5 text-[12px] font-extrabold disabled:opacity-60" style={{ border: `1px solid ${NAVY}`, color: NAVY }}>
            {busy === 'calc' ? <Loader2 size={14} className="animate-spin inline" /> : gaps ? L('Tính lại', 'Recalculer') : L('Tính chênh lệch', 'Calculer les écarts')}</button></div>
        <div className="text-[12px]" style={{ color: '#5B6B63' }}>{L('Mỗi dòng so với tồn lý thuyết tại giờ đếm của nó.', 'Chaque article est comparé au stock théorique à son heure de comptage.')}</div>
        {gaps && <div className="text-[13px] font-bold">{L('Tổng', 'Net')} : <span style={{ color: net < 0 ? LATE : OK }}>{vnd(net)}</span></div>}
        {top.map(g => { const i = byTmpl.get(g.tmplId); return (
          <div key={g.tmplId} className="flex items-start gap-2 py-1.5 text-[12.5px]" style={{ borderTop: `1px solid ${HAIR}` }}>
            {g.alert ? <span className="flex-none text-[10.5px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: '#FBEAE8', color: LATE }}>{L('đơn vị?', 'unité ?')}</span> : null}
            <span className="flex-1 min-w-0">{i ? nameOf(i) : g.tmplId}<span style={{ color: '#5B6B63' }}> · {fmt(g.qty)} / {fmt(g.theoretical)} {i?.uom}</span></span>
            <span className="flex-none font-bold" style={{ color: g.diff < 0 ? LATE : OK }}>{g.diff > 0 ? '+' : ''}{fmt(g.diff)}{g.value != null ? ` · ${vnd(g.value)}` : ''}</span>
          </div>); })}
      </div>

      {err && <div className="rounded-xl p-3 text-[13px] font-semibold flex gap-2" style={{ backgroundColor: '#FBEAE8', color: LATE }}><AlertTriangle size={16} className="flex-none" />{err}</div>}
      {(sent || locked) && <div className="rounded-xl p-3 text-[13px] font-semibold" style={{ backgroundColor: '#E6EFE9', color: NAVY }}>{sent ?? L(`Đã gửi. Phiếu Odoo #${header.odooInventoryId} (nháp).`, `Envoyé. Feuille Odoo #${header.odooInventoryId} (brouillon).`)}</div>}
      {!locked && !sent && (
        <div className="fixed bottom-0 left-0 right-0 z-20 bg-white px-3 pt-2 pb-3 max-w-2xl mx-auto" style={{ borderTop: `1px solid ${HAIR}` }}>
          <button disabled={!!busy || openU.length > 0} onClick={send} className="w-full rounded-xl py-3 text-[14px] font-extrabold text-white disabled:opacity-50 flex items-center justify-center gap-2" style={{ backgroundColor: NAVY }}>
            {busy === 'send' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} {openU.length ? L(`Còn ${openU.length} ảnh cần xác định`, `Encore ${openU.length} photo(s) à identifier`) : L('Gửi lên Odoo (nháp)', 'Envoyer à Odoo (brouillon)')}</button>
        </div>
      )}
    </div>
  );
}

function UnknownRow({ u, vi, items, hay, nameOf, locked, onDone }: { u: Unknown; vi: boolean; items: CountItem[]; hay: Map<number, string>; nameOf: (i: CountItem) => string; locked: boolean; onDone: (u: Unknown) => void }) {
  const L = (v: string, f: string) => (vi ? v : f);
  const [q, setQ] = useState(u.note ?? '');
  const [pick, setPick] = useState<CountItem | null>(null);
  const [qty, setQty] = useState(u.qty != null ? String(u.qty) : '');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const res = useMemo(() => { const w = norm(q).split(/\s+/).filter(Boolean); return w.length ? items.filter(i => w.every(x => hay.get(i.tmplId)!.includes(x))).slice(0, 8) : []; }, [q, items, hay]);
  const done = async (status: 'matched' | 'absent' | 'ignored') => {
    const n = parseNum(qty);
    if (status === 'matched' && (!pick || n == null || Number.isNaN(n))) { setErr(L('Chọn sản phẩm và số lượng', 'Choisis le produit et la quantité')); return; }
    setBusy(true); setErr(null);
    const r = await resolveUnknownAction(u.id, { status, tmplId: pick?.tmplId, qty: n ?? undefined });
    setBusy(false); if (r.error) { setErr(r.error); return; }
    onDone({ ...u, status, tmplId: pick?.tmplId ?? null });
  };
  const resolvedName = u.tmplId ? items.find(i => i.tmplId === u.tmplId) : null;
  return (
    <div className="rounded-xl p-2.5 space-y-2" style={{ border: `1px solid ${HAIR}` }}>
      <div className="flex gap-2.5">
        {u.photoUrl ? <a href={u.photoUrl} target="_blank" rel="noreferrer"><img src={u.photoUrl} alt="" className="w-20 h-20 rounded-lg object-cover" /></a> : <div className="w-20 h-20 rounded-lg" style={{ backgroundColor: '#F3EBD2' }} />}
        <div className="flex-1 min-w-0 text-[12.5px] space-y-0.5">
          <div className="font-extrabold text-[13.5px]">{u.qty != null ? `${fmt(u.qty)} ${u.unit ?? ''}` : '—'}{u.note ? ` · « ${u.note} »` : ''}</div>
          <div style={{ color: '#5B6B63' }}>{u.createdBy} · {new Date(u.createdAt).toLocaleString('fr-FR', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          {u.status !== 'open' && <div className="font-bold" style={{ color: u.status === 'matched' ? OK : '#5B6B63' }}>
            {u.status === 'matched' ? `✓ ${resolvedName ? nameOf(resolvedName) : ''}` : u.status === 'absent' ? L('Không có trên Odoo', 'Absent d\'Odoo') : L('Không kiểm kê', 'Hors inventaire')}</div>}
        </div>
      </div>
      {u.status === 'open' && !locked && (<>
        <label className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ border: `2px solid ${NAVY}` }}>
          <Search size={15} color="#5B6B63" /><input value={q} onChange={e => { setQ(e.target.value); setPick(null); }} placeholder={L('Tìm sản phẩm Odoo', 'Chercher le produit')} className="flex-1 outline-none text-[14px]" />
        </label>
        {!pick && res.map(i => <button key={i.tmplId} onClick={() => setPick(i)} className="w-full flex items-center gap-2 text-left rounded-lg p-1.5" style={{ border: `1px solid ${BORDER}` }}>
          <ItemPhoto tmplId={i.tmplId} sku={i.sku} size={40} /><span className="flex-1 min-w-0 text-[12.5px]"><b>{nameOf(i)}</b><br /><span style={{ color: '#5B6B63' }}>{[i.sku, i.uom].filter(Boolean).join(' · ')}</span></span></button>)}
        {pick && <div className="flex items-center gap-2 flex-wrap">
          <span className="flex-1 min-w-0 text-[13px] font-extrabold">{nameOf(pick)}</span>
          <input inputMode="decimal" value={qty} onChange={e => setQty(e.target.value)} className="w-20 rounded-lg px-2 py-2 text-[15px] font-extrabold" style={{ border: '1px solid #D1D5DB' }} />
          <span className="text-[12px]" style={{ color: '#5B6B63' }}>{pick.uom}</span>
          <button disabled={busy} onClick={() => done('matched')} className="rounded-lg px-3 py-2 text-[12.5px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{L('Chọn', 'Choisir')}</button>
        </div>}
        {err && <div className="text-[12px] font-semibold" style={{ color: LATE }}>{err}</div>}
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => done('absent')} className="flex-1 rounded-lg py-2 text-[12px] font-bold" style={{ border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>{L('Chưa có trên Odoo', 'Absent d\'Odoo')}</button>
          <button disabled={busy} onClick={() => done('ignored')} className="flex-1 rounded-lg py-2 text-[12px] font-bold" style={{ border: `1px solid ${BORDER}`, color: '#5B6B63' }}>{L('Không kiểm kê', 'Hors inventaire')}</button>
        </div>
      </>)}
    </div>
  );
}
