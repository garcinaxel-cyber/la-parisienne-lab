'use client';
// HR pilot — station "Team" tab for the team leader (Axel, 2026-11-06, Team Hưng first).
// Requests from the team (leader OK → Mr Giang), monthly schedule built from the off-day wishes with
// live rule checks, group overtime requests, and the team list with each employee's personal link.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Check, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  HR_CYCLE, HR_OFF_CODES, HR_RULES, SHIFT_HOURS, addMonths, daysInMonth, dayStr, dow, hanoiToday, hoursBetween,
  hrTypeLabel, isWeekend, monthLabel, monthStart, scheduleAlerts, scheduleCode, shortDay, DOW_EN, DOW_VI,
  type HrEmployee,
} from '@/lib/hr';
import {
  loadTeamHrAction, setScheduleCodeAction, setMonthStatusAction, decideRequestAction, createOtAction, cancelOtAction,
  type TeamHrData,
} from './hr-actions';

type Sub = 'requests' | 'schedule' | 'overtime' | 'team';
const BORDER = '1px solid #E0D49A';

export default function HrTeamTab({ team, lang }: { team: string; lang: 'vi' | 'en' }) {
  const tr = (en: string, vi: string) => (lang === 'vi' ? vi : en);
  const today = hanoiToday();
  const [sub, setSub] = useState<Sub>('requests');
  const [month, setMonth] = useState(() => (Number(today.slice(8, 10)) >= 20 ? addMonths(monthStart(today), 1) : monthStart(today)));
  const [data, setData] = useState<TeamHrData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await loadTeamHrAction(team, month);
    setBusy(false);
    if (r.error) setErr(r.error); else { setErr(null); setData(r.data!); }
  }, [team, month]);
  useEffect(() => { load(); }, [load]);

  if (err === 'HR_NOT_INSTALLED') {
    return <div className="bg-white rounded-2xl p-6 text-sm" style={{ border: BORDER }}>{tr('The HR module is not installed yet (database migration v145 missing).', 'Module nhân sự chưa được cài (thiếu migration v145).')}</div>;
  }

  const pending = (data?.requests ?? []).filter((r) => r.status === 'pending_leader');
  const subBtn = (id: Sub, label: string, count = 0) => (
    <button key={id} onClick={() => setSub(id)}
      className="min-h-[40px] rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 px-1 active:scale-95"
      style={sub === id ? { background: '#1A4731', color: '#FFF4CC', border: '1px solid #1A4731' } : { background: '#fff', color: '#1A4731', border: BORDER }}>
      {label}
      {count > 0 && <span className="min-w-[16px] h-4 rounded-full text-[9px] font-black inline-flex items-center justify-center px-1"
        style={sub === id ? { background: '#C9A84C', color: '#1A4731' } : { background: '#DC2626', color: '#fff' }}>{count}</span>}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-1.5">
        {subBtn('requests', tr('Requests', 'Yêu cầu'), pending.length)}
        {subBtn('schedule', tr('Schedule', 'Lịch làm'))}
        {subBtn('overtime', tr('Overtime', 'Tăng ca'))}
        {subBtn('team', tr('My team', 'Nhóm'))}
      </div>
      {err && <div className="rounded-xl px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>{err}</div>}
      {!data ? (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: BORDER, color: '#6B7280' }}>{tr('Loading…', 'Đang tải…')}</div>
      ) : (
        <>
          {sub === 'requests' && <RequestsView data={data} team={team} lang={lang} tr={tr} reload={load} />}
          {sub === 'schedule' && <ScheduleView data={data} team={team} lang={lang} tr={tr} month={month} setMonth={setMonth} reload={load} busy={busy} setData={setData} />}
          {sub === 'overtime' && <OvertimeView data={data} team={team} lang={lang} tr={tr} reload={load} today={today} />}
          {sub === 'team' && <TeamView data={data} lang={lang} tr={tr} />}
        </>
      )}
    </div>
  );
}

type TR = (en: string, vi: string) => string;
const nameOf = (data: TeamHrData, id: string | null) => data.employees.find((e) => e.id === id)?.full_name ?? '—';

// ───────────────────────── Requests ─────────────────────────
function RequestsView({ data, team, lang, tr, reload }: { data: TeamHrData; team: string; lang: string; tr: TR; reload: () => void }) {
  const [filter, setFilter] = useState<'pending' | 'done'>('pending');
  const [working, setWorking] = useState<string | null>(null);
  const list = data.requests.filter((r) => (filter === 'pending' ? r.status === 'pending_leader' : r.status !== 'pending_leader' && r.status !== 'cancelled'));
  const act = async (id: string, d: 'ok' | 'reject' | 'undo') => {
    setWorking(id);
    const r = await decideRequestAction(team, id, d);
    setWorking(null);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const statusLabel = (s: string) => ({
    pending_giang: [tr('✓ OK · waiting Mr Giang', '✓ Đồng ý · chờ anh Giang'), '#b45309'],
    approved: [tr('✓ Approved', '✓ Đã duyệt'), '#047857'],
    rejected: [tr('✕ Rejected', '✕ Từ chối'), '#DC2626'],
  } as Record<string, string[]>)[s] ?? [s, '#6B7280'];
  const pendingN = data.requests.filter((r) => r.status === 'pending_leader').length;
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        {(['pending', 'done'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="flex-1 min-h-[38px] rounded-xl text-xs font-bold"
            style={filter === f ? { background: '#1A4731', color: '#fff', border: '1px solid #1A4731' } : { background: '#fff', color: '#1A2C24', border: BORDER }}>
            {f === 'pending' ? `${tr('To review', 'Cần xử lý')} (${pendingN})` : tr('Done', 'Đã xử lý')}
          </button>
        ))}
      </div>
      {list.length === 0 && (
        <div className="bg-white rounded-2xl p-6 text-center text-sm font-semibold" style={{ border: BORDER, color: '#047857' }}>
          {filter === 'pending' ? tr('All clear ✓', 'Không còn yêu cầu ✓') : tr('Nothing yet', 'Chưa có')}
        </div>
      )}
      {list.map((r) => {
        const [sl, sc] = statusLabel(r.status);
        const when = r.day_to && r.day_to !== r.day_from ? `${shortDay(r.day_from, lang)} → ${shortDay(r.day_to, lang)}` : shortDay(r.day_from, lang);
        const time = r.time_from || r.time_to ? ` · ${r.time_from ?? ''}–${r.time_to ?? ''}` : '';
        return (
          <div key={r.id} className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: BORDER }}>
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="text-sm font-bold">{nameOf(data, r.employee_id)}</div>
                <div className="text-xs" style={{ color: '#6B7280' }}>{when}{time}</div>
              </div>
              <span className="text-[11px] font-bold rounded-full px-2 py-1 whitespace-nowrap" style={{ color: '#0369a1', background: '#eff6ff' }}>{hrTypeLabel(r.type, lang)}</span>
            </div>
            {r.type === 'swap' && r.swap_with && (
              <div className="text-xs rounded-lg px-2.5 py-2" style={{ background: '#FFFAEE' }}>{tr('Swap with ', 'Đổi với ')}<b>{nameOf(data, r.swap_with)}</b>{tr(' · adjust the schedule after approval', ' · sửa lịch sau khi duyệt')}</div>
            )}
            {r.reason && <div className="text-xs" style={{ color: '#6B7280' }}>“{r.reason}”</div>}
            {r.status === 'pending_leader' ? (
              <div className="grid grid-cols-[1fr_1.5fr] gap-2">
                <button disabled={working === r.id} onClick={() => act(r.id, 'reject')} className="min-h-[44px] rounded-xl text-[13px] font-bold bg-white disabled:opacity-50" style={{ border: BORDER }}>{tr('Reject', 'Từ chối')}</button>
                <button disabled={working === r.id} onClick={() => act(r.id, 'ok')} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-50" style={{ background: '#1A4731' }}>
                  {r.type === 'swap' ? tr('Approve swap', 'Duyệt đổi ca') : tr('OK → Mr Giang', 'Đồng ý → anh Giang')}
                </button>
              </div>
            ) : (
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold" style={{ color: sc }}>{sl}</span>
                {(r.status === 'pending_giang' || r.status === 'rejected' || (r.status === 'approved' && r.type === 'swap')) && (
                  <button onClick={() => act(r.id, 'undo')} className="text-xs underline min-h-[32px]" style={{ color: '#6B7280' }}>{tr('Undo', 'Hoàn tác')}</button>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] px-1 leading-relaxed" style={{ color: '#6B7280' }}>
        {tr('Leave, missed punch and late requests go on to Mr Giang after your OK. Shift swaps: your OK is final.', 'Nghỉ, quên chấm công, đi muộn: sau khi bạn đồng ý sẽ chuyển anh Giang duyệt. Đổi ca: bạn duyệt là xong.')}
      </p>
    </div>
  );
}

// ───────────────────────── Schedule ─────────────────────────
function ScheduleView({ data, team, lang, tr, month, setMonth, reload, busy, setData }: {
  data: TeamHrData; team: string; lang: string; tr: TR; month: string; setMonth: (m: string) => void; reload: () => void; busy: boolean;
  setData: (d: TeamHrData) => void;
}) {
  const [week, setWeek] = useState(0);
  const [publishing, setPublishing] = useState(false);
  useEffect(() => { setWeek(0); }, [month]);
  const wishes = useMemo(() => new Set(data.wishes), [data.wishes]);
  const codeOf = useCallback((e: HrEmployee, day: string) => scheduleCode(e, day, data.stored, wishes), [data.stored, wishes]);
  const alerts = useMemo(() => scheduleAlerts(month, data.employees, codeOf), [month, data.employees, codeOf]);
  const n = daysInMonth(month);
  // Monday-start weeks covering the month
  const firstDow = (dow(month) + 6) % 7; // 0 = Monday
  const weeks = Math.ceil((firstDow + n) / 7);
  const days: (string | null)[] = [];
  for (let i = 0; i < 7; i++) { const d = week * 7 + i - firstDow + 1; days.push(d >= 1 && d <= n ? dayStr(month, d) : null); }
  const regular = data.employees.filter((e) => !e.is_casual);
  const offOn = (day: string) => regular.filter((e) => HR_OFF_CODES.includes(codeOf(e, day))).length;
  const limitOn = (day: string) => (isWeekend(day) ? HR_RULES.maxOffWeekend : HR_RULES.maxOffWeekday);
  const offOfMonth = (e: HrEmployee) => { let c = 0; for (let d = 1; d <= n; d++) if (codeOf(e, dayStr(month, d)) === 'O') c++; return c; };
  const published = data.monthStatus === 'published';
  const dl = lang === 'vi' ? DOW_VI : DOW_EN;

  const tap = async (e: HrEmployee, day: string) => {
    const cur = codeOf(e, day);
    const next = HR_CYCLE[(HR_CYCLE.indexOf(cur) + 1) % HR_CYCLE.length];
    setData({ ...data, stored: { ...data.stored, [e.id + '|' + day]: next } }); // optimistic
    const r = await setScheduleCodeAction(team, e.id, day, next);
    if (r.error) { alertSoft(r.error); reload(); }
  };
  const togglePublish = async () => {
    setPublishing(true);
    const r = await setMonthStatusAction(team, month, published ? 'draft' : 'published');
    setPublishing(false);
    if (r.error) alertSoft(r.error);
    reload();
  };

  return (
    <div className="space-y-2.5">
      <div className="bg-white rounded-2xl px-3 py-2.5 flex items-center justify-between gap-2" style={{ border: BORDER }}>
        <button onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month" className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ border: BORDER, background: '#FFFAEE' }}><ChevronLeft size={16} /></button>
        <div className="text-center min-w-0">
          <div className="font-serif font-bold text-[16px]" style={{ color: '#1A4731' }}>{monthLabel(month, lang)}</div>
          <div className="text-[11px]" style={{ color: '#6B7280' }}>
            {tr('Off-day wishes: ', 'Đăng ký nghỉ: ')}{data.wishSubmitted.length}/{regular.length}
            {' · '}<span className="font-bold" style={{ color: published ? '#047857' : '#b45309' }}>{published ? tr('Published', 'Đã công bố') : tr('Draft', 'Bản nháp')}</span>
          </div>
        </div>
        <button onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month" className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ border: BORDER, background: '#FFFAEE' }}><ChevronRight size={16} /></button>
      </div>

      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: BORDER }}>
        <div className="flex justify-between items-center px-2.5 py-2" style={{ borderBottom: '1px solid #F0E6B8' }}>
          <button onClick={() => setWeek(Math.max(0, week - 1))} aria-label="Previous week" className="w-9 h-9 rounded-xl font-bold" style={{ border: BORDER, background: '#FFFAEE', color: '#1A4731' }}>‹</button>
          <span className="text-[13px] font-bold">{tr('Week ', 'Tuần ')}{week + 1}/{weeks}{busy ? ' …' : ''}</span>
          <button onClick={() => setWeek(Math.min(weeks - 1, week + 1))} aria-label="Next week" className="w-9 h-9 rounded-xl font-bold" style={{ border: BORDER, background: '#FFFAEE', color: '#1A4731' }}>›</button>
        </div>
        <div className="grid gap-[3px] px-2 pt-2 pb-1 text-[10px] text-center" style={{ gridTemplateColumns: '92px repeat(7, minmax(0,1fr))', color: '#6B7280' }}>
          <span />
          {days.map((d, i) => {
            const over = d && offOn(d) > limitOn(d);
            return <span key={i} className="leading-tight" style={over ? { color: '#DC2626', fontWeight: 800 } : d && isWeekend(d) ? { color: '#1A4731', fontWeight: 700 } : {}}>
              {d ? <>{dl[dow(d)]}<br />{Number(d.slice(8))}</> : ''}
            </span>;
          })}
        </div>
        {data.employees.map((e) => {
          const o = offOfMonth(e);
          const bad = !e.is_casual && alerts.some((a) => a.employee_id === e.id);
          return (
            <div key={e.id} className="grid gap-[3px] px-2 py-[3px] items-center" style={{ gridTemplateColumns: '92px repeat(7, minmax(0,1fr))' }}>
              <div className="min-w-0">
                <div className="text-[11px] font-bold truncate">{e.full_name.split(' ').slice(-2).join(' ')}</div>
                <div className="text-[10px]" style={{ color: bad ? '#DC2626' : '#6B7280', fontWeight: bad ? 700 : 400 }}>
                  {e.is_casual ? tr('casual', 'thời vụ') : `${tr('off', 'nghỉ')} ${o}/${HR_RULES.offPerMonth}`}
                </div>
              </div>
              {days.map((d, i) => {
                if (!d) return <span key={i} />;
                const c = codeOf(e, d);
                const wish = wishes.has(e.id + '|' + d);
                const over = !e.is_casual && HR_OFF_CODES.includes(c) && offOn(d) > limitOn(d);
                const bg = c === 'O' ? '#F5E89A' : c === 'AL' || c === 'SN' ? '#eff6ff' : c === 'PH' ? '#F3F4F6' : '#fff';
                const col = c === 'AL' || c === 'SN' ? '#0369a1' : '#1A4731';
                return (
                  <button key={i} onClick={() => tap(e, d)} className="h-[34px] rounded-lg font-bold text-[11px] active:scale-95"
                    style={{ background: bg, color: col, border: over ? '2px solid #DC2626' : wish ? '2px solid #C9A84C' : '1px solid #F0E6B8' }}>{c}</button>
                );
              })}
            </div>
          );
        })}
        <div className="grid gap-[3px] px-2 pt-1.5 pb-2.5 mt-1 text-[10px] text-center" style={{ gridTemplateColumns: '92px repeat(7, minmax(0,1fr))', color: '#6B7280', borderTop: '1px solid #F0E6B8' }}>
          <span className="text-left font-semibold">{tr('Off', 'Nghỉ')}</span>
          {days.map((d, i) => <span key={i} style={d && offOn(d) > limitOn(d) ? { color: '#DC2626', fontWeight: 800 } : {}}>{d ? offOn(d) : ''}</span>)}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] px-1" style={{ color: '#6B7280' }}>
        <span>{tr('Tap a cell: ', 'Chạm ô: ')}7 → 8 → O → AL → PH → SN</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-[-1px]" style={{ border: '2px solid #C9A84C' }} /> {tr('employee wish', 'nhân viên đăng ký')}</span>
        <span>7 = {SHIFT_HOURS['7']} · 8 = {SHIFT_HOURS['8']}</span>
      </div>

      <div className="rounded-2xl px-3.5 py-3 space-y-1"
        style={alerts.length ? { background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' } : { background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#047857' }}>
        <div className="text-[13px] font-bold">{alerts.length ? `⚠ ${alerts.length} ${tr('rule(s) broken this month', 'vi phạm trong tháng')}` : tr('✓ No rule broken', '✓ Không vi phạm quy định')}</div>
        {alerts.map((a, i) => <div key={i} className="text-xs leading-snug">• {lang === 'vi' ? a.vi : a.en}</div>)}
      </div>

      <button onClick={togglePublish} disabled={publishing} className="w-full min-h-[50px] rounded-2xl font-bold text-sm disabled:opacity-50"
        style={published ? { background: '#fff', color: '#1A4731', border: '1px solid #1A4731' } : { background: '#1A4731', color: '#fff' }}>
        {published ? tr('Published ✓ · back to draft', 'Đã công bố ✓ · chuyển về bản nháp') : `${tr('Publish', 'Công bố')} ${monthLabel(month, lang)}`}
      </button>
    </div>
  );
}

// ───────────────────────── Overtime ─────────────────────────
function OvertimeView({ data, team, lang, tr, reload, today }: { data: TeamHrData; team: string; lang: string; tr: TR; reload: () => void; today: string }) {
  const [day, setDay] = useState(today);
  const [from, setFrom] = useState('16:00');
  const [to, setTo] = useState('18:00');
  const [reason, setReason] = useState('');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const h = hoursBetween(from, to);
  const ids = Object.keys(sel).filter((k) => sel[k]);
  const send = async () => {
    if (!ids.length || h <= 0) return;
    setSending(true);
    const r = await createOtAction(team, { day, time_from: from, time_to: to, reason, employeeIds: ids });
    setSending(false);
    if (r.error) { alertSoft(r.error); return; }
    setSel({}); setReason('');
    reload();
  };
  const cancel = async (id: string) => { const r = await cancelOtAction(team, id); if (r.error) alertSoft(r.error); reload(); };
  const label = 'text-[11px] font-bold uppercase';
  const input = 'w-full min-h-[42px] rounded-xl px-2.5 text-sm bg-white';
  return (
    <div className="space-y-2.5">
      <div className="bg-white rounded-2xl p-3.5 space-y-2.5" style={{ border: BORDER }}>
        <div className="text-sm font-bold">{tr('New overtime request', 'Đề nghị tăng ca mới')}</div>
        <div className="grid grid-cols-3 gap-2">
          <label className="space-y-1"><span className={label} style={{ color: '#6B7280' }}>{tr('Day', 'Ngày')}</span><input type="date" value={day} onChange={(e) => setDay(e.target.value)} className={input} style={{ border: BORDER }} /></label>
          <label className="space-y-1"><span className={label} style={{ color: '#6B7280' }}>{tr('From', 'Từ')}</span><input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={input} style={{ border: BORDER }} /></label>
          <label className="space-y-1"><span className={label} style={{ color: '#6B7280' }}>{tr('To', 'Đến')}</span><input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={input} style={{ border: BORDER }} /></label>
        </div>
        <label className="block space-y-1"><span className={label} style={{ color: '#6B7280' }}>{tr('Reason', 'Lý do')}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. Maison Mooncake order', 'VD: Đơn Maison Mooncake')} className={input} style={{ border: BORDER }} /></label>
        <div className={label} style={{ color: '#6B7280' }}>{tr('Who', 'Ai')}</div>
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #F0E6B8' }}>
          {data.employees.filter((e) => !e.is_casual).map((e) => {
            const on = !!sel[e.id];
            const base = data.otHours[e.id] ?? 0;
            const after = base + (on ? h : 0);
            const over = after > HR_RULES.otMonthCap;
            return (
              <button key={e.id} onClick={() => setSel({ ...sel, [e.id]: !on })} className="w-full flex items-center gap-2.5 px-2.5 py-2 min-h-[50px] text-left"
                style={{ background: on ? '#FFFAEE' : '#fff', borderBottom: '1px solid #F0E6B8' }}>
                <span className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[13px] font-black shrink-0"
                  style={on ? { background: '#1A4731', color: '#fff' } : { border: '1px solid #C9A84C' }}>{on ? '✓' : ''}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-semibold">{e.full_name}</span>
                  <span className="block text-[11px]" style={{ color: over ? '#DC2626' : '#6B7280', fontWeight: over ? 700 : 400 }}>
                    {tr('OT this month ', 'Tăng ca tháng này ')}{base} h{on ? ` → ${after} h` : ''}{over ? tr(` · over ${HR_RULES.otMonthCap} h`, ` · vượt ${HR_RULES.otMonthCap} giờ`) : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="rounded-xl px-2.5 py-2 text-xs font-semibold" style={{ background: '#FFFAEE', color: '#1A4731' }}>
          {ids.length && h > 0
            ? tr(`${ids.length} people × ${h} h = ${ids.length * h} h overtime · each confirms on his phone`, `${ids.length} người × ${h} giờ = ${ids.length * h} giờ tăng ca · từng người xác nhận trên điện thoại`)
            : tr('Pick the time and the people working overtime', 'Chọn giờ và người tăng ca')}
        </div>
        <button onClick={send} disabled={!ids.length || h <= 0 || sending} className="w-full min-h-[48px] rounded-2xl font-bold text-sm disabled:bg-gray-200 disabled:text-gray-500"
          style={ids.length && h > 0 ? { background: '#1A4731', color: '#fff' } : {}}>{tr('Send to Mr Giang', 'Gửi anh Giang duyệt')}</button>
      </div>

      <div className="text-xs font-bold px-1" style={{ color: '#1A4731' }}>{tr('This month', 'Tháng này')} · {monthLabel(data.month, lang)}</div>
      {data.ots.length === 0 && <div className="bg-white rounded-2xl p-4 text-center text-xs" style={{ border: BORDER, color: '#6B7280' }}>{tr('No overtime request yet', 'Chưa có đề nghị tăng ca')}</div>}
      {data.ots.map((o) => {
        const yes = o.lines.filter((l) => l.confirm === 'yes').length;
        const no = o.lines.filter((l) => l.confirm === 'no').length;
        const st = o.status === 'approved' ? [tr('✓ Mr Giang approved', '✓ Anh Giang đã duyệt'), '#047857']
          : o.status === 'rejected' ? [tr('✕ Rejected by Mr Giang', '✕ Anh Giang từ chối'), '#DC2626']
          : o.status === 'cancelled' ? [tr('Cancelled', 'Đã hủy'), '#6B7280'] : [tr('⏳ Waiting Mr Giang', '⏳ Chờ anh Giang'), '#b45309'];
        return (
          <div key={o.id} className="bg-white rounded-2xl px-3.5 py-3 space-y-1" style={{ border: BORDER }}>
            <div className="text-[13px] font-bold">{shortDay(o.day, lang)} · {o.time_from}–{o.time_to} ({o.hours} h){o.reason ? ` · ${o.reason}` : ''}</div>
            <div className="text-xs" style={{ color: '#6B7280' }}>{o.lines.map((l) => nameOf(data, l.employee_id)).join(', ')}</div>
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold" style={{ color: st[1] }}>{st[0]} · {yes}/{o.lines.length} {tr('confirmed', 'đã xác nhận')}{no ? ` · ${no} ${tr('declined', 'từ chối')}` : ''}</span>
              {o.status === 'pending_giang' && <button onClick={() => cancel(o.id)} className="text-xs underline min-h-[32px]" style={{ color: '#6B7280' }}>{tr('Cancel', 'Hủy')}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────── Team ─────────────────────────
function TeamView({ data, lang, tr }: { data: TeamHrData; lang: string; tr: TR }) {
  const [copied, setCopied] = useState<string | null>(null);
  const wishes = new Set(data.wishes);
  const n = daysInMonth(data.month);
  const copy = async (e: HrEmployee) => {
    const url = `${window.location.origin}/hr/${e.access_token}`;
    try { await navigator.clipboard.writeText(url); setCopied(e.id); setTimeout(() => setCopied(null), 2000); } catch { window.prompt('Link', url); }
  };
  return (
    <div className="space-y-2">
      <div className="rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed" style={{ background: '#FFFAEE', border: BORDER, color: '#1A4731' }}>
        {tr('Each employee has a personal link (no password): copy it and send it on Zalo. Time clock hours will appear here once HR imports them.',
          'Mỗi nhân viên có một link riêng (không cần mật khẩu): sao chép và gửi qua Zalo. Giờ chấm công sẽ hiện ở đây khi Nhân sự nhập dữ liệu.')}
      </div>
      {data.employees.map((e) => {
        let off = 0;
        for (let d = 1; d <= n; d++) if (scheduleCode(e, dayStr(data.month, d), data.stored, wishes) === 'O') off++;
        const nextSent = data.nextSubmitted.includes(e.id);
        return (
          <div key={e.id} className="bg-white rounded-2xl px-3 py-2.5 flex items-center gap-2.5" style={{ border: BORDER }}>
            <span className="w-[34px] h-[34px] rounded-xl flex items-center justify-center text-[11px] font-black shrink-0" style={{ background: '#eff6ff', color: '#0369a1' }}>
              {e.full_name.split(' ').slice(-2).map((w) => w[0]).join('')}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-bold truncate">{e.full_name}</div>
              <div className="text-[11px]" style={{ color: '#6B7280' }}>
                {e.position ?? ''}{e.is_casual ? '' : ` · ${tr('shift', 'ca')} ${e.base_shift}`} · {monthLabel(data.month, lang)}: {tr('off', 'nghỉ')} {off} · OT {data.otHours[e.id] ?? 0} h
              </div>
              {!e.is_casual && (
                <div className="text-[11px] font-semibold" style={{ color: nextSent ? '#047857' : '#b45309' }}>
                  {nextSent ? tr('✓ Days off sent for ', '✓ Đã gửi ngày nghỉ ') : tr('Days off not sent yet for ', 'Chưa gửi ngày nghỉ ')}{monthLabel(data.nextMonth, lang)}
                </div>
              )}
            </div>
            <button onClick={() => copy(e)} title={tr('Copy personal link', 'Sao chép link')} className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ border: BORDER, background: copied === e.id ? '#ECFDF5' : '#FFFAEE', color: '#1A4731' }}>
              {copied === e.id ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function alertSoft(msg: string) {
  if (typeof window !== 'undefined') window.alert(msg);
}
