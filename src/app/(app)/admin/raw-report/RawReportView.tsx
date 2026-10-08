'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wheat, Loader2, AlertTriangle, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { TEAM_SHORT, fmtQty } from '@/lib/raw-materials';
import { getRawReportAction, type RawReport, type ReportRow } from './actions';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', BORDER = '#E0D49A', HAIR = '#EFE9CF';
const OVER = '#C08A12', UNDER = '#1E7D55';
const TEAMS = ['hung', 'entremet', 'baby_mama', 'baker'];

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function vnToday(): Date { const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()); return new Date(s + 'T00:00:00Z'); }
function periods(): Record<string, { vi: string; en: string; from: string; to: string }> {
  const t = vnToday(); const dow = (t.getUTCDay() + 6) % 7;
  const mon = new Date(t); mon.setUTCDate(t.getUTCDate() - dow);
  const lmon = new Date(mon); lmon.setUTCDate(mon.getUTCDate() - 7); const lsun = new Date(mon); lsun.setUTCDate(mon.getUTCDate() - 1);
  const m1 = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
  const lm1 = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1)); const lmEnd = new Date(m1); lmEnd.setUTCDate(0);
  return {
    w: { vi: 'Tuần này', en: 'This week', from: ymd(mon), to: ymd(t) },
    pw: { vi: 'Tuần trước', en: 'Last week', from: ymd(lmon), to: ymd(lsun) },
    m: { vi: 'Tháng này', en: 'This month', from: ymd(m1), to: ymd(t) },
    pm: { vi: 'Tháng trước', en: 'Last month', from: ymd(lm1), to: ymd(lmEnd) },
  };
}

export default function RawReportView() {
  const { lang } = useI18n();
  const L = useCallback((vi: string, en: string) => (lang === 'vi' ? vi : en), [lang]);
  const P = useMemo(periods, []);
  const [period, setPeriod] = useState<keyof ReturnType<typeof periods>>('w');
  const [team, setTeam] = useState<string>('hung');
  const [data, setData] = useState<RawReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    const r = await getRawReportAction(P[period].from, P[period].to);
    setLoading(false);
    if (r.error) setErr(r.error); else setData(r.data!);
  }, [P, period]);
  useEffect(() => { load(); }, [load]);

  const teamsIn = team === 'all' ? TEAMS : [team];
  const sum = (o: Record<string, number>) => teamsIn.reduce((s, t) => s + (o[t] ?? 0), 0);
  const rows = (data?.rows ?? []).map(r => {
    const taken = sum(r.taken), recipe = sum(r.recipe);
    return { r, taken, recipe, gap: taken - recipe, pct: recipe > 0 ? (taken - recipe) / recipe : null, val: (taken - recipe) * r.cost };
  }).filter(x => x.taken > 0 || x.recipe > 0);
  const slipTeams = new Set(data?.teamsWithSlips ?? []);
  const recording = teamsIn.filter(t => slipTeams.has(t));
  // Only teams that record withdrawals can be compared; others would show 100 % "not taken".
  const comparable = rows.filter(x => x.taken > 0 || recording.length > 0);
  const main = comparable.filter(x => x.taken > 0 && x.recipe > 0).sort((a, b) => Math.abs(b.val) - Math.abs(a.val));
  const takenNoRecipe = comparable.filter(x => x.taken > 0 && x.recipe <= 1e-9).sort((a, b) => b.taken * b.r.cost - a.taken * a.r.cost);
  const recipeNoTaken = recording.length ? comparable.filter(x => x.recipe > 0 && x.taken <= 1e-9).sort((a, b) => b.recipe * b.r.cost - a.recipe * a.r.cost) : [];
  const tt = comparable.reduce((s, x) => s + x.taken * x.r.cost, 0), tr = comparable.reduce((s, x) => s + x.recipe * x.r.cost, 0);
  const vnd = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} ${L('tr', 'M')}` : `${Math.round(v / 1000).toLocaleString('vi-VN')}k`);
  const signed = (v: number, f: (n: number) => string) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${f(Math.abs(v))}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy flex items-center gap-2"><Wheat size={24} className="text-gold" /> {L('Nguyên liệu: lấy kho so với công thức', 'Raw materials: taken vs recipes')}</h1>
        <p className="text-ink-light text-sm mt-0.5">{L('Đã lấy = phiếu lấy kho của chef. Công thức = sản lượng khai báo trong app × công thức Odoo (kể cả bán thành phẩm). Giá vốn Odoo.', 'Taken = chefs\' withdrawal slips. Recipes = production declared in the app × Odoo recipes (semi-finished included). Odoo cost.')}</p>
      </div>
      <div className="flex gap-1.5 flex-wrap items-center">
        {(Object.keys(P) as (keyof typeof P)[]).map(k => (
          <button key={k} onClick={() => setPeriod(k)} className="rounded-full px-3 py-1.5 text-[12.5px] font-bold" style={{ backgroundColor: period === k ? NAVY : '#fff', color: period === k ? '#fff' : NAVY, border: `1px solid ${period === k ? NAVY : BORDER}` }}>{L(P[k].vi, P[k].en)}</button>))}
        <span className="w-px h-5 mx-1" style={{ backgroundColor: BORDER }} />
        {['all', ...TEAMS].map(t => (
          <button key={t} onClick={() => setTeam(t)} className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ backgroundColor: team === t ? PALE : '#fff', color: team === t ? GOLD_TEXT : '#344054', border: `1px solid ${team === t ? GOLD : BORDER}` }}>
            {t === 'all' ? L('Tất cả team', 'All teams') : TEAM_SHORT[t][lang === 'vi' ? 'vi' : 'en']}{t !== 'all' && slipTeams.has(t) ? ' ●' : ''}</button>))}
        <button onClick={load} className="ml-auto p-1.5" style={{ color: '#6B7280' }}>{loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}</button>
      </div>
      <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{P[period].from} → {P[period].to} · {L('● = team có ghi phiếu lấy. Giai đoạn thử: chỉ team Hưng.', '● = team recording withdrawals. Test phase: team Hưng only.')}</div>
      {err && <div className="text-xs font-semibold rounded-lg px-3 py-2" style={{ backgroundColor: '#FBEAE8', color: '#B42318' }}>{err}</div>}
      {!data ? <div className="text-sm text-center py-10" style={{ color: '#6B7280' }}>{loading ? L('Đang tính (đọc công thức Odoo)…', 'Computing (reading Odoo recipes)…') : ''}</div> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Tile label={L('Đã lấy (giá vốn)', 'Taken (at cost)')} value={vnd(tt)} sub={L('từ phiếu lấy kho', 'from withdrawal slips')} />
            <Tile label={L('Theo công thức', 'By recipes')} value={vnd(tr)} sub={L('sản lượng × công thức', 'production × recipes')} />
            <Tile label={L('Chênh lệch', 'Gap')} value={signed(tt - tr, vnd)} sub={tr ? `${signed((tt - tr) / tr * 100, n => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 }))} % ${L('so với công thức', 'vs recipes')}` : ''} color={tt - tr > 0 ? GOLD_TEXT : UNDER} />
          </div>
          {!recording.length && <div className="rounded-xl px-3.5 py-2.5 text-xs font-semibold" style={{ backgroundColor: PALE, border: `1px solid ${BORDER}`, color: GOLD_TEXT }}>{L('Team này chưa ghi phiếu lấy kho trong kỳ — chỉ hiện những gì đã lấy.', 'This team recorded no withdrawal in the period — only what was taken is shown.')}</div>}
          {(takenNoRecipe.length > 0 || recipeNoTaken.length > 0) && (
            <div className="rounded-xl px-4 py-3 text-[12.5px] space-y-1.5" style={{ backgroundColor: '#FEF3F2', border: '1px solid #FECDCA', color: '#7A271A' }}>
              <div className="font-extrabold flex items-center gap-1.5"><AlertTriangle size={14} /> {L('Cần kiểm tra (có thể là sản phẩm trùng)', 'To check (possibly duplicate products)')}</div>
              {takenNoRecipe.length > 0 && <div><b>{L('Đã lấy nhưng không công thức nào dùng:', 'Taken but no recipe uses it:')}</b> {takenNoRecipe.slice(0, 6).map(x => `${x.r.name} (${fmtQty(x.taken)} ${x.r.uom})`).join(' · ')}</div>}
              {recipeNoTaken.length > 0 && <div><b>{L('Công thức dùng nhưng không ai lấy:', 'Used by recipes but nobody took it:')}</b> {recipeNoTaken.slice(0, 6).map(x => `${x.r.name} (${fmtQty(x.recipe)} ${x.r.uom})`).join(' · ')}</div>}
            </div>
          )}
          <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: `1px solid ${BORDER}` }}>
            <div className="flex justify-between items-center px-4 py-2.5 flex-wrap gap-2">
              <b className="text-sm">{L('Theo nguyên liệu', 'By raw material')}</b>
              <div className="flex gap-3 text-[11.5px] font-semibold" style={{ color: '#6B7280' }}>
                <span className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: OVER }} /> {L('Lấy nhiều hơn công thức', 'Took more than recipes')}</span>
                <span className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: UNDER }} /> {L('Lấy ít hơn', 'Took less')}</span></div>
            </div>
            <table className="w-full text-[12.5px]" style={{ minWidth: 760 }}>
              <thead><tr className="text-[10px] uppercase tracking-wide" style={{ color: '#9CA3AF' }}>
                <th className="w-6"></th><th className="text-left px-3 py-2">{L('Nguyên liệu', 'Raw material')}</th><th className="text-right px-3 py-2">{L('Đã lấy', 'Taken')}</th>
                <th className="text-right px-3 py-2">{L('Công thức', 'Recipes')}</th><th className="text-right px-3 py-2" style={{ backgroundColor: '#FFFBF0' }}>{L('Chênh lệch', 'Gap')}</th>
                <th className="text-right px-3 py-2">%</th><th className="text-right px-3 py-2">₫</th></tr></thead>
              <tbody>
                {!main.length && <tr><td colSpan={7} className="text-center py-6 text-xs" style={{ color: '#9CA3AF' }}>{L('Chưa có dữ liệu để so sánh trong kỳ.', 'Nothing to compare in the period yet.')}</td></tr>}
                {main.map(x => { const o = open[x.r.code]; const w = x.pct == null ? 0 : Math.min(Math.abs(x.pct) / 0.5, 1) * 56; return (
                  <FragmentRow key={x.r.code}>
                    <tr className="cursor-pointer hover:bg-[#FFFDF6]" style={{ borderTop: `1px solid ${HAIR}` }} onClick={() => setOpen(s => ({ ...s, [x.r.code]: !s[x.r.code] }))}>
                      <td className="pl-3" style={{ color: '#9CA3AF' }}>{o ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                      <td className="px-3 py-2"><b>{x.r.name}</b><div className="text-[10.5px]" style={{ color: '#9CA3AF' }}>{x.r.code}</div></td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(x.taken)} {x.r.uom}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(x.recipe)} {x.r.uom}</td>
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: '#FFFBF0' }}>
                        <div className="flex items-center justify-end gap-2"><b className="tabular-nums">{signed(x.gap, fmtQty)} {x.r.uom}</b>
                          <span className="relative inline-block w-[120px] h-3 flex-none" title={`${x.pct == null ? '' : (x.pct * 100).toFixed(1) + ' %'}`}>
                            <span className="absolute top-[-2px] bottom-[-2px] w-px" style={{ left: '50%', backgroundColor: '#D0D5DD' }} />
                            <span className="absolute top-0.5 h-2 rounded" style={{ backgroundColor: x.gap >= 0 ? OVER : UNDER, width: Math.max(w, 2), ...(x.gap >= 0 ? { left: '50%' } : { right: '50%' }) }} />
                          </span></div></td>
                      <td className="px-3 py-2 text-right tabular-nums">{x.pct == null ? '—' : `${signed(x.pct * 100, n => n.toLocaleString('vi-VN', { maximumFractionDigits: 1 }))} %`}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{signed(x.val, vnd)}</td>
                    </tr>
                    {o && teamsIn.filter(t => (x.r.taken[t] ?? 0) > 0 || (x.r.recipe[t] ?? 0) > 0).map(t => { const tk = x.r.taken[t] ?? 0, rc = x.r.recipe[t] ?? 0; return (
                      <tr key={t} style={{ backgroundColor: '#FCFAF3' }}>
                        <td></td><td className="px-3 py-1.5 text-[12px]"><span className="text-[10.5px] font-extrabold rounded px-1.5 py-0.5" style={{ backgroundColor: TEAM_SHORT[t]?.bg, color: TEAM_SHORT[t]?.color }}>{TEAM_SHORT[t]?.[lang === 'vi' ? 'vi' : 'en'] ?? t}</span> <span style={{ color: '#6B7280' }}>· {x.r.slips[t] ?? 0} {L('phiếu', 'slips')}</span></td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-[12px]">{fmtQty(tk)} {x.r.uom}</td><td className="px-3 py-1.5 text-right tabular-nums text-[12px]">{fmtQty(rc)} {x.r.uom}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-[12px]" style={{ backgroundColor: '#FFF8E6' }}><b>{signed(tk - rc, fmtQty)} {x.r.uom}</b></td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-[12px]">{rc ? `${signed((tk - rc) / rc * 100, n => n.toFixed(1))} %` : '—'}</td><td className="px-3 py-1.5 text-right tabular-nums text-[12px]">{signed((tk - rc) * x.r.cost, vnd)}</td>
                      </tr>); })}
                  </FragmentRow>); })}
              </tbody>
            </table>
          </div>
          {data.unresolved.length > 0 && <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{L('Sản phẩm không có công thức Odoo (không tính):', 'Products with no Odoo recipe (not counted):')} {data.unresolved.slice(0, 12).map(u => `${u.name} (${fmtQty(u.qty)})`).join(', ')}</div>}
          <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{L('So sánh theo tuần hoặc tháng: nguyên liệu còn trong phòng chef làm lệch số theo ngày. Bao gồm đóng gói OEM (team Hưng).', 'Compare by week or month: what sits in the chef rooms skews daily figures. OEM packing (team Hưng) included.')}</div>
        </>
      )}
    </div>
  );
}
function FragmentRow({ children }: { children: React.ReactNode }) { return <>{children}</>; }
function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return <div className="bg-white rounded-xl px-3.5 py-3" style={{ border: `1px solid ${BORDER}` }}>
    <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: '#9CA3AF' }}>{label}</div>
    <div className="text-xl font-extrabold tabular-nums mt-0.5" style={{ color: color ?? NAVY }}>{value}</div>
    {sub && <div className="text-[11.5px]" style={{ color: '#6B7280' }}>{sub}</div>}</div>;
}
