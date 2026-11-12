'use client';
// Chef test recipes (Axel, 2026-11-12) — pilot Team Hung. A library the chef can sort, file and search
// (stage, family, collection, tags, pins, target date), a test sheet with versions (compare two), the
// recipe for one batch (raw materials with photos, intermediate recipes from Odoo or written here),
// the method, and the trials (photo, tasting, verdict). No cost is ever shown.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, Camera, Plus, X, Star, Pin, MoreHorizontal, ChevronLeft, LayoutGrid, List, ArrowUpDown, Trash2, Pencil, GitCompare, Layers, CheckCircle2, Send } from 'lucide-react';
import ItemPhoto from '@/components/raw/ItemPhoto';
import {
  listTestsAction, getTestAction, createTestAction, updateTestAction, saveVersionAction, newVersionAction, deleteVersionAction,
  addTrialAction, sendToOfficeAction, listIntermediatesAction, listTeamProductsAction,
} from './test-actions';
import { getRawCatalogForChefAction, uploadRawPhotoAction } from './raw-actions';
import { TEST_STAGES, TEST_FAMILIES, trialConsumption, type TestSummary, type TestVersion, type TestTrial, type Recipe, type RecipeRow, type RecipeSub, type RecipeStep, type TestStage } from '@/lib/chef-rd';
import type { RawMaterial } from '@/lib/raw-materials';

const NAVY = '#2A1810', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FBF7F0', BORDER = '#E6DCCF', HAIR = '#EFE6D8', LATE = '#B42318';
const STAGE_COLORS: Record<TestStage, [string, string]> = {
  idea: ['#F3EDE3', '#5E4E42'], testing: ['#FEF3C7', '#92400E'], sent: ['#FBF4E1', '#8A6418'],
  approved: ['#E8F2EB', '#256A45'], odoo: [NAVY, '#FFFFFF'], archived: ['#F3EDE3', '#6B5A4C'],
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const comma = (n: number) => String(n).replace('.', ',');
const isMass = (u: string) => /^kg$/i.test(u);
const isVol = (u: string) => /^(l|lít|litre|liter)$/i.test(u);
/** Chefs read grams / ml: kg and L are shown and typed ×1000. */
function show(q: number, uom: string, L: (a: string, b: string) => string): string {
  if (isMass(uom)) { const g = q * 1000; return g >= 1000 ? `${comma(r3(q))} kg` : `${comma(Math.round(g * 10) / 10)} g`; }
  if (isVol(uom)) { const ml = q * 1000; return ml >= 1000 ? `${comma(r3(q))} L` : `${comma(Math.round(ml))} ml`; }
  if (/unit|pcs|cái/i.test(uom)) return `${comma(r3(q))} ${L('cái', 'pcs')}`;
  return `${comma(r3(q))} ${uom}`;
}
const inUnit = (uom: string) => (isMass(uom) ? 'g' : isVol(uom) ? 'ml' : /unit/i.test(uom) ? 'pcs' : uom);
const toInput = (q: number, uom: string) => (isMass(uom) || isVol(uom) ? r3(q * 1000) : r3(q));
const fromInput = (v: number, uom: string) => (isMass(uom) || isVol(uom) ? v / 1000 : v);
const num = (s: string) => { const v = Number(String(s).replace(',', '.')); return Number.isFinite(v) ? v : NaN; };
const vnDate = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
const daysTo = (iso: string) => Math.round((Date.parse(iso + 'T00:00:00+07:00') - Date.now()) / 86400000);

async function compressImage(file: File): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const max = 1280; const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return await new Promise<Blob>(res => c.toBlob(b => res(b!), 'image/jpeg', 0.82));
}
async function uploadPhoto(f: File): Promise<{ url?: string; error?: string }> {
  const blob = await compressImage(f);
  const fd = new FormData(); fd.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
  return uploadRawPhotoAction(fd);
}

type Sheet =
  | { k: 'new' } | { k: 'info' } | { k: 'menu' } | { k: 'trial' } | { k: 'newVersion' }
  | { k: 'pickRaw'; target: 'direct' | string } | { k: 'pickSm' } | { k: 'newSub' };

const SORTS = ['activity', 'target', 'name', 'trials'] as const;

export default function TestsTab({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const [tests, setTests] = useState<TestSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // library
  const [q, setQ] = useState('');
  const [stage, setStage] = useState<'all' | TestStage>('all');
  const [fam, setFam] = useState('all');
  const [coll, setColl] = useState('all');
  const [sort, setSort] = useState<typeof SORTS[number]>('activity');
  const [grid, setGrid] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  // detail
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ test: TestSummary; versions: TestVersion[]; trials: TestTrial[]; canValidate: boolean } | null>(null);
  const [verN, setVerN] = useState<number | null>(null);
  const [dtab, setDtab] = useState<'recipe' | 'method' | 'trials'>('recipe');
  const [mult, setMult] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ yieldPcs: string; weight: string; note: string; recipe: Recipe; steps: RecipeStep[] } | null>(null);
  const [compare, setCompare] = useState<[number, number] | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // catalogues
  const [raw, setRaw] = useState<RawMaterial[] | null>(null);
  const [sms, setSms] = useState<{ productId: number; sku: string | null; name: string; uom: string }[] | null>(null);
  const [products, setProducts] = useState<{ sku: string; name: string; photo: string | null }[] | null>(null);
  const [pickQ, setPickQ] = useState('');
  // forms
  const [nf, setNf] = useState({ name: '', start: 'new' as 'new' | 'improve' | 'copy', sku: '', skuName: '', copyId: '', family: TEST_FAMILIES[0], collection: '', target: '' });
  const [info, setInfo] = useState({ name: '', family: '', collection: '', tags: '', target: '' });
  const [trial, setTrial] = useState({ verN: 0, pcs: '1', stars: 0, verdict: '' as '' | 'ok' | 'adjust' | 'failed', note: '', photo: null as string | null });
  const [newVerNote, setNewVerNote] = useState('');
  const [newSub, setNewSub] = useState({ name: '', batch: '1000', use: '' });
  const [qtyDraft, setQtyDraft] = useState<Record<string, string>>({});
  const photoRef = useRef<HTMLInputElement>(null);
  const [photoFor, setPhotoFor] = useState<'trial' | 'test' | null>(null);

  const loadList = useCallback(async () => {
    const r = await listTestsAction(team);
    if (r.error) setErr(r.error); else { setErr(null); setTests(r.items!); }
  }, [team]);
  useEffect(() => { loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: string, keepVer = false) => {
    const r = await getTestAction(team, id);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setDetail({ test: r.test!, versions: r.versions!, trials: r.trials!, canValidate: !!r.canValidate });
    if (!keepVer) setVerN(r.versions!.length ? r.versions![r.versions!.length - 1].n : null);
  }, [team]);

  const needRaw = useCallback(() => { if (!raw) getRawCatalogForChefAction().then(r => setRaw(r.items ?? [])); }, [raw]);
  const needSm = useCallback(() => { if (!sms) listIntermediatesAction(team).then(r => setSms(r.items ?? [])); }, [sms, team]);
  const needProducts = useCallback(() => { if (!products) listTeamProductsAction(team).then(r => setProducts(r.items ?? [])); }, [products, team]);

  // ── library ──────────────────────────────────────────────────────────────
  const collections = useMemo(() => Array.from(new Set((tests ?? []).map(t => t.collection).filter(Boolean) as string[])).sort(), [tests]);
  const families = useMemo(() => Array.from(new Set((tests ?? []).map(t => t.family).filter(Boolean) as string[])).sort(), [tests]);
  const sq = q.trim().toLowerCase();
  const matchQ = (t: TestSummary) => !sq || `${t.name} ${t.searchText} ${t.tags.join(' ')} ${t.collection ?? ''} ${t.family ?? ''} ${t.improveName ?? ''}`.toLowerCase().includes(sq);
  const inStage = (t: TestSummary, s: 'all' | TestStage) => (s === 'all' ? (sq ? true : t.stage !== 'archived') : t.stage === s);
  const base = (tests ?? []).filter(t => (fam === 'all' || t.family === fam) && (coll === 'all' || t.collection === coll) && matchQ(t));
  const list = base.filter(t => inStage(t, stage)).sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'trials') return b.trialCount - a.trialCount;
    if (sort === 'target') return (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999');
    return b.lastActivity.localeCompare(a.lastActivity);
  });
  const pinned = list.filter(t => t.pinned), others = list.filter(t => !t.pinned);
  const sortLabel = { activity: L('Mới hoạt động', 'Last activity'), target: L('Hạn mục tiêu', 'Target date'), name: L('Tên A–Z', 'Name A–Z'), trials: L('Nhiều lần thử', 'Most trials') }[sort];
  const stageLabel = (s: TestStage) => { const x = TEST_STAGES.find(y => y.k === s)!; return lang === 'vi' ? x.vi : x.en; };
  const pill = (s: TestStage) => ({ backgroundColor: STAGE_COLORS[s][0], color: STAGE_COLORS[s][1] });

  // ── detail helpers ───────────────────────────────────────────────────────
  const test = detail?.test ?? null;
  const ver = detail?.versions.find(v => v.n === verN) ?? detail?.versions[detail.versions.length - 1] ?? null;
  const editable = !!ver && ver.trialCount === 0 && test?.stage !== 'sent' && test?.stage !== 'approved' && test?.stage !== 'odoo';
  const recipe = edit ? edit.recipe : ver?.recipe ?? { subs: [], direct: [] };
  const yieldPcs = edit ? (num(edit.yieldPcs) > 0 ? num(edit.yieldPcs) : 1) : ver?.yieldPcs ?? 1;
  const m = mult ?? yieldPcs;
  const f = m / yieldPcs;

  function startEdit() {
    if (!ver) return;
    setEdit({ yieldPcs: String(ver.yieldPcs), weight: ver.pieceWeightG ? String(ver.pieceWeightG) : '', note: ver.note ?? '', recipe: JSON.parse(JSON.stringify(ver.recipe)), steps: JSON.parse(JSON.stringify(ver.steps)) });
    setMult(null); setQtyDraft({});
  }
  async function saveEdit() {
    if (!edit || !ver || !test) return;
    const y = num(edit.yieldPcs);
    if (!(y > 0)) { setMsg({ ok: false, text: L('Số cái mỗi mẻ phải > 0', 'Pieces per batch must be > 0') }); return; }
    setBusy(true);
    const w = num(edit.weight);
    const r = await saveVersionAction(team, ver.id, { yieldPcs: y, pieceWeightG: w > 0 ? w : null, note: edit.note, recipe: edit.recipe, steps: edit.steps.filter(s => s.title.trim() || s.text.trim()) });
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setEdit(null); setMsg({ ok: true, text: L('Đã lưu.', 'Saved.') });
    await loadDetail(test.id, true); loadList();
  }
  const setRecipe = (fn: (r: Recipe) => void) => setEdit(e => { if (!e) return e; const r = JSON.parse(JSON.stringify(e.recipe)) as Recipe; fn(r); return { ...e, recipe: r }; });
  const qtyInput = (key: string, q: number, uom: string, onSet: (v: number) => void) => (
    <span className="inline-flex items-center gap-1">
      <input inputMode="decimal" value={qtyDraft[key] ?? comma(toInput(q, uom))}
        onChange={e => { setQtyDraft(d => ({ ...d, [key]: e.target.value })); const v = num(e.target.value); if (v >= 0) onSet(fromInput(v, uom)); }}
        className="w-[88px] h-10 text-right rounded-xl px-2 text-[15px] font-extrabold outline-none" style={{ border: `1px solid ${BORDER}`, color: NAVY }} />
      <span className="text-[11px] w-6" style={{ color: '#6B5A4C' }}>{inUnit(uom)}</span>
    </span>);

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const r = await uploadPhoto(file);
      if (r.error) setMsg({ ok: false, text: r.error });
      else if (photoFor === 'trial') setTrial(t => ({ ...t, photo: r.url! }));
      else if (photoFor === 'test' && test) { await updateTestAction(team, test.id, { photoUrl: r.url! }); await loadDetail(test.id, true); loadList(); }
    } catch { setMsg({ ok: false, text: L('Không tải được ảnh.', 'Could not upload the photo.') }); }
    finally { setBusy(false); if (photoRef.current) photoRef.current.value = ''; }
  }
  const takePhoto = (forWhat: 'trial' | 'test') => { setPhotoFor(forWhat); setTimeout(() => photoRef.current?.click(), 0); };

  // ── actions ──────────────────────────────────────────────────────────────
  async function createTest() {
    if (nf.name.trim().length < 2) return;
    setBusy(true);
    const r = await createTestAction(team, { name: nf.name, family: nf.family, collection: nf.collection || null, targetDate: nf.target || null,
      startKind: nf.start, improveSku: nf.start === 'improve' ? nf.sku || null : null, improveName: nf.start === 'improve' ? nf.skuName || null : null, copyFromId: nf.start === 'copy' ? nf.copyId || null : null });
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setSheet(null); setMsg({ ok: true, text: r.warning ?? L('Đã tạo — V0 sẵn sàng.', 'Created — V0 is ready.') });
    await loadList(); setOpenId(r.id!); setDtab('recipe'); setEdit(null); await loadDetail(r.id!);
  }
  async function saveInfo() {
    if (!test) return;
    setBusy(true);
    const r = await updateTestAction(team, test.id, { name: info.name, family: info.family || null, collection: info.collection || null, tags: info.tags.split(',').map(s => s.trim()).filter(Boolean), targetDate: info.target || null });
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setSheet(null); await loadDetail(test.id, true); loadList();
  }
  async function simple(fn: () => Promise<{ ok?: boolean; error?: string }>, okText: string | null, after?: () => void) {
    setBusy(true); const r = await fn(); setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return false; }
    if (okText) setMsg({ ok: true, text: okText });
    after?.(); if (test) await loadDetail(test.id, true); loadList(); return true;
  }
  async function saveTrial() {
    if (!test || !detail) return;
    const v = detail.versions.find(x => x.n === trial.verN); const pcs = num(trial.pcs);
    if (!v || !(pcs > 0) || !trial.stars || !trial.verdict) return;
    setBusy(true);
    const r = await addTrialAction(team, test.id, { versionId: v.id, pcs, stars: trial.stars, verdict: trial.verdict, note: trial.note, photoUrl: trial.photo });
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setSheet(null); setDtab('trials');
    setMsg({ ok: true, text: L(`Đã lưu lần thử. ${r.lines} nguyên liệu chờ trưởng nhóm duyệt (tab Hỏng).`, `Trial saved. ${r.lines} raw-material lines wait for the team lead (Loss tab).`) });
    await loadDetail(test.id, true); loadList();
  }
  async function makeVersion() {
    if (!test || !ver) return;
    setBusy(true);
    const r = await newVersionAction(team, test.id, ver.id, newVerNote);
    setBusy(false);
    if (r.error) { setMsg({ ok: false, text: r.error }); return; }
    setSheet(null); setNewVerNote(''); await loadDetail(test.id, true); setVerN(r.n!); setEdit(null); loadList();
    setMsg({ ok: true, text: L(`V${r.n} đã tạo — bấm « Sửa » để thay đổi.`, `V${r.n} created — tap « Edit » to change it.`) });
  }

  // ── render pieces ────────────────────────────────────────────────────────
  const Thumb = ({ t, h }: { t: TestSummary; h: number }) => t.photoUrl
    ? <img src={t.photoUrl} alt="" loading="lazy" className="w-full object-cover block" style={{ height: h }} />
    : <div className="w-full flex flex-col items-center justify-center gap-1" style={{ height: h, backgroundColor: '#F6EEDD', color: '#B49A55' }}><Camera size={20} /><span className="text-[10.5px] font-bold">{L('Chưa có ảnh', 'No photo yet')}</span></div>;

  const Card = ({ t }: { t: TestSummary }) => {
    const d = t.targetDate ? daysTo(t.targetDate) : null; const soon = d !== null && d <= 10;
    const meta = `V${t.lastVersion} · ${t.trialCount} ${L('lần thử', t.trialCount === 1 ? 'trial' : 'trials')}`;
    const target = t.targetDate ? <span className="text-[10px] font-extrabold rounded-md px-1.5 py-0.5" style={soon ? { backgroundColor: '#FDE7D2', color: '#9A3412' } : { backgroundColor: '#F3EDE3', color: '#5E4E42' }}>{soon ? `${L('Hạn', 'Due')} ${vnDate(t.targetDate)} · ${d} ${L('ngày', 'd')}` : `${L('Mục tiêu', 'Target')} ${vnDate(t.targetDate)}`}</span> : null;
    const open = () => { setOpenId(t.id); setDtab('recipe'); setEdit(null); setCompare(null); setMult(null); setDetail(null); loadDetail(t.id); };
    if (!grid) return (
      <button onClick={open} className="w-full text-left flex items-center gap-2.5 px-2.5 py-2" style={{ borderTop: `1px solid ${HAIR}` }}>
        <span className="w-[50px] h-[50px] rounded-xl overflow-hidden shrink-0"><Thumb t={t} h={50} /></span>
        <span className="flex-1 min-w-0"><span className="block text-[13.5px] font-extrabold truncate" style={{ color: NAVY }}>{t.name}</span>
          <span className="block text-[11px] truncate" style={{ color: '#6B5A4C' }}>{[t.family, t.collection, meta].filter(Boolean).join(' · ')}</span></span>
        <span className="flex flex-col items-end gap-1"><span className="text-[10px] font-extrabold rounded-full px-2 py-0.5 whitespace-nowrap" style={pill(t.stage)}>{stageLabel(t.stage)}</span>{target}</span>
      </button>);
    return (
      <button onClick={open} className="text-left bg-white rounded-2xl overflow-hidden flex flex-col" style={{ border: `1px solid ${BORDER}`, boxShadow: '0 1px 4px rgba(42,24,16,0.07)' }}>
        <div className="relative"><Thumb t={t} h={104} />
          <span className="absolute top-1.5 left-1.5 text-[10px] font-extrabold rounded-full px-2 py-0.5" style={pill(t.stage)}>{stageLabel(t.stage)}</span>
          {t.pinned && <span className="absolute top-1.5 right-1.5 w-[22px] h-[22px] rounded-full bg-white/90 flex items-center justify-center"><Pin size={11} fill={GOLD} style={{ color: GOLD_TEXT }} /></span>}
        </div>
        <div className="p-2 space-y-1">
          <div className="text-[13px] font-extrabold leading-tight" style={{ color: NAVY }}>{t.name}</div>
          <div className="text-[11px] font-semibold" style={{ color: '#6B5A4C' }}>{meta}</div>
          <div className="flex flex-wrap gap-1">{t.collection && <span className="text-[10px] font-bold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F6F1EA', color: '#92600A' }}>{t.collection}</span>}{target}</div>
        </div>
      </button>);
  };

  const picker = (items: { key: string; name: string; sub: string; tmplId?: number | null; sku?: string | null; onPick: () => void }[], placeholder: string, extra?: React.ReactNode) => {
    const s = pickQ.trim().toLowerCase();
    const shown = items.filter(i => !s || `${i.name} ${i.sub}`.toLowerCase().includes(s)).slice(0, 60);
    return (<>
      <label className="flex items-center gap-2 bg-white rounded-xl px-3 sticky top-0" style={{ border: `1px solid ${BORDER}` }}>
        <Search size={14} style={{ color: '#A39484' }} /><input autoFocus value={pickQ} onChange={e => setPickQ(e.target.value)} placeholder={placeholder} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
      </label>
      {extra}
      <div className="bg-white rounded-xl px-2" style={{ border: `1px solid ${BORDER}` }}>
        {shown.map(i => (
          <button key={i.key} onClick={i.onPick} className="w-full flex items-center gap-2.5 py-2 text-left" style={{ borderTop: `1px solid ${HAIR}` }}>
            {i.tmplId !== undefined ? <ItemPhoto tmplId={i.tmplId} sku={i.sku ?? null} size={38} /> : <span className="w-[38px] h-[38px] rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: '#F7F1E8', color: '#572C1A' }}><Layers size={16} /></span>}
            <span className="flex-1 min-w-0"><span className="block text-[13px] font-bold leading-snug">{i.name}</span><span className="block text-[10.5px]" style={{ color: '#A39484' }}>{i.sub}</span></span>
            <Plus size={16} style={{ color: NAVY }} />
          </button>))}
        {!shown.length && <div className="py-4 text-center text-[12.5px]" style={{ color: '#A39484' }}>{L('Không tìm thấy. Thiếu nguyên liệu? Báo anh Lân hoặc Axel.', 'Nothing found. Missing item? Tell Lân or Axel.')}</div>}
      </div>
    </>);
  };

  if (err) return <div className="bg-white rounded-2xl p-5 text-center text-sm" style={{ border: `1px solid ${BORDER}`, color: LATE }}>{err}</div>;
  if (!tests) return <div className="text-center py-10 text-sm" style={{ color: '#6B5A4C' }}><Loader2 className="animate-spin inline mr-2" size={16} />{L('Đang tải…', 'Loading…')}</div>;

  const chip = (on: boolean) => ({ backgroundColor: on ? NAVY : '#fff', color: on ? '#fff' : NAVY, border: `1px solid ${on ? NAVY : BORDER}` });
  const chipSm = (on: boolean) => ({ backgroundColor: on ? GOLD : '#fff', color: on ? NAVY : '#5E4E42', border: `1px solid ${on ? GOLD : '#EFE6D8'}` });
  const Msg = msg && <div className="rounded-xl px-3 py-2.5 text-[12.5px] font-semibold flex items-center gap-2" style={{ backgroundColor: msg.ok ? '#E8F2EB' : '#FBEAE8', color: msg.ok ? '#067647' : LATE }}>{msg.ok && <CheckCircle2 size={15} />}<span className="flex-1">{msg.text}</span><button onClick={() => setMsg(null)} aria-label="Close"><X size={13} /></button></div>;

  // ════════════════════════════════ COMPARE ════════════════════════════════
  if (openId && detail && compare) {
    const [an, bn] = compare;
    const A = detail.versions.find(v => v.n === an)!, B = detail.versions.find(v => v.n === bn)!;
    type Row = { sec: string; name: string; a: string; b: string; k: 'chg' | 'new' | 'out' | 'same' };
    const rows: Row[] = [];
    const cmpRows = (sec: string, ra: RecipeRow[], rb: RecipeRow[]) => {
      const key = (r: RecipeRow) => String(r.productId ?? r.name);
      const ma = new Map(ra.map(r => [key(r), r])), mb = new Map(rb.map(r => [key(r), r]));
      for (const [k, r] of Array.from(ma.entries())) { const o = mb.get(k); rows.push({ sec, name: r.name, a: show(r.qty, r.uom, L), b: o ? show(o.qty, o.uom, L) : '—', k: !o ? 'out' : Math.abs(o.qty - r.qty) > 1e-9 ? 'chg' : 'same' }); }
      for (const [k, r] of Array.from(mb.entries())) if (!ma.has(k)) rows.push({ sec, name: r.name, a: '—', b: show(r.qty, r.uom, L), k: 'new' });
    };
    if (A.yieldPcs !== B.yieldPcs) rows.push({ sec: L('Mẻ', 'Batch'), name: L('Số cái mỗi mẻ', 'Pieces per batch'), a: comma(A.yieldPcs), b: comma(B.yieldPcs), k: 'chg' });
    if ((A.pieceWeightG ?? 0) !== (B.pieceWeightG ?? 0)) rows.push({ sec: L('Mẻ', 'Batch'), name: L('Trọng lượng sống 1 cái', 'Raw weight of 1 piece'), a: A.pieceWeightG ? `${A.pieceWeightG} g` : '—', b: B.pieceWeightG ? `${B.pieceWeightG} g` : '—', k: 'chg' });
    const subsA = new Map(A.recipe.subs.map(s => [s.name, s])), subsB = new Map(B.recipe.subs.map(s => [s.name, s]));
    const secMain = L('Thành phẩm · cho 1 mẻ', 'Final product · for 1 batch');
    for (const [n, s] of Array.from(subsA.entries())) { const o = subsB.get(n); rows.push({ sec: secMain, name: n, a: show(s.qty, s.uom, L), b: o ? show(o.qty, o.uom, L) : '—', k: !o ? 'out' : Math.abs(o.qty - s.qty) > 1e-9 ? 'chg' : 'same' }); }
    for (const [n, s] of Array.from(subsB.entries())) if (!subsA.has(n)) rows.push({ sec: secMain, name: n, a: '—', b: show(s.qty, s.uom, L), k: 'new' });
    cmpRows(secMain, A.recipe.direct, B.recipe.direct);
    for (const [n, s] of Array.from(subsB.entries())) if (s.src === 'new') cmpRows(`${n} · ${L('cho 1 mẻ', 'for 1 batch')}`, subsA.get(n)?.rows ?? [], s.rows ?? []);
    const changed = rows.filter(r => r.k !== 'same'), same = rows.length - changed.length;
    const tag = (k: Row['k']) => ({ chg: ['#FEF3C7', '#92400E', L('ĐỔI', 'CHG')], new: ['#E8F2EB', '#256A45', L('MỚI', 'NEW')], out: ['#F8DAD6', '#9B1C12', L('BỎ', 'OUT')], same: ['', '', ''] }[k]);
    const res = (n: number) => detail.trials.filter(t => t.versionN === n);
    let lastSec = '';
    return (
      <div className="space-y-3">
        {Msg}
        <button onClick={() => setCompare(null)} className="inline-flex items-center gap-1 text-[14px] font-bold" style={{ color: NAVY }}><ChevronLeft size={16} />{test?.name}</button>
        <div className="text-[20px] font-bold" style={{ color: NAVY, fontFamily: "'Playfair Display', Georgia, serif" }}>{L('So sánh phiên bản', 'Compare versions')}</div>
        <div className="flex items-center gap-2 text-[12.5px] font-bold">
          {[0, 1].map(i => (
            <select key={i} value={compare[i]} onChange={e => setCompare(c => { const x = [...c!] as [number, number]; x[i] = Number(e.target.value); return x; })} className="rounded-xl px-2.5 py-2 bg-white outline-none" style={{ border: `1px solid ${BORDER}`, color: NAVY }}>
              {detail.versions.map(v => <option key={v.n} value={v.n}>V{v.n}</option>)}
            </select>))}
        </div>
        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          <div className="grid gap-1.5 px-3 py-2 text-[10.5px] font-extrabold tracking-wide" style={{ gridTemplateColumns: 'minmax(0,1fr) 64px 64px', backgroundColor: PALE, color: '#8A7A66' }}>
            <span>{L('THAY ĐỔI', 'WHAT CHANGED')}</span><span className="text-right">V{an}</span><span className="text-right">V{bn}</span></div>
          {changed.map((r, i) => { const t = tag(r.k); const head = r.sec !== lastSec; lastSec = r.sec; return (
            <div key={i}>
              {head && <div className="px-3 pt-2 text-[10.5px] font-extrabold" style={{ color: '#572C1A' }}>{r.sec}</div>}
              <div className="grid gap-1.5 px-3 py-1.5 items-center" style={{ gridTemplateColumns: 'minmax(0,1fr) 64px 64px', borderTop: `1px solid ${HAIR}` }}>
                <span className="text-[12.5px] flex items-center gap-1.5 min-w-0"><span className="text-[9px] font-black rounded px-1 py-px shrink-0" style={{ backgroundColor: t[0], color: t[1] }}>{t[2]}</span><span className="min-w-0">{r.name}</span></span>
                <span className="text-right text-[12px] font-extrabold" style={r.k === 'out' ? { color: LATE, textDecoration: 'line-through' } : { color: '#8A7A66' }}>{r.a}</span>
                <span className="text-right text-[12px] font-extrabold rounded-md px-1" style={r.k === 'out' ? { color: '#8A7A66' } : { color: NAVY, backgroundColor: '#F6F1EA' }}>{r.b}</span>
              </div>
            </div>); })}
          {!changed.length && <div className="px-3 py-4 text-center text-[12.5px]" style={{ color: '#6B5A4C' }}>{L('Hai phiên bản giống nhau.', 'Both versions are the same.')}</div>}
          <div className="px-3 py-2 text-[11.5px]" style={{ borderTop: `1px solid ${HAIR}`, color: '#8A7A66' }}>{same} {L('dòng không đổi', 'lines unchanged')}{JSON.stringify(A.steps) !== JSON.stringify(B.steps) ? ` · ${L('cách làm đã đổi', 'method changed')}` : ''}</div>
        </div>
        <div className="bg-white rounded-2xl p-3 space-y-1.5" style={{ border: `1px solid ${BORDER}` }}>
          <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('KẾT QUẢ THỬ', 'TRIAL RESULTS')}</div>
          {[an, bn].map(n => { const ts = res(n); const avg = ts.filter(t => t.stars).reduce((s, t) => s + (t.stars ?? 0), 0) / Math.max(1, ts.filter(t => t.stars).length); return (
            <div key={n} className="flex items-center gap-2 text-[12.5px]"><span className="text-[10px] font-extrabold rounded px-1.5 py-px" style={{ backgroundColor: NAVY, color: '#F6F1EA' }}>V{n}</span>
              {ts.length ? <><span style={{ color: GOLD }}>{'★'.repeat(Math.round(avg))}{'☆'.repeat(5 - Math.round(avg))}</span><span className="flex-1 min-w-0 truncate" style={{ color: '#2A1810' }}>{ts.length} {L('lần', 'trial(s)')} · {ts[0].note ?? ''}</span></> : <span style={{ color: '#A39484' }}>{L('chưa làm thử', 'no trial yet')}</span>}
            </div>); })}
        </div>
      </div>
    );
  }

  // ════════════════════════════════ DETAIL ════════════════════════════════
  if (openId) {
    if (!detail || !test || !ver) return <div className="text-center py-10 text-sm" style={{ color: '#6B5A4C' }}><Loader2 className="animate-spin inline mr-2" size={16} />{L('Đang tải…', 'Loading…')}</div>;
    const vTrials = detail.trials.filter(t => t.versionN === ver.n);
    const consumption = trialConsumption({ yieldPcs: ver.yieldPcs, recipe: ver.recipe }, Math.max(0, num(trial.pcs) || 0));
    const skippedSm = ver.recipe.subs.filter(s => s.src === 'odoo');
    const lastV = detail.versions[detail.versions.length - 1];
    const canSend = detail.canValidate && test.stage === 'testing' && ver.trialCount > 0;
    return (
      <div className="space-y-3 pb-28 lg:max-w-3xl lg:mx-auto">
        <input ref={photoRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => onPhoto(e.target.files?.[0])} />
        {Msg}
        <div className="flex items-center gap-2">
          <button onClick={() => { setOpenId(null); setDetail(null); setEdit(null); }} className="inline-flex items-center gap-1 text-[14px] font-bold py-1.5" style={{ color: NAVY }}><ChevronLeft size={16} />{L('Công thức thử', 'Tests')}</button>
          <span className="flex-1" />
          <button onClick={() => simple(() => updateTestAction(team, test.id, { pinned: !test.pinned }), null)} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-xl text-[12px] font-bold"
            style={test.pinned ? { backgroundColor: '#F6F1EA', border: `1px solid ${GOLD}`, color: GOLD_TEXT } : { backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: '#6B5A4C' }}>
            <Pin size={13} fill={test.pinned ? GOLD : 'none'} />{test.pinned ? L('Đã ghim', 'Pinned') : L('Ghim', 'Pin')}</button>
          <button aria-label="More" onClick={() => setSheet({ k: 'menu' })} className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: NAVY }}><MoreHorizontal size={16} /></button>
        </div>

        <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
          <button onClick={() => takePhoto('test')} className="relative w-full block">
            <Thumb t={test} h={test.photoUrl ? 150 : 90} />
            <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 text-[10.5px] font-bold rounded-lg px-2 py-1" style={{ backgroundColor: 'rgba(26,44,36,.72)', color: '#fff' }}><Camera size={11} />{test.photoUrl ? L('Đổi ảnh', 'Change photo') : L('Thêm ảnh', 'Add photo')}</span>
          </button>
          <div className="p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <div className="flex-1 text-[20px] font-bold leading-tight" style={{ color: NAVY, fontFamily: "'Playfair Display', Georgia, serif" }}>{test.name}</div>
              <span className="text-[10.5px] font-extrabold rounded-full px-2 py-0.5 whitespace-nowrap" style={pill(test.stage)}>{stageLabel(test.stage)}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {test.family && <span className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F7F1E8', color: '#572C1A' }}>{test.family}</span>}
              {test.collection && <span className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F6F1EA', color: '#92600A' }}>{test.collection}</span>}
              {test.tags.map(t => <span key={t} className="text-[10.5px] font-semibold rounded-md px-1.5 py-0.5" style={{ backgroundColor: '#F3EDE3', color: '#5E4E42' }}>#{t}</span>)}
              <button onClick={() => { setInfo({ name: test.name, family: test.family ?? '', collection: test.collection ?? '', tags: test.tags.join(', '), target: test.targetDate ?? '' }); setSheet({ k: 'info' }); }} className="text-[10.5px] font-bold rounded-md px-1.5 py-0.5" style={{ border: `1px dashed ${BORDER}`, color: '#8A7A66' }}>+ {L('nhãn', 'tag')}</button>
            </div>
            <div className="text-[11.5px]" style={{ color: '#6B5A4C' }}>{L('Tạo', 'Created')} {vnDate(test.createdAt.slice(0, 10))}{test.createdBy ? ` · ${test.createdBy}` : ''}{test.targetDate ? ` · ${L('Mục tiêu', 'Target')} ${vnDate(test.targetDate)}` : ''} · {detail.trials.length} {L('lần thử', 'trials')}</div>
          </div>
        </div>

        {test.startKind === 'improve' && <div className="rounded-xl px-3 py-2 text-[12px] leading-snug" style={{ backgroundColor: '#F7F1E8', border: '1px solid #BFDCCB', color: '#572C1A' }}><b>{L('Cải tiến sản phẩm có sẵn:', 'Improves an existing product:')}</b> {test.improveName}. {L('Khi được duyệt, văn phòng sửa công thức Odoo — không tạo sản phẩm mới.', 'Once approved, the office updates its Odoo recipe — no new product.')}</div>}
        {test.officeFeedback && <div className="rounded-xl px-3 py-2 text-[12px] leading-snug" style={{ backgroundColor: '#FFFBEB', border: '1px solid #F3D58A', color: '#78510A' }}><b>{test.officeFeedbackBy ?? L('Văn phòng', 'Office')} · {vnDate(test.officeFeedbackAt?.slice(0, 10) ?? null)}</b><br />{test.officeFeedback}</div>}
        {test.stage === 'sent' && <div className="rounded-xl px-3 py-2 text-[12px] font-semibold" style={{ backgroundColor: '#FBF4E1', color: '#8A6418' }}>{L('Đã gửi văn phòng: anh Lân kiểm tra giá vốn, rồi Axel duyệt.', 'Sent to the office: Lân checks the cost, then Axel validates.')}</div>}

        <div className="flex items-center gap-1.5">
          <div className="flex gap-1.5 overflow-x-auto flex-1 pb-0.5">
            {detail.versions.map(v => { const on = v.n === ver.n; return (
              <button key={v.n} onClick={() => { setVerN(v.n); setEdit(null); setMult(null); }} className="flex-shrink-0 rounded-full px-3.5 h-9 text-[13px] font-extrabold inline-flex items-center gap-1"
                style={on ? { backgroundColor: GOLD, color: NAVY, border: `1px solid ${GOLD}` } : { backgroundColor: '#fff', color: NAVY, border: `1px solid ${BORDER}` }}>
                V{v.n}{v.isFinal && <CheckCircle2 size={11} />}{v.n === lastV.n && <span className="text-[9px] opacity-70">{L('MỚI', 'LATEST')}</span>}</button>); })}
            <button onClick={() => { setNewVerNote(''); setSheet({ k: 'newVersion' }); }} className="flex-shrink-0 rounded-full px-3 h-9 text-[12.5px] font-bold" style={{ border: `1px dashed ${GOLD}`, color: GOLD_TEXT }}>+ {L('Phiên bản', 'Version')}</button>
          </div>
          {detail.versions.length > 1 && <button onClick={() => setCompare([detail.versions[detail.versions.length - 2].n, lastV.n])} className="flex-shrink-0 inline-flex items-center gap-1 rounded-full px-3.5 h-9 text-[12.5px] font-bold text-white" style={{ backgroundColor: NAVY }}><GitCompare size={13} />{L('So sánh', 'Compare')}</button>}
        </div>
        <div className="text-[11.5px] -mt-1.5" style={{ color: '#6B5A4C' }}>V{ver.n} · {vnDate(ver.createdAt.slice(0, 10))}{ver.note ? ` · ${ver.note}` : ''}{ver.trialCount ? ` · ${L('đã làm thử — khoá', 'made — locked')}` : ''}</div>

        <div className="grid grid-cols-3 gap-1 bg-white rounded-xl p-1" style={{ border: `1px solid ${BORDER}` }}>
          {([['recipe', L('Công thức', 'Recipe')], ['method', L('Cách làm', 'Method')], ['trials', `${L('Lần thử', 'Trials')} · ${detail.trials.length}`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setDtab(k)} className="rounded-lg py-2 text-[12.5px] font-bold" style={{ backgroundColor: dtab === k ? NAVY : 'transparent', color: dtab === k ? '#fff' : '#6B5A4C' }}>{l}</button>))}
        </div>

        {/* ── RECIPE ── */}
        {dtab === 'recipe' && (<>
          {edit ? (
            <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1.5px solid ${GOLD}` }}>
              <div className="text-[11px] font-extrabold tracking-wide" style={{ color: GOLD_TEXT }}>{L('ĐANG SỬA', 'EDITING')} V{ver.n} · {L('viết cho 1 mẻ', 'written for 1 batch')}</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] font-bold" style={{ color: '#6B5A4C' }}>{L('1 mẻ ra (cái)', '1 batch makes (pcs)')}<input inputMode="decimal" value={edit.yieldPcs} onChange={e => setEdit(x => x ? { ...x, yieldPcs: e.target.value } : x)} className="w-full mt-1 rounded-lg px-2 py-2 text-[14px] font-extrabold outline-none" style={{ border: `1px solid ${BORDER}`, color: NAVY }} /></label>
                <label className="text-[11px] font-bold" style={{ color: '#6B5A4C' }}>{L('1 cái sống (g)', 'Raw weight of 1 pc (g)')}<input inputMode="decimal" value={edit.weight} onChange={e => setEdit(x => x ? { ...x, weight: e.target.value } : x)} className="w-full mt-1 rounded-lg px-2 py-2 text-[14px] font-extrabold outline-none" style={{ border: `1px solid ${BORDER}`, color: NAVY }} /></label>
              </div>
              <input value={edit.note} onChange={e => setEdit(x => x ? { ...x, note: e.target.value } : x)} placeholder={L('Ghi chú phiên bản: thay đổi gì?', 'Version note: what changed?')} className="w-full rounded-lg px-2.5 py-2 text-[13px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
            </div>
          ) : (
            <div className="bg-white rounded-2xl p-3 space-y-2" style={{ border: `1px solid ${BORDER}` }}>
              <div className="flex items-center justify-between">
                <span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('LÀM BAO NHIÊU CÁI?', 'HOW MANY DO YOU MAKE?')}</span>
                <span className="text-[11px] font-bold" style={{ color: '#572C1A' }}>{L('1 mẻ', '1 batch')} = {comma(ver.yieldPcs)} {L('cái', 'pcs')}{ver.pieceWeightG ? ` · 1 ${L('cái', 'pc')} ${ver.pieceWeightG} g` : ''}</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from(new Set([1, ver.yieldPcs, ver.yieldPcs * 2, ver.yieldPcs * 4])).slice(0, 4).map(n => (
                  <button key={n} onClick={() => setMult(n)} className="rounded-xl py-2 text-[12.5px] font-extrabold" style={chip(m === n)}>{comma(r3(n))} {L('cái', 'pcs')}</button>))}
              </div>
            </div>
          )}

          {recipe.subs.map((s, si) => (
            <div key={s.key} className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              <div className="flex items-center gap-2.5 p-3">
                <span className="w-[34px] h-[34px] rounded-lg flex items-center justify-center shrink-0" style={s.src === 'new' ? { backgroundColor: '#F6F1EA', color: '#92600A' } : { backgroundColor: '#F7F1E8', color: '#572C1A' }}><Layers size={16} /></span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-extrabold leading-snug" style={{ color: NAVY }}>{s.name}</div>
                  <div className="text-[10.5px] font-semibold" style={{ color: '#6B5A4C' }}>{s.src === 'new' ? L('Bán thành phẩm mới (viết ở đây)', 'New intermediate (written here)') : L('Bán thành phẩm Odoo', 'Odoo intermediate')}</div>
                </div>
                {edit ? <>{qtyInput(`sub-${s.key}`, s.qty, s.uom, v => setRecipe(r => { r.subs[si].qty = v; }))}
                  <button aria-label="Remove" onClick={() => setRecipe(r => { r.subs.splice(si, 1); })} className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"><Trash2 size={15} style={{ color: LATE }} /></button></>
                  : <div className="text-right"><div className="text-[14px] font-black" style={{ color: '#256A45' }}>{show(s.qty * f, s.uom, L)}</div>
                    <span className="text-[9.5px] font-black rounded px-1.5 py-px" style={s.src === 'new' ? { backgroundColor: GOLD, color: NAVY } : { backgroundColor: '#F7F1E8', color: '#572C1A' }}>{s.src === 'new' ? L('MỚI', 'NEW') : 'ODOO'}</span></div>}
              </div>
              {s.src === 'new' && (
                <div className="px-3 pb-2 pt-1.5" style={{ borderTop: `1px solid ${HAIR}`, backgroundColor: '#FFFDF6' }}>
                  <div className="text-[10px] font-extrabold tracking-wider py-1 flex items-center gap-1.5" style={{ color: '#8A7A66' }}>
                    {edit ? <>{L('1 MẺ BTP =', '1 BATCH =')} {qtyInput(`subb-${s.key}`, s.batchQty ?? 1, s.batchUom ?? 'kg', v => setRecipe(r => { r.subs[si].batchQty = v; }))} · {L('NGUYÊN LIỆU CHO 1 MẺ', 'INGREDIENTS FOR 1 BATCH')}</>
                      : <>{f === 1 ? `${L('1 MẺ', '1 BATCH')} = ${show(s.batchQty ?? 1, s.batchUom ?? 'kg', L).toUpperCase()} · ${L('NGUYÊN LIỆU', 'INGREDIENTS')}` : `${L('CHO', 'FOR')} ${comma(r3(m))} ${L('CÁI', 'PCS')} · ${comma(r3((s.qty * f) / (s.batchQty || 1)))} ${L('MẺ', 'BATCH')}`}</>}
                  </div>
                  {(s.rows ?? []).map((r, ri) => (
                    <div key={ri} className="flex items-center gap-2.5 py-1.5">
                      <ItemPhoto tmplId={r.tmplId} sku={r.sku} size={36} />
                      <span className="flex-1 min-w-0 text-[13.5px] leading-snug">{r.name}</span>
                      {edit ? <>{qtyInput(`row-${s.key}-${ri}`, r.qty, r.uom, v => setRecipe(x => { x.subs[si].rows![ri].qty = v; }))}<button aria-label="Remove" onClick={() => setRecipe(x => { x.subs[si].rows!.splice(ri, 1); })} className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"><Trash2 size={15} style={{ color: LATE }} /></button></>
                        : <span className="text-[14px] font-extrabold tabular-nums" style={{ color: NAVY }}>{show(f === 1 ? r.qty : r.qty * (s.qty * f) / (s.batchQty || 1), r.uom, L)}</span>}
                    </div>))}
                  {edit && <button onClick={() => { needRaw(); setPickQ(''); setSheet({ k: 'pickRaw', target: s.key }); }} className="inline-flex items-center h-10 px-3.5 mt-1 rounded-full text-[13px] font-bold" style={{ color: '#572C1A', border: '1px dashed #C9A84C', backgroundColor: '#FBF7F0' }}>+ {L('Nguyên liệu', 'Ingredient')}</button>}
                </div>)}
            </div>))}

          <div className="bg-white rounded-2xl px-3 py-2" style={{ border: `1px solid ${BORDER}` }}>
            <div className="text-[10px] font-extrabold tracking-wider py-1" style={{ color: '#8A7A66' }}>{L('THÊM TRỰC TIẾP VÀO THÀNH PHẨM', 'ADDED STRAIGHT TO THE FINAL PRODUCT')}</div>
            {recipe.direct.map((r, ri) => (
              <div key={ri} className="flex items-center gap-2.5 py-1.5">
                <ItemPhoto tmplId={r.tmplId} sku={r.sku} size={36} />
                <span className="flex-1 min-w-0 text-[13.5px] leading-snug">{r.name}</span>
                {edit ? <>{qtyInput(`d-${ri}`, r.qty, r.uom, v => setRecipe(x => { x.direct[ri].qty = v; }))}<button aria-label="Remove" onClick={() => setRecipe(x => { x.direct.splice(ri, 1); })} className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"><Trash2 size={15} style={{ color: LATE }} /></button></>
                  : <span className="text-[14px] font-extrabold tabular-nums" style={{ color: NAVY }}>{show(r.qty * f, r.uom, L)}</span>}
              </div>))}
            {!recipe.direct.length && !recipe.subs.length && <div className="py-3 text-center text-[12.5px]" style={{ color: '#A39484' }}>{L('Chưa có nguyên liệu.', 'No ingredient yet.')}</div>}
            {edit && <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={() => { needRaw(); setPickQ(''); setSheet({ k: 'pickRaw', target: 'direct' }); }} className="inline-flex items-center h-10 px-3.5 mt-1 rounded-full text-[13px] font-bold" style={{ color: '#572C1A', border: '1px dashed #C9A84C', backgroundColor: '#FBF7F0' }}>+ {L('Nguyên liệu', 'Ingredient')}</button>
              <button onClick={() => { needSm(); setPickQ(''); setSheet({ k: 'pickSm' }); }} className="inline-flex items-center h-10 px-3.5 mt-1 rounded-full text-[13px] font-bold" style={{ color: '#572C1A', border: '1px dashed #C9A84C', backgroundColor: '#FBF7F0' }}>+ {L('Bán thành phẩm', 'Intermediate recipe')}</button>
            </div>}
          </div>
          <div className="text-[11px] leading-snug px-0.5" style={{ color: '#8A7A66' }}>{L('Bán thành phẩm Odoo hiển thị cả khi không có tồn kho. Bán thành phẩm MỚI chỉ được tạo trên Odoo khi sản phẩm được duyệt. Không hiển thị giá vốn.', 'Odoo intermediates are listed even without stock. A NEW intermediate is created in Odoo only when the product is approved. No cost is shown.')}</div>
        </>)}

        {/* ── METHOD ── */}
        {dtab === 'method' && (
          <div className="bg-white rounded-2xl px-3 py-1" style={{ border: `1px solid ${edit ? GOLD : BORDER}` }}>
            {(edit ? edit.steps : ver.steps).map((s, i) => (
              <div key={i} className="flex gap-2.5 py-2.5" style={{ borderTop: i ? `1px solid ${HAIR}` : 'none' }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-extrabold shrink-0" style={{ backgroundColor: NAVY, color: '#F6F1EA' }}>{i + 1}</span>
                {edit ? (
                  <div className="flex-1 space-y-1.5">
                    <input value={s.title} onChange={e => setEdit(x => { if (!x) return x; const st = [...x.steps]; st[i] = { ...st[i], title: e.target.value }; return { ...x, steps: st }; })} placeholder={L('Tên bước', 'Step name')} className="w-full h-10 rounded-xl px-3 text-[14px] font-bold outline-none" style={{ border: `1px solid ${BORDER}` }} />
                    <textarea value={s.text} onChange={e => setEdit(x => { if (!x) return x; const st = [...x.steps]; st[i] = { ...st[i], text: e.target.value }; return { ...x, steps: st }; })} rows={3} placeholder={L('Làm thế nào…', 'How…')} className="w-full rounded-xl px-3 py-2 text-[14px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                    <div className="flex gap-1.5">
                      <input value={s.temp ?? ''} onChange={e => setEdit(x => { if (!x) return x; const st = [...x.steps]; st[i] = { ...st[i], temp: e.target.value }; return { ...x, steps: st }; })} placeholder="°C" className="w-24 h-10 rounded-xl px-3 text-[14px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                      <input value={s.time ?? ''} onChange={e => setEdit(x => { if (!x) return x; const st = [...x.steps]; st[i] = { ...st[i], time: e.target.value }; return { ...x, steps: st }; })} placeholder={L('thời gian', 'time')} className="flex-1 min-w-0 h-10 rounded-xl px-3 text-[14px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                      <button aria-label="Remove" onClick={() => setEdit(x => x ? { ...x, steps: x.steps.filter((_, j) => j !== i) } : x)} className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"><Trash2 size={15} style={{ color: LATE }} /></button>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 min-w-0">
                    <div className="text-[14.5px] font-extrabold" style={{ color: NAVY }}>{s.title}</div>
                    <div className="text-[13.5px] leading-relaxed whitespace-pre-line" style={{ color: '#2A1810' }}>{s.text}</div>
                    {(s.temp || s.time) && <div className="flex gap-1 mt-1">{s.temp && <span className="text-[10.5px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: '#F6F1EA', color: '#92600A' }}>{s.temp}</span>}{s.time && <span className="text-[10.5px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: '#F6F1EA', color: '#92600A' }}>{s.time}</span>}</div>}
                  </div>
                )}
              </div>))}
            {!(edit ? edit.steps : ver.steps).length && !edit && <div className="py-4 text-center text-[12.5px]" style={{ color: '#A39484' }}>{L('Chưa có cách làm.', 'No method yet.')}</div>}
            {edit && <button onClick={() => setEdit(x => x ? { ...x, steps: [...x.steps, { title: '', text: '', temp: '', time: '' }] } : x)} className="inline-flex items-center h-10 px-3.5 my-2 rounded-full text-[13px] font-bold" style={{ color: '#572C1A', border: '1px dashed #C9A84C', backgroundColor: '#FBF7F0' }}>+ {L('Bước', 'Step')}</button>}
          </div>
        )}

        {/* ── TRIALS ── */}
        {dtab === 'trials' && (<>
          {detail.trials.map(t => (
            <div key={t.id} className="bg-white rounded-2xl p-2.5 flex gap-2.5" style={{ border: `1px solid ${BORDER}` }}>
              {t.photoUrl ? <a href={t.photoUrl} target="_blank" rel="noreferrer"><img src={t.photoUrl} alt="" className="w-16 h-16 rounded-xl object-cover" /></a>
                : <span className="w-16 h-16 rounded-xl flex items-center justify-center text-[10px] font-bold shrink-0" style={{ backgroundColor: '#F6EEDD', color: '#B49A55' }}>{L('không ảnh', 'no photo')}</span>}
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[12.5px] font-extrabold" style={{ color: NAVY }}>{vnDate(t.labDay)}</span>
                  <span className="text-[10px] font-extrabold rounded px-1.5 py-px" style={{ backgroundColor: NAVY, color: '#F6F1EA' }}>V{t.versionN}</span>
                  <span className="text-[11.5px]" style={{ color: '#6B5A4C' }}>× {comma(t.pcs)} {L('cái', 'pcs')}</span>
                  <span className="flex-1" />
                  {t.verdict && <span className="text-[10px] font-extrabold rounded-full px-2 py-0.5" style={t.verdict === 'ok' ? { backgroundColor: '#E8F2EB', color: '#256A45' } : t.verdict === 'adjust' ? { backgroundColor: '#FEF3C7', color: '#92400E' } : { backgroundColor: '#F8DAD6', color: '#9B1C12' }}>{t.verdict === 'ok' ? L('Tốt', 'Good') : t.verdict === 'adjust' ? L('Cần chỉnh', 'To adjust') : L('Hỏng', 'Failed')}</span>}
                </div>
                {t.stars && <div className="text-[13px] tracking-wide" style={{ color: GOLD }}>{'★'.repeat(t.stars)}{'☆'.repeat(5 - t.stars)}</div>}
                {t.note && <div className="text-[12px] leading-snug" style={{ color: '#2A1810' }}>{t.note}</div>}
                <div className="text-[10.5px]" style={{ color: '#8A7A66' }}>{t.madeBy ?? ''}</div>
              </div>
            </div>))}
          {!detail.trials.length && <div className="bg-white rounded-2xl p-5 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B5A4C' }}>{L('Chưa làm thử lần nào.', 'No trial yet.')}</div>}
        </>)}

        {/* bottom bar */}
        <div className="fixed left-0 right-0 bottom-[calc(58px+env(safe-area-inset-bottom))] sm:bottom-0 z-20 px-4 pt-3 pb-3" style={{ background: 'linear-gradient(180deg, rgba(246,241,234,0) 0%, #F6F1EA 35%)' }}>
          <div className="max-w-3xl mx-auto flex gap-2 sm:max-w-xl">
            {edit ? (<>
              <button onClick={() => { const changed = !!edit && !!ver && (JSON.stringify(edit.recipe) !== JSON.stringify(ver.recipe) || JSON.stringify(edit.steps) !== JSON.stringify(ver.steps) || edit.note !== (ver.note ?? '') || num(edit.yieldPcs) !== ver.yieldPcs); if (changed && !window.confirm(L('Bỏ các thay đổi chưa lưu?', 'Discard the changes you have not saved?'))) return; setEdit(null); setQtyDraft({}); }} className="flex-1 rounded-2xl py-3 text-[13.5px] font-extrabold bg-white" style={{ border: `1px solid ${NAVY}`, color: NAVY }}>{L('Huỷ', 'Cancel')}</button>
              <button disabled={busy} onClick={saveEdit} className="flex-[1.6] rounded-2xl py-3 text-[13.5px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : `${L('Lưu', 'Save')} V${ver.n}`}</button>
            </>) : (<>
              {editable && (dtab === 'recipe' || dtab === 'method') ? <button onClick={startEdit} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-2xl py-3 text-[13.5px] font-extrabold bg-white" style={{ border: `1px solid ${NAVY}`, color: NAVY }}><Pencil size={14} />{L('Sửa', 'Edit')} V{ver.n}</button>
                : <button onClick={() => { setTrial({ verN: ver.n, pcs: String(ver.yieldPcs), stars: 0, verdict: '', note: '', photo: null }); setSheet({ k: 'trial' }); }} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-2xl py-3 text-[13.5px] font-extrabold bg-white" style={{ border: `1px solid ${NAVY}`, color: NAVY }}><Camera size={14} />{L('Đã làm thử', 'I made a trial')}</button>}
              {canSend ? <button disabled={busy} onClick={() => simple(() => sendToOfficeAction(team, test.id, ver.id), L('Đã gửi văn phòng.', 'Sent to the office.'))} className="flex-[1.6] inline-flex items-center justify-center gap-1.5 rounded-2xl py-3 text-[13.5px] font-extrabold" style={{ backgroundColor: GOLD, color: NAVY }}><Send size={14} />{L('Gửi', 'Send')} V{ver.n} {L('cho văn phòng', 'to office')}</button>
                : <button onClick={() => { setTrial({ verN: ver.n, pcs: String(ver.yieldPcs), stars: 0, verdict: '', note: '', photo: null }); setSheet({ k: 'trial' }); }} className="flex-[1.6] inline-flex items-center justify-center gap-1.5 rounded-2xl py-3 text-[13.5px] font-extrabold" style={{ backgroundColor: GOLD, color: NAVY }}><Camera size={14} />{L('Đã làm thử', 'I made a trial')} V{ver.n}</button>}
            </>)}
          </div>
        </div>

        {/* sheets */}
        {sheet && (
          <div className="fixed inset-0 z-50 flex items-end justify-center lp-overlay" style={{ backgroundColor: 'rgba(31,18,12,.55)' }} onClick={() => !busy && setSheet(null)}>
            <div className="bg-white w-full max-w-xl rounded-t-[28px] p-4 pb-[max(16px,env(safe-area-inset-bottom))] max-h-[92vh] overflow-y-auto space-y-3 lp-sheet" onClick={e => e.stopPropagation()}>
              <div className="flex items-center">
                <div className="flex-1 text-[16px] font-extrabold" style={{ color: NAVY }}>{{ trial: `${L('Đã làm thử', 'I made a trial')} · ${test.name}`, info: L('Thông tin', 'Details'), menu: test.name, newVersion: L('Phiên bản mới', 'New version'), pickRaw: L('Thêm nguyên liệu', 'Add an ingredient'), pickSm: L('Thêm bán thành phẩm', 'Add an intermediate recipe'), newSub: L('Bán thành phẩm mới', 'New intermediate recipe'), new: '' }[sheet.k]}</div>
                <button onClick={() => setSheet(null)} aria-label="Close" className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: '#F3EDE3' }}><X size={17} /></button>
              </div>

              {sheet.k === 'trial' && (<>
                <div className="flex items-center gap-2"><span className="flex-1 text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('PHIÊN BẢN', 'VERSION MADE')}</span>
                  {detail.versions.map(v => <button key={v.n} onClick={() => setTrial(t => ({ ...t, verN: v.n }))} className="rounded-full h-9 px-3.5 text-[13px] font-bold" style={chipSm(trial.verN === v.n)}>V{v.n}</button>)}</div>
                <div className="flex items-center gap-2"><span className="flex-1 text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('SỐ CÁI ĐÃ LÀM', 'PIECES MADE')}</span>
                  <button onClick={() => setTrial(t => ({ ...t, pcs: String(Math.max(1, (num(t.pcs) || 1) - 1)) }))} className="w-12 h-12 rounded-xl text-xl font-extrabold" style={{ border: `1px solid ${BORDER}`, color: NAVY }}>−</button>
                  <input inputMode="decimal" value={trial.pcs} onChange={e => setTrial(t => ({ ...t, pcs: e.target.value }))} className="w-16 text-center text-[20px] font-black outline-none" style={{ color: NAVY }} />
                  <button onClick={() => setTrial(t => ({ ...t, pcs: String((num(t.pcs) || 0) + 1) }))} className="w-12 h-12 rounded-xl text-xl font-extrabold" style={{ border: `1px solid ${BORDER}`, color: NAVY }}>+</button></div>
                <button onClick={() => takePhoto('trial')} className="w-full min-h-[52px] rounded-xl inline-flex items-center justify-center gap-2 text-[13px] font-bold"
                  style={trial.photo ? { border: '1px solid #BFDCCB', backgroundColor: '#F7F1E8', color: '#572C1A' } : { border: `1px dashed ${GOLD}`, backgroundColor: PALE, color: GOLD_TEXT }}>
                  {trial.photo ? <><img src={trial.photo} alt="" className="w-11 h-11 rounded-lg object-cover" />{L('Có ảnh · bấm để chụp lại', 'Photo added · tap to retake')}</> : <><Camera size={15} />{L('Ảnh thành phẩm', 'Photo of the result')}</>}</button>
                <div className="space-y-1.5">
                  <div className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('NẾM THỬ', 'TASTING')}</div>
                  <div className="flex gap-1.5">{[1, 2, 3, 4, 5].map(n => <button key={n} aria-label={`${n}`} onClick={() => setTrial(t => ({ ...t, stars: n }))} className="flex-1 h-12 rounded-xl flex items-center justify-center" style={{ border: '1px solid #EFE6D8' }}><Star size={24} fill={n <= trial.stars ? GOLD : 'none'} style={{ color: n <= trial.stars ? GOLD : '#E5E0CC' }} /></button>)}</div>
                  <div className="grid grid-cols-3 gap-1.5">{([['ok', L('Tốt', 'Good'), '#256A45'], ['adjust', L('Cần chỉnh', 'To adjust'), '#B45309'], ['failed', L('Hỏng', 'Failed'), '#9B1C12']] as const).map(([k, l, c]) => (
                    <button key={k} onClick={() => setTrial(t => ({ ...t, verdict: k }))} className="rounded-xl h-12 text-[13.5px] font-extrabold" style={trial.verdict === k ? { backgroundColor: c, color: '#fff', border: `1px solid ${c}` } : { color: c, border: `1px solid ${BORDER}` }}>{l}</button>))}</div>
                  <input value={trial.note} onChange={e => setTrial(t => ({ ...t, note: e.target.value }))} placeholder={L('Nhận xét: kết cấu, vị, độ đông…', 'What did you notice? texture, taste, setting…')} className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                </div>
                {(() => { const v = detail.versions.find(x => x.n === trial.verN); const cons = v ? trialConsumption({ yieldPcs: v.yieldPcs, recipe: v.recipe }, Math.max(0, num(trial.pcs) || 0)) : consumption; const skip = v ? v.recipe.subs.filter(s => s.src === 'odoo') : skippedSm; return (
                  <div className="rounded-xl px-3 py-2 text-[11.5px] leading-snug" style={{ backgroundColor: '#F7F4EA', color: '#5E4E42' }}>
                    <b>{L('Trừ khỏi Room (chờ trưởng nhóm duyệt) — « làm hàng thử »:', 'Taken from the room (after the lead validates) — “làm hàng thử”:')}</b>
                    {cons.length ? cons.map(r => <div key={String(r.productId)} className="flex justify-between gap-2"><span className="truncate">{r.name}</span><b className="whitespace-nowrap">{show(r.qty, r.uom, L)}</b></div>) : <div>{L('Không có nguyên liệu.', 'No raw material.')}</div>}
                    {skip.length > 0 && <div className="mt-1" style={{ color: '#8A7A66' }}>{L('Bán thành phẩm Odoo chưa được trừ (sắp có):', 'Odoo intermediates not taken yet (coming soon):')} {skip.map(s => s.name).join(', ')}</div>}
                  </div>); })()}
                {!(trial.stars && trial.verdict && num(trial.pcs) > 0) && <div className="text-[11.5px] text-center font-semibold" style={{ color: '#B45309' }}>{!(num(trial.pcs) > 0) ? L('Nhập số cái đã làm', 'Enter the pieces made') : !trial.stars ? L('Chấm sao nếm thử', 'Give the tasting a star rating') : L('Chọn kết luận: Tốt / Cần chỉnh / Hỏng', 'Choose a verdict: Good / To adjust / Failed')}</div>}
                <button disabled={busy || !trial.stars || !trial.verdict || !(num(trial.pcs) > 0)} onClick={saveTrial} className="w-full rounded-2xl h-14 text-[15px] font-extrabold sticky bottom-0 shadow-[0_0_0_14px_#fff]"
                  style={trial.stars && trial.verdict && num(trial.pcs) > 0 ? { backgroundColor: NAVY, color: '#fff' } : { backgroundColor: '#E6DCCF', color: '#A39484' }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Lưu lần thử', 'Save trial')}</button>
              </>)}

              {sheet.k === 'newVersion' && (<>
                <div className="text-[12.5px]" style={{ color: '#6B5A4C' }}>{L(`Bản sao của V${ver.n} — rồi sửa những gì bạn muốn.`, `A copy of V${ver.n} — then change what you want.`)}</div>
                <input value={newVerNote} onChange={e => setNewVerNote(e.target.value)} placeholder={L('Đổi gì? vd: giảm đường 10 %', 'What changes? e.g. 10 % less sugar')} className="w-full rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                <button disabled={busy} onClick={makeVersion} className="w-full rounded-2xl py-3 text-[14px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : `${L('Tạo', 'Create')} V${lastV.n + 1}`}</button>
              </>)}

              {sheet.k === 'info' && (<>
                {([['name', L('TÊN', 'NAME')], ['collection', L('BỘ SƯU TẬP', 'COLLECTION')], ['tags', L('NHÃN (cách nhau bằng dấu phẩy)', 'TAGS (comma separated)')]] as const).map(([k, l]) => (
                  <label key={k} className="block"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{l}</span>
                    <input list={k === 'collection' ? 'test-collections' : undefined} value={(info as any)[k]} onChange={e => setInfo(x => ({ ...x, [k]: e.target.value }))} className="w-full mt-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>))}
                <datalist id="test-collections">{collections.map(c => <option key={c} value={c} />)}</datalist>
                <div><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('DÒNG SẢN PHẨM', 'FAMILY')}</span>
                  <div className="flex flex-wrap gap-1.5 mt-1">{TEST_FAMILIES.map(fm => <button key={fm} onClick={() => setInfo(x => ({ ...x, family: fm }))} className="rounded-full px-2.5 py-1 text-[12px] font-bold" style={chipSm(info.family === fm)}>{fm}</button>)}</div></div>
                <label className="block"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('NGÀY MỤC TIÊU', 'TARGET DATE')}</span>
                  <input type="date" value={info.target} onChange={e => setInfo(x => ({ ...x, target: e.target.value }))} className="w-full mt-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
                <button disabled={busy} onClick={saveInfo} className="w-full rounded-2xl py-3 text-[14px] font-extrabold text-white" style={{ backgroundColor: NAVY }}>{busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Lưu', 'Save')}</button>
              </>)}

              {sheet.k === 'menu' && (
                <div className="space-y-1.5">
                  {[
                    { l: L('Sửa tên, dòng, bộ sưu tập, nhãn', 'Edit name, family, collection, tags'), s: '', c: NAVY, on: () => { setInfo({ name: test.name, family: test.family ?? '', collection: test.collection ?? '', tags: test.tags.join(', '), target: test.targetDate ?? '' }); setSheet({ k: 'info' }); } },
                    { l: L('Nhân bản thành công thức thử mới', 'Duplicate as a new test'), s: L('vd: cho mùa sau', 'e.g. for next season'), c: NAVY, on: () => { setNf({ name: `${test.name} (2)`, start: 'copy', sku: '', skuName: '', copyId: test.id, family: test.family ?? TEST_FAMILIES[0], collection: '', target: '' }); setOpenId(null); setDetail(null); setSheet({ k: 'new' }); } },
                    ...(['idea', 'testing'].includes(test.stage) ? [{ l: L('Tạm dừng', 'Pause'), s: L('Chuyển vào « Tạm dừng » — vẫn tìm được', 'Moves to Paused — still found by search'), c: '#6B5A4C', on: () => { setSheet(null); simple(() => updateTestAction(team, test.id, { stage: 'archived' }), L('Đã tạm dừng.', 'Paused.')); } }] : []),
                    ...(test.stage === 'archived' ? [{ l: L('Tiếp tục thử', 'Resume testing'), s: '', c: NAVY, on: () => { setSheet(null); simple(() => updateTestAction(team, test.id, { stage: detail.trials.length ? 'testing' : 'idea' }), L('Đã mở lại.', 'Resumed.')); } }] : []),
                    ...(ver.trialCount === 0 && detail.versions.length > 1 ? [{ l: `${L('Xoá', 'Delete')} V${ver.n}`, s: L('Chỉ khi chưa làm thử phiên bản này', 'Only for a version never made'), c: LATE, on: () => { setSheet(null); simple(() => deleteVersionAction(team, ver.id), L('Đã xoá phiên bản.', 'Version deleted.'), () => setVerN(null)); } }] : []),
                  ].map((x, i) => (
                    <button key={i} onClick={x.on} className="w-full text-left rounded-xl px-3 py-2.5" style={{ border: '1px solid #EFE6D8', color: x.c }}>
                      <span className="block text-[13.5px] font-extrabold">{x.l}</span>{x.s && <span className="block text-[11.5px] opacity-75">{x.s}</span>}</button>))}
                </div>)}

              {sheet.k === 'pickRaw' && (raw ? picker(raw.filter(r => r.kind !== 'tools').map(r => ({
                key: String(r.tmplId), name: lang === 'vi' && r.nameVi ? r.nameVi : r.name, sub: `${r.sku ?? ''} · ${r.uom}`, tmplId: r.tmplId, sku: r.sku,
                onPick: () => {
                  const row: RecipeRow = { tmplId: r.tmplId, productId: (r as any).productId ?? null, sku: r.sku, name: r.name, uom: r.uom, qty: 0, kind: r.kind === 'packaging' ? 'packaging' : 'raw' };
                  setRecipe(x => { if (sheet.target === 'direct') x.direct.push(row); else x.subs.find(s => s.key === sheet.target)?.rows?.push(row); });
                  setSheet(null);
                },
              })), L('Tìm nguyên liệu, mã…', 'Search a raw material, code…')) : <div className="py-6 text-center"><Loader2 className="animate-spin inline" size={16} /></div>)}

              {sheet.k === 'pickSm' && (sms ? picker(sms.map(s => ({
                key: String(s.productId), name: s.name, sub: `${s.sku ?? ''} · ${s.uom}`,
                onPick: () => { setRecipe(x => { x.subs.push({ key: `sm-${s.productId}-${Date.now()}`, name: s.name, src: 'odoo', productId: s.productId, sku: s.sku, uom: s.uom, qty: 0 }); }); setSheet(null); },
              })), L('Tìm bán thành phẩm Odoo (SM-…)', 'Search an Odoo intermediate (SM-…)'),
                <button onClick={() => { setNewSub({ name: '', batch: '1000', use: '' }); setSheet({ k: 'newSub' }); }} className="w-full rounded-xl py-2.5 text-[13px] font-bold inline-flex items-center justify-center gap-1.5" style={{ border: `1.5px dashed ${GOLD}`, color: GOLD_TEXT }}><Plus size={14} />{L('Tạo bán thành phẩm mới', 'Create a new intermediate recipe')}</button>)
                : <div className="py-6 text-center"><Loader2 className="animate-spin inline" size={16} /></div>)}

              {sheet.k === 'newSub' && (<>
                <div className="text-[12px] leading-snug" style={{ color: '#6B5A4C' }}>{L('Viết cho 1 mẻ (vd 1 mẻ = 1 200 g kem), rồi nói thành phẩm dùng bao nhiêu cho 1 mẻ của nó.', 'Write it for one batch (e.g. 1 batch = 1,200 g of cream), then say how much one batch of the final product uses.')}</div>
                <input value={newSub.name} onChange={e => setNewSub(x => ({ ...x, name: e.target.value }))} placeholder={L('Tên, vd: Kem yuzu', 'Name, e.g. Yuzu cream')} className="w-full rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] font-bold" style={{ color: '#6B5A4C' }}>{L('1 mẻ BTP (g)', '1 batch of it (g)')}<input inputMode="decimal" value={newSub.batch} onChange={e => setNewSub(x => ({ ...x, batch: e.target.value }))} className="w-full mt-1 rounded-lg px-2 py-2 text-[14px] font-extrabold outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
                  <label className="text-[11px] font-bold" style={{ color: '#6B5A4C' }}>{L('Dùng cho 1 mẻ thành phẩm (g)', 'Used per final batch (g)')}<input inputMode="decimal" value={newSub.use} onChange={e => setNewSub(x => ({ ...x, use: e.target.value }))} className="w-full mt-1 rounded-lg px-2 py-2 text-[14px] font-extrabold outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
                </div>
                <button disabled={newSub.name.trim().length < 2 || !(num(newSub.batch) > 0)} onClick={() => { setRecipe(x => { x.subs.push({ key: `new-${Date.now()}`, name: newSub.name.trim(), src: 'new', uom: 'kg', qty: (num(newSub.use) || 0) / 1000, batchQty: num(newSub.batch) / 1000, batchUom: 'kg', rows: [] }); }); setSheet(null); }}
                  className="w-full rounded-2xl py-3 text-[14px] font-extrabold" style={newSub.name.trim().length >= 2 && num(newSub.batch) > 0 ? { backgroundColor: NAVY, color: '#fff' } : { backgroundColor: '#E6DCCF', color: '#A39484' }}>{L('Tạo — rồi thêm nguyên liệu', 'Create — then add its ingredients')}</button>
              </>)}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ════════════════════════════════ LIBRARY ════════════════════════════════
  const stageCount = (s: 'all' | TestStage) => base.filter(t => inStage(t, s)).length;
  const prods = products ?? [];
  return (
    <div className="space-y-2.5">
      {Msg}
      {(() => {
        // What needs the chef today: tests in progress, those close to their target date, those waiting at the office.
        const active = tests.filter(t => t.stage === 'idea' || t.stage === 'testing');
        const due = active.filter(t => t.targetDate && daysTo(t.targetDate) <= 10).length;
        const figures: [number, string, () => void, string][] = [
          [tests.filter(t => t.stage === 'testing').length, L('đang thử', 'in testing'), () => { setStage('testing'); setSort('activity'); }, '#fff'],
          [due, L('sắp đến hạn', 'due within 10 days'), () => { setStage('all'); setSort('target'); }, due ? '#F3B8A8' : '#fff'],
          [tests.filter(t => t.stage === 'sent').length, L('ở văn phòng', 'at the office'), () => { setStage('sent'); setSort('activity'); }, '#E9D3A4'],
        ];
        return (
          <section className="rounded-[26px] px-4 pt-4 pb-4 lp-rise" style={{ background: 'radial-gradient(120% 90% at 100% 0%, rgba(201,168,76,.22), transparent 60%), #2A1810', color: '#fff' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] font-bold tracking-[0.18em] uppercase" style={{ color: '#D9B36A' }}>{L('Công thức thử', 'Test recipes')} · {tests.length}</span>
              <button onClick={() => { setNf({ name: '', start: 'new', sku: '', skuName: '', copyId: '', family: TEST_FAMILIES[0], collection: '', target: '' }); setSheet({ k: 'new' }); }}
                className="inline-flex items-center gap-1.5 rounded-full pl-3 pr-3.5 h-10 text-[13px] font-bold lp-press" style={{ backgroundColor: GOLD, color: NAVY }}><Plus size={15} />{L('Thử mới', 'New test')}</button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {figures.map(([n, label, go, color]) => (
                <button key={label} onClick={go} className="text-left lp-press">
                  <div className="lp-display text-[30px] leading-none font-bold" style={{ color }}>{n}</div>
                  <div className="text-[11px] mt-1 leading-tight" style={{ color: 'rgba(255,255,255,.72)' }}>{label}</div>
                </button>))}
            </div>
          </section>);
      })()}
      <label className="flex items-center gap-2 bg-white rounded-xl px-3" style={{ border: `1px solid ${BORDER}` }}>
        <Search size={14} style={{ color: '#A39484' }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={L('Tên, nguyên liệu, bộ sưu tập, nhãn…', 'Name, ingredient, collection, tag…')} className="flex-1 py-2.5 text-[13.5px] outline-none bg-transparent" />
        {q && <button onClick={() => setQ('')} aria-label="Clear"><X size={14} style={{ color: '#A39484' }} /></button>}
      </label>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mx-1 px-1">
        {(['all', ...TEST_STAGES.map(s => s.k)] as ('all' | TestStage)[]).map(s => (
          <button key={s} onClick={() => setStage(s)} className="flex-shrink-0 rounded-full px-3.5 h-9 text-[12.5px] font-bold" style={chip(stage === s)}>
            {s === 'all' ? L('Đang làm', 'All active') : stageLabel(s)} <span className="opacity-60 text-[10.5px]">{stageCount(s)}</span></button>))}
      </div>
      {(families.length > 0 || collections.length > 0) && (showFilters || fam !== 'all' || coll !== 'all') && (
        <div className="bg-white rounded-xl px-2.5 py-2 space-y-1.5" style={{ border: `1px solid ${BORDER}` }}>
          {families.length > 0 && <div className="flex items-center gap-1.5"><span className="text-[10px] font-extrabold tracking-wider w-[70px] shrink-0" style={{ color: '#8A7A66' }}>{L('DÒNG', 'FAMILY')}</span>
            <div className="flex gap-1 overflow-x-auto">{['all', ...families].map(x => <button key={x} onClick={() => setFam(x)} className="flex-shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-bold" style={chipSm(fam === x)}>{x === 'all' ? L('Tất cả', 'All') : x}</button>)}</div></div>}
          {collections.length > 0 && <div className="flex items-center gap-1.5"><span className="text-[10px] font-extrabold tracking-wider w-[70px] shrink-0" style={{ color: '#8A7A66' }}>{L('BỘ SƯU TẬP', 'COLLECTION')}</span>
            <div className="flex gap-1 overflow-x-auto">{['all', ...collections].map(x => <button key={x} onClick={() => setColl(x)} className="flex-shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-bold" style={chipSm(coll === x)}>{x === 'all' ? L('Tất cả', 'All') : x}</button>)}</div></div>}
        </div>)}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[12px] font-semibold" style={{ color: '#6B5A4C' }}>{list.length} {L('kết quả', list.length === 1 ? 'test' : 'tests')}</span>
        {(families.length > 0 || collections.length > 0) && <button onClick={() => setShowFilters(v => !v)} className="inline-flex items-center gap-1 rounded-lg px-3 h-9 text-[12.5px] font-bold" style={showFilters || fam !== 'all' || coll !== 'all' ? { backgroundColor: '#F3E7C8', border: `1px solid ${GOLD}`, color: GOLD_TEXT } : { backgroundColor: '#fff', border: `1px solid ${BORDER}`, color: NAVY }}>{L('Lọc', 'Filters')}{fam !== 'all' || coll !== 'all' ? ' ·' : ''}</button>}
        <button onClick={() => setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length])} className="inline-flex items-center gap-1 rounded-lg px-3 h-9 text-[12.5px] font-bold bg-white" style={{ border: `1px solid ${BORDER}`, color: NAVY }}><ArrowUpDown size={12} />{sortLabel}</button>
        <div className="flex rounded-lg overflow-hidden bg-white" style={{ border: `1px solid ${BORDER}` }}>
          <button aria-label="Grid" onClick={() => setGrid(true)} className="w-10 h-9 flex items-center justify-center" style={grid ? { backgroundColor: NAVY, color: '#fff' } : { color: '#6B5A4C' }}><LayoutGrid size={14} /></button>
          <button aria-label="List" onClick={() => setGrid(false)} className="w-10 h-9 flex items-center justify-center" style={!grid ? { backgroundColor: NAVY, color: '#fff' } : { color: '#6B5A4C' }}><List size={14} /></button>
        </div>
      </div>
      {!tests.length && <div className="bg-white rounded-2xl p-6 text-center space-y-1" style={{ border: `1px dashed ${BORDER}` }}><div className="text-[14px] font-extrabold" style={{ color: NAVY }}>{L('Chưa có công thức thử', 'No test yet')}</div><div className="text-[12px]" style={{ color: '#6B5A4C' }}>{L('Bấm « Thử mới » để bắt đầu.', 'Tap « New test » to start.')}</div></div>}
      {tests.length > 0 && !list.length && <div className="bg-white rounded-2xl p-5 text-center text-[12.5px]" style={{ border: `1px dashed ${BORDER}`, color: '#6B5A4C' }}>{L('Không có kết quả. Tìm kiếm có tìm cả mục tạm dừng.', 'No match. The search covers paused tests too.')}</div>}
      {[[L('ĐÃ GHIM', 'PINNED'), pinned], [pinned.length ? L('KHÁC', 'OTHERS') : '', others]].map(([label, arr]) => (arr as TestSummary[]).length > 0 && (
        <div key={String(label) || 'rest'} className="space-y-1.5">
          {label && <div className="text-[10.5px] font-extrabold tracking-wider flex items-center gap-1" style={{ color: '#92600A' }}>{label === L('ĐÃ GHIM', 'PINNED') && <Pin size={11} fill={GOLD} />}{label as string}</div>}
          {grid ? <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 lg:gap-3">{(arr as TestSummary[]).map(t => <Card key={t.id} t={t} />)}</div>
            : <div className="bg-white rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>{(arr as TestSummary[]).map(t => <Card key={t.id} t={t} />)}</div>}
        </div>))}

      {sheet?.k === 'new' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center lp-overlay" style={{ backgroundColor: 'rgba(31,18,12,.55)' }} onClick={() => !busy && setSheet(null)}>
          <div className="bg-white w-full max-w-xl rounded-t-[28px] p-4 pb-[max(16px,env(safe-area-inset-bottom))] max-h-[92vh] overflow-y-auto space-y-3 lp-sheet" onClick={e => e.stopPropagation()}>
            <div className="flex items-center"><div className="flex-1 text-[16px] font-extrabold" style={{ color: NAVY }}>{L('Công thức thử mới', 'New test')}</div>
              <button onClick={() => setSheet(null)} aria-label="Close" className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: '#F3EDE3' }}><X size={17} /></button></div>
            <label className="block"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('TÊN', 'NAME')}</span>
              <input autoFocus value={nf.name} onChange={e => setNf(x => ({ ...x, name: e.target.value }))} placeholder={L('vd: Macaron yuzu mè', 'e.g. Yuzu sesame macaron')} className="w-full mt-1 rounded-xl px-3 py-2.5 text-[14px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
            <div className="space-y-1.5"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('BẮT ĐẦU TỪ', 'START FROM')}</span>
              {([['new', L('Sản phẩm mới', 'A new product'), L('Công thức trống', 'Empty recipe')], ['improve', L('Cải tiến sản phẩm có sẵn', 'Improve an existing product'), L('Lấy công thức Odoo của nó — vd giảm giá vốn, cỡ mới', 'Starts from its Odoo recipe — e.g. lower cost, new size')], ['copy', L('Sao chép một công thức thử', 'Copy one of our tests'), L('vd công thức Tết năm ngoái', 'e.g. last year’s Tết test')]] as const).map(([k, t, s]) => (
                <button key={k} onClick={() => { setNf(x => ({ ...x, start: k })); if (k === 'improve') needProducts(); }} className="w-full text-left rounded-xl px-3 py-2.5"
                  style={nf.start === k ? { border: `2px solid ${NAVY}`, backgroundColor: '#F7F1E8', color: NAVY } : { border: `1px solid ${BORDER}`, color: NAVY }}>
                  <span className="block text-[13px] font-extrabold">{t}</span><span className="block text-[11.5px] opacity-75">{s}</span></button>))}
            </div>
            {nf.start === 'improve' && (
              <select value={nf.sku} onChange={e => { const p = prods.find(x => x.sku === e.target.value); setNf(x => ({ ...x, sku: e.target.value, skuName: p?.name ?? '' })); }} className="w-full rounded-xl px-3 py-2.5 text-[13.5px] bg-white outline-none" style={{ border: `1px solid ${BORDER}` }}>
                <option value="">{products ? L('Chọn sản phẩm…', 'Pick the product…') : L('Đang tải…', 'Loading…')}</option>
                {prods.map(p => <option key={p.sku} value={p.sku}>{p.name} · {p.sku}</option>)}
              </select>)}
            {nf.start === 'copy' && (
              <select value={nf.copyId} onChange={e => setNf(x => ({ ...x, copyId: e.target.value }))} className="w-full rounded-xl px-3 py-2.5 text-[13.5px] bg-white outline-none" style={{ border: `1px solid ${BORDER}` }}>
                <option value="">{L('Chọn công thức thử…', 'Pick a test…')}</option>
                {tests.map(t => <option key={t.id} value={t.id}>{t.name}{t.collection ? ` · ${t.collection}` : ''}</option>)}
              </select>)}
            <div><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('DÒNG SẢN PHẨM', 'FAMILY')}</span>
              <div className="flex flex-wrap gap-1.5 mt-1">{TEST_FAMILIES.map(fm => <button key={fm} onClick={() => setNf(x => ({ ...x, family: fm }))} className="rounded-full px-2.5 py-1 text-[12px] font-bold" style={chipSm(nf.family === fm)}>{fm}</button>)}</div></div>
            <label className="block"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('BỘ SƯU TẬP (chọn hoặc gõ mới)', 'COLLECTION (pick or type a new one)')}</span>
              <input list="test-collections-new" value={nf.collection} onChange={e => setNf(x => ({ ...x, collection: e.target.value }))} placeholder={L('vd: Tết 2027, Noël 2026, Thường xuyên', 'e.g. Tết 2027, Noël 2026, Permanent')} className="w-full mt-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} />
              <datalist id="test-collections-new">{collections.map(c => <option key={c} value={c} />)}</datalist>
              {collections.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{collections.map(c => <button key={c} onClick={() => setNf(x => ({ ...x, collection: c }))} className="rounded-full px-2 py-0.5 text-[11.5px] font-bold" style={chipSm(nf.collection === c)}>{c}</button>)}</div>}</label>
            <label className="block"><span className="text-[10.5px] font-extrabold tracking-wider" style={{ color: '#8A7A66' }}>{L('NGÀY MỤC TIÊU (tuỳ chọn)', 'TARGET DATE (optional)')}</span>
              <input type="date" value={nf.target} onChange={e => setNf(x => ({ ...x, target: e.target.value }))} className="w-full mt-1 rounded-xl px-3 py-2.5 text-[13.5px] outline-none" style={{ border: `1px solid ${BORDER}` }} /></label>
            {(() => { const ok = nf.name.trim().length >= 2 && (nf.start !== 'improve' || !!nf.sku) && (nf.start !== 'copy' || !!nf.copyId); return (
              <button disabled={!ok || busy} onClick={createTest} className="w-full rounded-2xl py-3.5 text-[14px] font-extrabold" style={ok ? { backgroundColor: NAVY, color: '#fff' } : { backgroundColor: '#E6DCCF', color: '#A39484' }}>
                {busy ? <Loader2 size={15} className="animate-spin inline" /> : L('Tạo · bắt đầu V0', 'Create · start V0')}</button>); })()}
          </div>
        </div>)}
    </div>
  );
}
