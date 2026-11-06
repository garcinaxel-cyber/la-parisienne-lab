'use client';
// HR pilot — employee personal space (Axel, 2026-11-06). Phone only, VI by default, EN toggle.
// Schedule (published months only), requests (12 paper-form types + missed punch + shift swap),
// next month's off-day wishes with the team rules, overtime confirmation (replaces "Ký nhận").
import { useCallback, useEffect, useState } from 'react';
import {
  HR_REQUEST_TYPES, HR_RULES, SHIFT_HOURS, daysInMonth, dayStr, dow, hanoiToday, hrNeedsGiang, hrTypeLabel, isWeekend,
  monthLabel, shortDay,
} from '@/lib/hr';
import { loadMeAction, submitRequestAction, cancelRequestAction, confirmOtAction, saveWishesAction, type MeData } from './actions';

type Tab = 'schedule' | 'requests' | 'off' | 'month';
const BORDER = '1px solid #E0D49A';

export default function EmployeeHrView({ token }: { token: string }) {
  const [lang, setLangState] = useState<'vi' | 'en'>('vi');
  useEffect(() => { try { const l = localStorage.getItem('hr-lang'); if (l === 'en' || l === 'vi') setLangState(l); } catch {} }, []);
  const setLang = (l: 'vi' | 'en') => { setLangState(l); try { localStorage.setItem('hr-lang', l); } catch {} };
  const tr = (en: string, vi: string) => (lang === 'vi' ? vi : en);
  const [tab, setTab] = useState<Tab>('schedule');
  const [data, setData] = useState<MeData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await loadMeAction(token);
    if (r.error) setErr(r.error); else { setErr(null); setData(r.data!); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  if (err === 'INVALID') {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#FFF4CC' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: BORDER }}>
          <div className="text-3xl mb-2">🔒</div>
          <h1 className="font-bold text-lg" style={{ color: '#1A4731' }}>Liên kết không hợp lệ</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>Vui lòng liên hệ trưởng nhóm để nhận link mới.</p>
          <p className="text-xs mt-3" style={{ color: '#9CA3AF' }}>Invalid link — ask your team leader for a new one.</p>
        </div>
      </div>
    );
  }

  const pendingOt = (data?.ots ?? []).filter((o) => o.confirm == null && o.status !== 'rejected' && o.day >= hanoiToday());
  const tabBtn = (id: Tab, label: string, dot = false) => (
    <button key={id} onClick={() => setTab(id)} className="flex-1 min-h-[42px] text-[11px] font-bold flex items-center justify-center gap-1"
      style={tab === id ? { color: '#C9A84C', borderBottom: '2px solid #C9A84C' } : { color: 'rgba(255,255,255,0.6)', borderBottom: '2px solid transparent' }}>
      {label}{dot && <span className="w-[7px] h-[7px] rounded-full" style={{ background: '#EF4444' }} />}
    </button>
  );
  const e = data?.employee;

  return (
    <div className="min-h-screen" style={{ background: '#FFF4CC' }}>
      <header className="sticky top-0 z-20" style={{ background: '#1A4731', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="max-w-xl mx-auto px-3 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-[34px] h-[34px] rounded-xl flex items-center justify-center text-xs font-black text-white shrink-0" style={{ background: 'rgba(255,244,204,0.2)' }}>
              {e ? e.full_name.split(' ').slice(-2).map((w) => w[0]).join('') : '…'}
            </span>
            <div className="min-w-0">
              <div className="text-white font-bold text-sm truncate">{e?.full_name ?? 'La Paris'}</div>
              <div className="text-[11px] truncate" style={{ color: 'rgba(255,255,255,0.75)' }}>{e ? `Team ${e.team === 'hung' ? 'Hưng' : e.team} · ${e.position ?? ''}` : ''}</div>
            </div>
          </div>
          <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.15)' }}>
            {(['vi', 'en'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)} className="px-2 min-h-[28px] rounded text-[11px] font-bold"
                style={lang === l ? { background: '#FFF4CC', color: '#1A4731' } : { color: 'rgba(255,255,255,0.7)' }}>{l.toUpperCase()}</button>
            ))}
          </div>
        </div>
        <div className="max-w-xl mx-auto flex" style={{ background: '#163D29' }}>
          {tabBtn('schedule', tr('Schedule', 'Lịch làm'))}
          {tabBtn('requests', tr('Requests', 'Yêu cầu'))}
          {tabBtn('off', tr('Days off', 'Đăng ký nghỉ'), !!data && data.wishOpen && !data.wishSubmitted && !e?.is_casual)}
          {tabBtn('month', tr('My month', 'Tháng này'))}
        </div>
      </header>

      <main className="max-w-xl mx-auto px-3 py-3 space-y-2.5">
        {err && <div className="rounded-xl px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>{err}</div>}
        {!data ? (
          <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: BORDER, color: '#6B7280' }}>{tr('Loading…', 'Đang tải…')}</div>
        ) : (
          <>
            {pendingOt.map((o) => <OtAsk key={o.id} o={o} token={token} lang={lang} tr={tr} reload={load} />)}
            {tab === 'schedule' && <ScheduleTab data={data} lang={lang} tr={tr} />}
            {tab === 'requests' && <RequestsTab data={data} token={token} lang={lang} tr={tr} reload={load} />}
            {tab === 'off' && <OffTab data={data} token={token} lang={lang} tr={tr} reload={load} />}
            {tab === 'month' && <MonthTab data={data} lang={lang} tr={tr} />}
          </>
        )}
      </main>
    </div>
  );
}

type TR = (en: string, vi: string) => string;

function OtAsk({ o, token, lang, tr, reload }: { o: MeData['ots'][number]; token: string; lang: string; tr: TR; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const answer = async (a: 'yes' | 'no') => { setBusy(true); await confirmOtAction(token, o.id, a); setBusy(false); reload(); };
  return (
    <div className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: '2px solid #C9A84C' }}>
      <div className="text-[11px] font-black uppercase" style={{ color: '#b45309' }}>{tr('Overtime · please confirm', 'Tăng ca · vui lòng xác nhận')}</div>
      <div className="text-sm font-bold">{shortDay(o.day, lang)} · {o.time_from}–{o.time_to} ({o.hours} {tr('h', 'giờ')})</div>
      <div className="text-xs" style={{ color: '#6B7280' }}>{tr('Asked by ', 'Đề nghị bởi ')}{o.created_by_name ?? ''}{o.reason ? ` · ${o.reason}` : ''}</div>
      <div className="grid grid-cols-[1fr_1.6fr] gap-2">
        <button disabled={busy} onClick={() => answer('no')} className="min-h-[44px] rounded-xl text-[13px] font-bold bg-white disabled:opacity-50" style={{ border: BORDER }}>{tr('I can’t', 'Không thể')}</button>
        <button disabled={busy} onClick={() => answer('yes')} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-50" style={{ background: '#1A4731' }}>{tr('Confirm', 'Xác nhận')}</button>
      </div>
    </div>
  );
}

// ───────────── Schedule ─────────────
function ScheduleTab({ data, lang, tr }: { data: MeData; lang: string; tr: TR }) {
  const visible = data.months.filter((m) => m.published);
  const [mi, setMi] = useState(0);
  const today = hanoiToday();
  const [sel, setSel] = useState(today);
  if (!visible.length) {
    return <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: BORDER, color: '#6B7280' }}>{tr('Your leader has not published the schedule yet.', 'Trưởng nhóm chưa công bố lịch làm.')}</div>;
  }
  const m = visible[Math.min(mi, visible.length - 1)];
  const n = daysInMonth(m.month);
  const base = data.employee.base_shift === '8' ? '8' : '7';
  const wish = new Set(m.myWishes);
  const code = (d: string) => m.stored[d] ?? (wish.has(d) ? 'O' : base);
  const otDays = new Set(data.ots.filter((o) => o.status !== 'rejected' && o.confirm !== 'no').map((o) => o.day));
  const lead = (dow(m.month) + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = 1; d <= n; d++) cells.push(dayStr(m.month, d));
  while (cells.length % 7) cells.push(null);
  const dl = lang === 'vi' ? ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const c = sel.startsWith(m.month.slice(0, 7)) ? code(sel) : null;
  const ot = data.ots.find((o) => o.day === sel && o.status !== 'rejected');
  return (
    <div className="space-y-2.5">
      <div className="bg-white rounded-2xl p-3" style={{ border: BORDER }}>
        <div className="flex justify-between items-center mb-2">
          <span className="font-serif font-bold text-[17px]" style={{ color: '#1A4731' }}>{monthLabel(m.month, lang)}</span>
          {visible.length > 1 && (
            <div className="flex gap-1">
              {visible.map((v, i) => (
                <button key={v.month} onClick={() => setMi(i)} className="text-[11px] font-bold rounded-full px-2.5 min-h-[30px]"
                  style={i === mi ? { background: '#1A4731', color: '#fff' } : { border: BORDER, background: '#fff' }}>{monthLabel(v.month, lang)}</button>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-7 gap-1 text-[10px] font-bold text-center mb-1" style={{ color: '#6B7280' }}>{dl.map((x) => <span key={x}>{x}</span>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const k = code(d);
            const bg = k === 'O' ? '#F5E89A' : k === 'PH' ? '#F3F4F6' : k === 'AL' || k === 'SN' ? '#eff6ff' : '#fff';
            return (
              <button key={i} onClick={() => setSel(d)} className="min-h-[46px] rounded-xl flex flex-col items-center justify-center gap-[1px]"
                style={{ background: bg, border: d === sel ? '2px solid #1A4731' : d === today ? '2px solid #C9A84C' : '1px solid #F0E6B8' }}>
                <span className="text-[10px]" style={{ color: '#6B7280' }}>{Number(d.slice(8))}</span>
                <span className="text-xs font-black" style={{ color: otDays.has(d) ? '#b45309' : k === 'AL' || k === 'SN' ? '#0369a1' : '#1A4731' }}>{k}{otDays.has(d) ? '+' : ''}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] mt-2" style={{ color: '#6B7280' }}>
          <span><b style={{ color: '#1A4731' }}>7</b> {SHIFT_HOURS['7']}</span><span><b style={{ color: '#1A4731' }}>8</b> {SHIFT_HOURS['8']}</span>
          <span><b style={{ color: '#1A4731' }}>O</b> {tr('off', 'nghỉ')}</span><span><b style={{ color: '#0369a1' }}>AL</b> {tr('annual leave', 'phép năm')}</span>
          <span><b>PH</b> {tr('holiday', 'ngày lễ')}</span><span><b style={{ color: '#0369a1' }}>SN</b> {tr('birthday', 'sinh nhật')}</span><span><b style={{ color: '#b45309' }}>+</b> {tr('overtime', 'tăng ca')}</span>
        </div>
      </div>
      {c && (
        <div className="bg-white rounded-2xl p-3.5 space-y-1" style={{ border: BORDER }}>
          <div className="text-xs font-bold" style={{ color: '#6B7280' }}>{shortDay(sel, lang)}{sel === today ? tr(' · today', ' · hôm nay') : ''}</div>
          <div className="text-base font-black" style={{ color: '#1A4731' }}>
            {c === 'O' ? tr('Day off', 'Ngày nghỉ') : c === 'AL' ? tr('Annual leave', 'Nghỉ phép năm') : c === 'PH' ? tr('Public holiday', 'Ngày lễ') : c === 'SN' ? tr('Birthday leave', 'Nghỉ sinh nhật') : SHIFT_HOURS[c]}
          </div>
          {ot && <div className="text-xs font-semibold" style={{ color: '#b45309' }}>{tr('Overtime ', 'Tăng ca ')}{ot.time_from}–{ot.time_to}</div>}
        </div>
      )}
    </div>
  );
}

// ───────────── Requests ─────────────
function RequestsTab({ data, token, lang, tr, reload }: { data: MeData; token: string; lang: string; tr: TR; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('annual');
  const today = hanoiToday();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [tFrom, setTFrom] = useState('');
  const [tTo, setTTo] = useState('');
  const [reason, setReason] = useState('');
  const [swapWith, setSwapWith] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const timeTypes = ['late', 'early', 'missed_punch'];
  const send = async () => {
    if (type === 'swap' && !swapWith) { setMsg(tr('Pick the colleague you swap with', 'Chọn đồng nghiệp đổi ca')); return; }
    setBusy(true);
    const r = await submitRequestAction(token, { type, day_from: from, day_to: to || undefined, time_from: tFrom || undefined, time_to: tTo || undefined, reason, swap_with: swapWith || undefined });
    setBusy(false);
    if (r.error) { setMsg(r.error); return; }
    setOpen(false); setReason(''); setTo(''); setTFrom(''); setTTo(''); setSwapWith(''); setMsg(null);
    reload();
  };
  const cancel = async (id: string) => { await cancelRequestAction(token, id); reload(); };
  const step = (label: string, state: 'ok' | 'wait' | 'todo' | 'no') => (
    <span key={label} className="text-[11px] font-bold rounded-full px-2 py-[3px]"
      style={state === 'ok' ? { background: '#ECFDF5', color: '#047857' } : state === 'wait' ? { background: '#FFFBEB', color: '#b45309' } : state === 'no' ? { background: '#FEF2F2', color: '#DC2626' } : { background: '#F3F4F6', color: '#9CA3AF' }}>{label}</span>
  );
  const input = 'w-full min-h-[42px] rounded-xl px-2.5 text-sm bg-white';
  const lbl = 'text-[11px] font-bold';
  return (
    <div className="space-y-2.5">
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full min-h-[50px] rounded-2xl font-bold text-sm bg-white" style={{ border: '1px dashed #1A4731', color: '#1A4731' }}>+ {tr('New request', 'Tạo yêu cầu')}</button>
      ) : (
        <div className="bg-white rounded-2xl p-3.5 space-y-2.5" style={{ border: BORDER }}>
          <div className="flex justify-between items-center">
            <span className="text-sm font-bold">{tr('New request', 'Tạo yêu cầu')}</span>
            <button onClick={() => setOpen(false)} aria-label="Close" className="w-8 h-8 text-lg" style={{ color: '#6B7280' }}>×</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {HR_REQUEST_TYPES.map((t) => (
              <button key={t.id} onClick={() => setType(t.id)} className="min-h-[34px] px-2.5 rounded-full text-xs font-semibold"
                style={type === t.id ? { background: '#1A4731', color: '#fff', border: '1px solid #1A4731' } : { background: '#fff', border: BORDER }}>{lang === 'vi' ? t.vi : t.en}</button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{type === 'swap' ? tr('My day', 'Ngày của tôi') : tr('Date', 'Ngày')}</span>
              <input type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} className={input} style={{ border: BORDER }} /></label>
            <label className="space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{type === 'swap' ? tr('Their day', 'Ngày của họ') : tr('Until (optional)', 'Đến ngày (nếu có)')}</span>
              <input type="date" value={to} onChange={(ev) => setTo(ev.target.value)} className={input} style={{ border: BORDER }} /></label>
          </div>
          {timeTypes.includes(type) && (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{type === 'missed_punch' ? tr('Real in', 'Giờ vào thực') : tr('From', 'Từ')}</span>
                <input type="time" value={tFrom} onChange={(ev) => setTFrom(ev.target.value)} className={input} style={{ border: BORDER }} /></label>
              <label className="space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{type === 'missed_punch' ? tr('Real out', 'Giờ ra thực') : tr('To', 'Đến')}</span>
                <input type="time" value={tTo} onChange={(ev) => setTTo(ev.target.value)} className={input} style={{ border: BORDER }} /></label>
            </div>
          )}
          {type === 'swap' && (
            <label className="block space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{tr('Swap with', 'Đổi với')}</span>
              <select value={swapWith} onChange={(ev) => setSwapWith(ev.target.value)} className={input} style={{ border: BORDER }}>
                <option value="">—</option>
                {data.colleagues.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select></label>
          )}
          <label className="block space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{tr('Reason', 'Lý do')}</span>
            <textarea value={reason} onChange={(ev) => setReason(ev.target.value)} className="w-full min-h-[56px] rounded-xl px-2.5 py-2 text-sm" style={{ border: BORDER }} /></label>
          <div className="text-[11px]" style={{ color: '#6B7280' }}>
            {hrNeedsGiang(type) ? tr('You → Team leader → Mr Giang → HR', 'Bạn → Trưởng nhóm → Anh Giang → Nhân sự') : tr('You → Team leader', 'Bạn → Trưởng nhóm')}
            {type === 'missed_punch' ? tr(' · without approval −50,000 đ', ' · không được duyệt −50.000đ') : ''}
          </div>
          {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
          <button disabled={busy} onClick={send} className="w-full min-h-[48px] rounded-2xl font-bold text-sm text-white disabled:opacity-50" style={{ background: '#1A4731' }}>{tr('Send to my leader', 'Gửi trưởng nhóm')}</button>
        </div>
      )}

      <div className="text-xs font-bold px-1" style={{ color: '#1A4731' }}>{tr('My requests', 'Yêu cầu của tôi')}</div>
      {data.requests.length === 0 && <div className="bg-white rounded-2xl p-4 text-center text-xs" style={{ border: BORDER, color: '#6B7280' }}>{tr('No request yet', 'Chưa có yêu cầu')}</div>}
      {data.requests.map((r) => {
        const needsG = hrNeedsGiang(r.type);
        const steps = [step(tr('Sent ✓', 'Đã gửi ✓'), 'ok')];
        if (r.status === 'cancelled') steps.push(step(tr('Cancelled', 'Đã hủy'), 'todo'));
        else if (r.status === 'pending_leader') { steps.push(step(tr('Leader ⏳', 'Trưởng nhóm ⏳'), 'wait')); if (needsG) steps.push(step(tr('Mr Giang', 'Anh Giang'), 'todo')); }
        else if (r.status === 'rejected') steps.push(step(r.giang_at ? tr('Mr Giang ✕', 'Anh Giang ✕') : tr('Leader ✕', 'Trưởng nhóm ✕'), 'no'));
        else {
          steps.push(step(tr('Leader ✓', 'Trưởng nhóm ✓'), 'ok'));
          if (needsG) steps.push(step(r.status === 'approved' ? tr('Mr Giang ✓', 'Anh Giang ✓') : tr('Mr Giang ⏳', 'Anh Giang ⏳'), r.status === 'approved' ? 'ok' : 'wait'));
        }
        return (
          <div key={r.id} className="bg-white rounded-2xl px-3.5 py-3 space-y-2" style={{ border: BORDER }}>
            <div className="flex justify-between gap-2">
              <span className="text-sm font-bold">{hrTypeLabel(r.type, lang)}</span>
              <span className="text-xs" style={{ color: '#6B7280' }}>{shortDay(r.day_from, lang)}{r.day_to && r.day_to !== r.day_from ? ` → ${shortDay(r.day_to, lang)}` : ''}</span>
            </div>
            <div className="flex flex-wrap gap-1 items-center">{steps}</div>
            {r.status === 'pending_leader' && <button onClick={() => cancel(r.id)} className="text-xs underline min-h-[30px]" style={{ color: '#6B7280' }}>{tr('Cancel my request', 'Hủy yêu cầu')}</button>}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Days off (next month) ─────────────
function OffTab({ data, token, lang, tr, reload }: { data: MeData; token: string; lang: string; tr: TR; reload: () => void }) {
  const month = data.wishMonth;
  const [pick, setPick] = useState<string[]>(data.myNextWishes);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(data.wishSubmitted);
  useEffect(() => { setPick(data.myNextWishes); setSaved(data.wishSubmitted); }, [data.myNextWishes, data.wishSubmitted]);
  const casual = data.employee.is_casual;
  const n = daysInMonth(month);
  const sat = pick.filter((d) => dow(d) === 6).length;
  const sun = pick.filter((d) => dow(d) === 0).length;
  const full = (d: string) => !casual && (data.teamWishCount[d] ?? 0) >= (isWeekend(d) ? HR_RULES.maxOffWeekend : HR_RULES.maxOffWeekday);
  const toggle = (d: string) => {
    if (!data.wishOpen) return;
    setSaved(false);
    if (pick.includes(d)) { setPick(pick.filter((x) => x !== d)); setMsg(null); return; }
    if (full(d)) { setMsg(tr('This day is full: the team already has the maximum people off.', 'Ngày này đã đủ người nghỉ.')); return; }
    if (!casual && pick.length >= HR_RULES.offPerMonth) { setMsg(tr(`Max ${HR_RULES.offPerMonth} days off per month.`, `Tối đa ${HR_RULES.offPerMonth} ngày nghỉ mỗi tháng.`)); return; }
    if (!casual && dow(d) === 6 && sat >= HR_RULES.maxSat) { setMsg(tr('Max 2 Saturdays off.', 'Tối đa 2 Thứ 7 nghỉ.')); return; }
    if (!casual && dow(d) === 0 && sun >= HR_RULES.maxSun) { setMsg(tr('Max 2 Sundays off.', 'Tối đa 2 Chủ nhật nghỉ.')); return; }
    setPick([...pick, d]); setMsg(null);
  };
  const save = async () => {
    setBusy(true);
    const r = await saveWishesAction(token, month, pick);
    setBusy(false);
    if (r.error) {
      const e = r.error;
      setMsg(e === 'CLOSED' ? tr('Registration is closed (after the 25th).', 'Đã hết hạn đăng ký (sau ngày 25).')
        : e.startsWith('FULL:') ? tr(`${shortDay(e.slice(5), lang)} just became full — pick another day.`, `${shortDay(e.slice(5), lang)} vừa đủ người — chọn ngày khác.`) : e);
      reload(); return;
    }
    setSaved(true); reload();
  };
  const lead = (dow(month) + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let d = 1; d <= n; d++) cells.push(dayStr(month, d));
  while (cells.length % 7) cells.push(null);
  const dl = lang === 'vi' ? ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const counter = (label: string, v: number, max: number) => (
    <div className="bg-white rounded-2xl p-2.5" style={{ border: v >= max ? '1px solid #C9A84C' : BORDER }}>
      <div className="text-[10px]" style={{ color: '#6B7280' }}>{label}</div>
      <div className="text-lg font-black">{v} / {max}</div>
    </div>
  );
  return (
    <div className="space-y-2.5">
      <div className="px-1">
        <div className="font-serif font-bold text-[17px]" style={{ color: '#1A4731' }}>{tr('My days off · ', 'Ngày nghỉ của tôi · ')}{monthLabel(month, lang)}</div>
        <div className="text-[11px]" style={{ color: data.wishOpen ? '#6B7280' : '#DC2626' }}>
          {data.wishOpen ? tr(`Open until the ${HR_RULES.wishDeadlineDay}th · first registered, first served`, `Mở đến ngày ${HR_RULES.wishDeadlineDay} · ai đăng ký trước được ưu tiên`) : tr('Closed — ask your leader for changes', 'Đã đóng — liên hệ trưởng nhóm nếu cần đổi')}
        </div>
      </div>
      {!casual && (
        <div className="grid grid-cols-3 gap-1.5">
          {counter(tr('Days off', 'Ngày nghỉ'), pick.length, HR_RULES.offPerMonth)}
          {counter(tr('Saturdays', 'Thứ 7'), sat, HR_RULES.maxSat)}
          {counter(tr('Sundays', 'Chủ nhật'), sun, HR_RULES.maxSun)}
        </div>
      )}
      <div className="bg-white rounded-2xl p-3" style={{ border: BORDER }}>
        <div className="grid grid-cols-7 gap-1 text-[10px] font-bold text-center mb-1" style={{ color: '#6B7280' }}>{dl.map((x) => <span key={x}>{x}</span>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const on = pick.includes(d), isFull = !on && full(d), wk = isWeekend(d);
            return (
              <button key={i} onClick={() => toggle(d)} className="min-h-[44px] rounded-xl flex flex-col items-center justify-center"
                style={on ? { background: '#1A4731', color: '#fff', border: '1px solid #1A4731' } : isFull ? { background: '#F3F4F6', color: '#9CA3AF', border: '1px solid #E5E7EB' } : { background: wk ? '#FFFAEE' : '#fff', border: wk ? BORDER : '1px solid #F0E6B8' }}>
                <span className="text-[13px] font-bold">{Number(d.slice(8))}</span>
                <span className="text-[8px]">{on ? tr('off', 'nghỉ') : isFull ? tr('full', 'đủ') : ''}</span>
              </button>
            );
          })}
        </div>
      </div>
      {msg && <div className="rounded-xl px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>{msg}</div>}
      {data.wishOpen && (
        <button disabled={busy} onClick={save} className="w-full min-h-[50px] rounded-2xl font-bold text-sm disabled:opacity-50"
          style={saved ? { background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' } : { background: '#1A4731', color: '#fff' }}>
          {saved ? tr('✓ Sent to my leader · you can change until the 25th', '✓ Đã gửi trưởng nhóm · có thể sửa đến ngày 25') : `${tr('Send my days off', 'Gửi đăng ký nghỉ')} (${pick.length})`}
        </button>
      )}
    </div>
  );
}

// ───────────── My month ─────────────
function MonthTab({ data, lang, tr }: { data: MeData; lang: string; tr: TR }) {
  const cur = data.months[0];
  const n = daysInMonth(cur.month);
  const base = data.employee.base_shift === '8' ? '8' : '7';
  const wish = new Set(cur.myWishes);
  let work = 0, off = 0, al = 0;
  for (let d = 1; d <= n; d++) {
    const day = dayStr(cur.month, d);
    const k = cur.stored[day] ?? (wish.has(day) ? 'O' : base);
    if (k === '7' || k === '8') work++; else if (k === 'O') off++; else if (k === 'AL') al++;
  }
  const pendingReq = data.requests.filter((r) => r.status === 'pending_leader' || r.status === 'pending_giang').length;
  const box = (label: string, value: string) => (
    <div className="bg-white rounded-2xl p-3" style={{ border: BORDER }}>
      <div className="text-[10px]" style={{ color: '#6B7280' }}>{label}</div>
      <div className="text-xl font-black">{value}</div>
    </div>
  );
  return (
    <div className="space-y-2.5">
      <div className="font-serif font-bold text-[17px] px-1" style={{ color: '#1A4731' }}>{monthLabel(cur.month, lang)}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {box(tr('Scheduled work days', 'Ngày làm theo lịch'), String(work))}
        {box(tr('Days off · annual leave', 'Ngày nghỉ · phép năm'), `${off} · ${al}`)}
        {box(tr('Overtime this month', 'Tăng ca tháng này'), `${data.otMonthHours} ${tr('h', 'giờ')}`)}
        {box(tr('Requests in progress', 'Yêu cầu đang chờ'), String(pendingReq))}
      </div>
      <div className="rounded-2xl px-3.5 py-3 text-xs leading-relaxed" style={{ background: '#FFFAEE', border: BORDER, color: '#1A4731' }}>
        {tr('Your time clock hours and your payslip will appear here when HR imports the time clock data.', 'Giờ chấm công và phiếu lương sẽ hiện ở đây khi Nhân sự nhập dữ liệu chấm công.')}
        <br />
        {tr('1 day = 9 h on site incl. 1 h break · overtime only with an approved request.', '1 công = có mặt 9 tiếng (gồm 1 tiếng nghỉ) · tăng ca chỉ tính khi có đơn được duyệt.')}
      </div>
    </div>
  );
}
