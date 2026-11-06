'use client';
// HR pilot — station "Nhân sự" tab for the team leader (Axel, 2026-11-06, Team Hưng first).
// Round 2 after Hưng's review: the month as one continuous strip (scroll right), published week by week, team
// holidays, leave approved → written into the schedule, proof papers, staff without the app managed
// here, group overtime. The leader's own space ("Của tôi") is a sub-tab so the station keeps one tab.
import { useCallback, useEffect, useState } from 'react';
import {
  HR_CODE_LABEL, HR_OFF_CODES, HR_OT_CAP, HR_PICK, HR_PROOF_TYPES, addDays, dm, dow, hanoiToday, hoursBetween, hrRequestCode,
  hrTypeLabel, monthLabel, monthStart, addMonths, offLimit, scheduleCode, shortDay, weekStart, wishDeadline, type HrEmployee,
} from '@/lib/hr';
import MonthGrid, { BORDER, Legend, MonthHeader, codeStyle, codeText } from '@/components/hr/WeekGrid';
import EmployeeHrView from '@/app/hr/[token]/EmployeeHrView';
import {
  loadTeamHrAction, setScheduleCodeAction, setHolidayAction, setWeekStatusAction, decideRequestAction, noProofAction,
  addEmployeeAction, removeEmployeeAction, createOtAction, cancelOtAction, type TeamHrData,
} from './hr-actions';

type Sub = 'schedule' | 'requests' | 'overtime' | 'team' | 'me';
type TR = (en: string, vi: string) => string;

function defaultWeek(): string {
  const t = hanoiToday();
  const d = dow(t);
  // From Friday on, the leader is planning next week.
  return d === 5 || d === 6 || d === 0 ? addDays(weekStart(t), 7) : weekStart(t);
}

export default function HrTeamTab({ team, lang, myToken }: { team: string; lang: 'vi' | 'en'; myToken?: string | null }) {
  const tr: TR = (en, vi) => (lang === 'vi' ? vi : en);
  const [sub, setSub] = useState<Sub>('schedule');
  const [focus] = useState(defaultWeek);
  const [month, setMonth] = useState(() => monthStart(addDays(defaultWeek(), 3)));
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
  // Keep in sync with the employees' requests: refresh every 30 s while visible, and on focus.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  if (err === 'HR_NOT_INSTALLED') {
    return <div className="bg-white rounded-2xl p-6 text-sm" style={{ border: BORDER }}>{tr('The HR module is not installed yet.', 'Module nhân sự chưa được cài.')}</div>;
  }

  const pending = (data?.requests ?? []).filter((r) => r.status === 'pending_leader').length;
  const tabs: [Sub, string, number][] = [
    ['schedule', tr('Schedule', 'Lịch'), 0],
    ['requests', tr('Requests', 'Yêu cầu'), pending],
    ['overtime', tr('Overtime', 'Tăng ca'), 0],
    ['team', tr('Team', 'Nhóm'), 0],
    ...(myToken ? [['me', tr('Me', 'Của tôi'), 0] as [Sub, string, number]] : []),
  ];

  return (
    <div className="space-y-2.5">
      <div className="flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
        {tabs.map(([id, label, count]) => (
          <button key={id} onClick={() => setSub(id)}
            className="min-h-[40px] px-3 rounded-xl text-[12px] font-bold flex items-center justify-center gap-1 whitespace-nowrap flex-1 active:scale-95"
            style={sub === id ? { background: '#1A4731', color: '#FFF4CC', border: '1px solid #1A4731' } : { background: '#fff', color: '#1A4731', border: BORDER }}>
            {label}
            {count > 0 && <span className="min-w-[16px] h-4 rounded-full text-[9px] font-black inline-flex items-center justify-center px-1"
              style={sub === id ? { background: '#C9A84C', color: '#1A4731' } : { background: '#DC2626', color: '#fff' }}>{count}</span>}
          </button>
        ))}
      </div>
      {err && <div className="rounded-xl px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>{err}</div>}
      {sub === 'me' && myToken ? (
        <EmployeeHrView token={myToken} embedded stationLang={lang} />
      ) : !data ? (
        <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: BORDER, color: '#6B7280' }}>{tr('Loading…', 'Đang tải…')}</div>
      ) : (
        <>
          {sub === 'schedule' && <ScheduleView data={data} team={team} lang={lang} tr={tr} month={month} setMonth={setMonth} focus={focus} reload={load} busy={busy} setData={setData} />}
          {sub === 'requests' && <RequestsView data={data} team={team} lang={lang} tr={tr} reload={load} />}
          {sub === 'overtime' && <OvertimeView data={data} team={team} lang={lang} tr={tr} reload={load} />}
          {sub === 'team' && <TeamView data={data} team={team} lang={lang} tr={tr} reload={load} />}
        </>
      )}
    </div>
  );
}

const nameOf = (data: TeamHrData, id: string | null) => data.week.employees.find((e) => e.id === id)?.full_name ?? '—';

// ───────────────────────── Schedule (whole month, scroll right) ─────────────────────────
function ScheduleView({ data, team, lang, tr, month, setMonth, focus, reload, busy, setData }: {
  data: TeamHrData; team: string; lang: string; tr: TR; month: string; setMonth: (m: string) => void; focus: string; reload: () => void; busy: boolean;
  setData: (d: TeamHrData) => void;
}) {
  const week = data.week;
  const [pick, setPick] = useState<{ e: HrEmployee; day: string } | null>(null);
  const wishes = new Set(week.wishes);
  const codeOf = (e: HrEmployee, d: string) => scheduleCode(e, d, week.stored, wishes);
  const regular = week.employees.filter((e) => !e.is_casual);
  const inMonth = (d: string) => d.slice(0, 7) === week.month.slice(0, 7);

  const alerts: string[] = [];
  for (const d of week.days.filter(inMonth)) {
    const n = regular.filter((e) => HR_OFF_CODES.includes(codeOf(e, d))).length;
    if (n > offLimit(week.rules, d)) alerts.push(tr(`${shortDay(d, 'en')}: ${n} people off, max ${offLimit(week.rules, d)}`, `${shortDay(d, 'vi')}: ${n} người nghỉ, tối đa ${offLimit(week.rules, d)}`));
  }
  for (const e of regular) {
    const u = week.monthOff[e.id] ?? 0;
    if (u > week.allowance) alerts.push(tr(`${e.full_name}: ${u} days off in ${monthLabel(week.month, 'en')}, allowed ${week.allowance}`, `${e.full_name}: ${u} ngày nghỉ ${monthLabel(week.month, 'vi')}, được ${week.allowance}`));
  }

  const setCode = async (code: string) => {
    if (!pick) return;
    const k = pick.e.id + '|' + pick.day;
    const stored = { ...week.stored };
    if (code) stored[k] = code; else delete stored[k];
    setData({ ...data, week: { ...week, stored } }); // optimistic
    setPick(null);
    const r = await setScheduleCodeAction(team, pick.e.id, pick.day, code);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const holiday = async (d: string) => {
    const isPh = week.employees.length > 0 && week.employees.every((e) => week.stored[e.id + '|' + d] === 'PH');
    if (!window.confirm(isPh ? tr(`Remove the holiday on ${shortDay(d, 'en')}?`, `Bỏ ngày lễ ${shortDay(d, 'vi')}?`) : tr(`${shortDay(d, 'en')}: holiday (PH) for the whole team?`, `${shortDay(d, 'vi')}: ngày lễ (PH) cho cả nhóm?`))) return;
    const r = await setHolidayAction(team, d, !isPh);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const publish = async (start: string, published: boolean) => {
    const end = addDays(start, 6);
    const q = published
      ? tr(`Week ${dm(start)} – ${dm(end)}: back to draft? The team will no longer see the shifts.`, `Tuần ${dm(start)} – ${dm(end)}: chuyển về bản nháp? Nhóm sẽ không thấy ca làm nữa.`)
      : tr(`Publish week ${dm(start)} – ${dm(end)}? The team is notified and day-off requests for it close.`, `Công bố tuần ${dm(start)} – ${dm(end)}? Nhóm sẽ nhận thông báo và không thể xin nghỉ tuần này nữa.`);
    if (!window.confirm(q)) return;
    setData({ ...data, week: { ...week, weeks: week.weeks.map((w) => (w.start === start ? { ...w, published: !published } : w)) } });
    const r = await setWeekStatusAction(team, start, published ? 'draft' : 'published');
    if (r.error) alertSoft(r.error);
    reload();
  };
  const nextDeadline = wishDeadline(addDays(weekStart(hanoiToday()), 7));

  return (
    <div className="space-y-2">
      <MonthHeader month={week.month} lang={lang} busy={busy} onPrev={() => setMonth(addMonths(month, -1))} onNext={() => setMonth(addMonths(month, 1))}
        sub={tr(`${week.allowance} days off / person (Sundays) · next week's requests close ${shortDay(nextDeadline, 'en')}`, `${week.allowance} ngày nghỉ / người (= số CN) · hạn xin nghỉ tuần sau: ${shortDay(nextDeadline, 'vi')}`)} />
      <div className="text-[10px] text-center" style={{ color: '#8B5E34' }}>⟵ {tr('scroll sideways through the month', 'kéo ngang để xem cả tháng')} ⟶</div>
      <MonthGrid data={week} lang={lang} focusDay={focus} onCell={(e, day) => setPick({ e, day })} onDay={holiday} onWeek={publish} />
      <Legend lang={lang} />
      <div className="text-[10px] px-1 leading-relaxed" style={{ color: '#6B7280' }}>
        {tr('Publish each week with the button above it · tap a cell to change it · tap a day to set a team holiday.', 'Công bố từng tuần bằng nút phía trên tuần đó · chạm ô để đổi · chạm ngày để đặt ngày lễ cho cả nhóm.')}
      </div>
      {alerts.length > 0 && (
        <div className="rounded-2xl px-3.5 py-2.5 space-y-0.5" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          {alerts.map((a, i) => <div key={i} className="text-xs leading-snug">⚠ {a}</div>)}
        </div>
      )}

      {pick && (
        <Sheet onClose={() => setPick(null)}>
          <div className="text-sm font-bold" style={{ color: '#1A4731' }}>{pick.e.full_name}</div>
          <div className="text-xs mb-2" style={{ color: '#6B7280' }}>
            {shortDay(pick.day, lang)}
            {wishes.has(pick.e.id + '|' + pick.day) ? tr(' · requested this day off', ' · đã xin nghỉ ngày này') : ''}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {HR_PICK.map((c) => {
              const cur = codeOf(pick.e, pick.day) === c;
              return (
                <button key={c} onClick={() => setCode(c)} className="min-h-[54px] rounded-xl flex flex-col items-center justify-center gap-0.5 active:scale-95"
                  style={{ border: cur ? '2px solid #1A4731' : BORDER, background: '#fff' }}>
                  <span className="min-w-[30px] px-1 h-[22px] rounded-md text-[11px] flex items-center justify-center whitespace-nowrap" style={codeStyle(c)}>{codeText(c, lang)}</span>
                  <span className="text-[10px] leading-tight px-1 text-center" style={{ color: '#374151' }}>{lang === 'vi' ? HR_CODE_LABEL[c].vi : HR_CODE_LABEL[c].en}</span>
                </button>
              );
            })}
          </div>
          <button onClick={() => setCode('')} className="w-full min-h-[44px] rounded-xl text-[13px] font-bold mt-2" style={{ border: BORDER, color: '#6B7280', background: '#FFFAEE' }}>
            {tr('Back to default', 'Về mặc định')} ({wishes.has(pick.e.id + '|' + pick.day) ? 'O' : pick.e.base_shift})
          </button>
        </Sheet>
      )}
    </div>
  );
}

export function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.35)' }} onClick={onClose}>
      <div className="w-full max-w-xl rounded-t-3xl p-4 pb-8" style={{ background: '#FFF4CC' }} onClick={(e) => e.stopPropagation()}>
        <div className="w-10 h-1 rounded-full mx-auto mb-3" style={{ background: '#E0D49A' }} />
        {children}
      </div>
    </div>
  );
}

// ───────────────────────── Requests ─────────────────────────
function RequestsView({ data, team, lang, tr, reload }: { data: TeamHrData; team: string; lang: string; tr: TR; reload: () => void }) {
  const [filter, setFilter] = useState<'pending' | 'proof' | 'done'>('pending');
  const [working, setWorking] = useState<string | null>(null);
  const needsProof = (r: TeamHrData['requests'][number]) => HR_PROOF_TYPES.includes(r.type) && !r.proof_path && !r.no_proof && (r.status === 'pending_giang' || r.status === 'approved');
  const list = data.requests.filter((r) => filter === 'pending' ? r.status === 'pending_leader'
    : filter === 'proof' ? needsProof(r) : r.status !== 'pending_leader' && r.status !== 'cancelled');
  const act = async (id: string, d: 'ok' | 'reject' | 'undo') => {
    setWorking(id);
    const r = await decideRequestAction(team, id, d);
    setWorking(null);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const noProof = async (id: string) => {
    if (!window.confirm(tr('No proof: count these days as days off?', 'Không có giấy: tính những ngày này là ngày nghỉ?'))) return;
    setWorking(id);
    const r = await noProofAction(team, id);
    setWorking(null);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const statusLabel = (s: string) => ({
    pending_giang: [tr('✓ OK · waiting Mr Giang', '✓ Đồng ý · chờ anh Giang'), '#b45309'],
    approved: [tr('✓ Approved', '✓ Đã duyệt'), '#047857'],
    rejected: [tr('✕ Rejected', '✕ Từ chối'), '#DC2626'],
  } as Record<string, string[]>)[s] ?? [s, '#6B7280'];
  const n = { pending: data.requests.filter((r) => r.status === 'pending_leader').length, proof: data.requests.filter(needsProof).length };
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        {([['pending', `${tr('To review', 'Cần xử lý')} (${n.pending})`], ['proof', `${tr('Proof missing', 'Chờ giấy')} (${n.proof})`], ['done', tr('Done', 'Đã xử lý')]] as const).map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)} className="flex-1 min-h-[38px] rounded-xl text-[11px] font-bold"
            style={filter === f ? { background: '#1A4731', color: '#fff', border: '1px solid #1A4731' } : { background: '#fff', color: '#1A2C24', border: BORDER }}>{label}</button>
        ))}
      </div>
      {list.length === 0 && (
        <div className="bg-white rounded-2xl p-6 text-center text-sm font-semibold" style={{ border: BORDER, color: '#047857' }}>
          {filter === 'done' ? tr('Nothing yet', 'Chưa có') : tr('All clear ✓', 'Không còn gì ✓')}
        </div>
      )}
      {list.map((r) => {
        const [sl, sc] = statusLabel(r.status);
        const when = r.day_to && r.day_to !== r.day_from ? `${shortDay(r.day_from, lang)} → ${shortDay(r.day_to, lang)}` : shortDay(r.day_from, lang);
        const time = r.time_from || r.time_to ? ` · ${r.time_from ?? ''}–${r.time_to ?? ''}` : '';
        const code = hrRequestCode(r.type);
        return (
          <div key={r.id} className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: BORDER }}>
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0">
                <div className="text-sm font-bold">{nameOf(data, r.employee_id)}</div>
                <div className="text-xs" style={{ color: '#6B7280' }}>{when}{time}</div>
              </div>
              <span className="text-[11px] font-bold rounded-full px-2 py-1 whitespace-nowrap" style={{ color: '#8B5E34', background: '#FFFAEE', border: BORDER }}>{hrTypeLabel(r.type, lang)}</span>
            </div>
            {r.type === 'swap' && r.swap_with && (
              <div className="text-xs rounded-lg px-2.5 py-2" style={{ background: '#FFFAEE' }}>{tr('Swap with ', 'Đổi với ')}<b>{nameOf(data, r.swap_with)}</b>{tr(' · adjust the schedule after approval', ' · sửa lịch sau khi duyệt')}</div>
            )}
            {r.reason && <div className="text-xs" style={{ color: '#6B7280' }}>“{r.reason}”</div>}
            {HR_PROOF_TYPES.includes(r.type) && (
              <div className="text-xs flex items-center gap-2">
                {r.proof_url ? (
                  <a href={r.proof_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 font-semibold" style={{ color: '#047857' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.proof_url} alt="" className="w-12 h-12 rounded-lg object-cover" style={{ border: BORDER }} />
                    {tr('Proof ✓ — open', 'Giấy tờ ✓ — xem')}
                  </a>
                ) : r.no_proof ? (
                  <span className="font-semibold" style={{ color: '#8B5E34' }}>{tr('No proof → counted as day off', 'Không giấy → tính ngày nghỉ')}</span>
                ) : (
                  <span className="font-semibold" style={{ color: '#b45309' }}>{tr('⏳ Proof paper not added yet', '⏳ Chưa gửi giấy tờ')}</span>
                )}
              </div>
            )}
            {r.status === 'pending_leader' ? (
              <>
                {code && <div className="text-[11px]" style={{ color: '#6B7280' }}>{tr(`On OK the schedule shows ${code} on these days.`, `Khi đồng ý, lịch sẽ ghi ${code} cho những ngày này.`)}</div>}
                <div className="grid grid-cols-[1fr_1.5fr] gap-2">
                  <button disabled={working === r.id} onClick={() => act(r.id, 'reject')} className="min-h-[44px] rounded-xl text-[13px] font-bold bg-white disabled:opacity-50" style={{ border: BORDER }}>{tr('Reject', 'Từ chối')}</button>
                  <button disabled={working === r.id} onClick={() => act(r.id, 'ok')} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-50" style={{ background: '#1A4731' }}>
                    {r.type === 'swap' ? tr('Approve swap', 'Duyệt đổi ca') : tr('OK → Mr Giang', 'Đồng ý → anh Giang')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex justify-between items-center gap-2">
                <span className="text-xs font-bold" style={{ color: sc }}>{sl}</span>
                <div className="flex gap-3">
                  {needsProof(r) && <button disabled={working === r.id} onClick={() => noProof(r.id)} className="text-xs font-bold underline min-h-[32px]" style={{ color: '#8B5E34' }}>{tr('No proof → day off', 'Không giấy → ngày nghỉ')}</button>}
                  {(r.status === 'pending_giang' || r.status === 'rejected' || (r.status === 'approved' && r.type === 'swap')) && (
                    <button onClick={() => act(r.id, 'undo')} className="text-xs underline min-h-[32px]" style={{ color: '#6B7280' }}>{tr('Undo', 'Hoàn tác')}</button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-[11px] px-1 leading-relaxed" style={{ color: '#6B7280' }}>
        {tr('Days off are accepted automatically while the day has room — they appear directly in the schedule. Leave, missed punch and late requests go on to Mr Giang after your OK.',
          'Ngày nghỉ được nhận tự động khi còn chỗ — hiện thẳng trên lịch. Nghỉ phép, ốm, quên chấm công, đi muộn: sau khi bạn đồng ý sẽ chuyển anh Giang duyệt.')}
      </p>
    </div>
  );
}

// ───────────────────────── Overtime ─────────────────────────
function OvertimeView({ data, team, lang, tr, reload }: { data: TeamHrData; team: string; lang: string; tr: TR; reload: () => void }) {
  const [day, setDay] = useState(hanoiToday());
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
          {data.week.employees.filter((e) => !e.is_casual).map((e) => {
            const on = !!sel[e.id];
            const base = data.otHours[e.id] ?? 0;
            const after = base + (on ? h : 0);
            const over = after > HR_OT_CAP;
            return (
              <button key={e.id} onClick={() => setSel({ ...sel, [e.id]: !on })} className="w-full flex items-center gap-2.5 px-2.5 py-2 min-h-[50px] text-left"
                style={{ background: on ? '#FFFAEE' : '#fff', borderBottom: '1px solid #F0E6B8' }}>
                <span className="w-[22px] h-[22px] rounded-md flex items-center justify-center text-[13px] font-black shrink-0"
                  style={on ? { background: '#1A4731', color: '#fff' } : { border: '1px solid #C9A84C' }}>{on ? '✓' : ''}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-semibold">{e.full_name}</span>
                  <span className="block text-[11px]" style={{ color: over ? '#DC2626' : '#6B7280', fontWeight: over ? 700 : 400 }}>
                    {tr('OT this month ', 'Tăng ca tháng này ')}{base} h{on ? ` → ${after} h` : ''}{over ? tr(` · over ${HR_OT_CAP} h`, ` · vượt ${HR_OT_CAP} giờ`) : ''}
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

      <div className="text-xs font-bold px-1" style={{ color: '#1A4731' }}>{monthLabel(data.week.month, lang)}</div>
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
function TeamView({ data, team, lang, tr, reload }: { data: TeamHrData; team: string; lang: string; tr: TR; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [position, setPosition] = useState('Thời vụ');
  const [shift, setShift] = useState('8');
  const [casual, setCasual] = useState(true);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const r = await addEmployeeAction(team, { full_name: name, position, base_shift: shift, is_casual: casual });
    setBusy(false);
    if (r.error) { alertSoft(r.error); return; }
    setOpen(false); setName(''); reload();
  };
  const remove = async (e: HrEmployee) => {
    if (!window.confirm(tr(`Remove ${e.full_name} from the team?`, `Xóa ${e.full_name} khỏi nhóm?`))) return;
    const r = await removeEmployeeAction(team, e.id);
    if (r.error) alertSoft(r.error);
    reload();
  };
  const input = 'w-full min-h-[42px] rounded-xl px-2.5 text-sm bg-white';
  return (
    <div className="space-y-2">
      {data.week.employees.map((e) => (
        <div key={e.id} className="bg-white rounded-2xl px-3 py-2.5 flex items-center gap-2.5" style={{ border: BORDER }}>
          <span className="w-[34px] h-[34px] rounded-xl flex items-center justify-center text-[11px] font-black shrink-0" style={{ background: '#FFFAEE', color: '#8B5E34', border: BORDER }}>
            {e.full_name.split(' ').slice(-2).map((w) => w[0]).join('')}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-bold truncate">{e.full_name}</div>
            <div className="text-[11px]" style={{ color: '#6B7280' }}>
              {e.position ?? ''} · {tr('shift', 'ca')} {e.base_shift} · {monthLabel(data.week.month, lang)}: {tr('off', 'nghỉ')} {data.week.monthOff[e.id] ?? 0}/{data.week.allowance} · OT {data.otHours[e.id] ?? 0} h
            </div>
            <div className="text-[11px] font-semibold" style={{ color: e.profile_id ? '#047857' : '#8B5E34' }}>
              {e.profile_id ? tr('✓ Uses the app', '✓ Có app') : tr('No app — you fill the schedule', 'Không app — trưởng nhóm nhập lịch')}
            </div>
          </div>
          {!e.is_leader && !e.profile_id && (
            <button onClick={() => remove(e)} className="text-xs underline min-h-[32px] shrink-0" style={{ color: '#6B7280' }}>{tr('Remove', 'Xóa')}</button>
          )}
        </div>
      ))}
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full min-h-[48px] rounded-2xl font-bold text-sm bg-white" style={{ border: '1px dashed #1A4731', color: '#1A4731' }}>
          + {tr('Add a part-time / seasonal employee', 'Thêm nhân viên bán thời gian / thời vụ')}
        </button>
      ) : (
        <div className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: BORDER }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Full name', 'Họ tên')} className={input} style={{ border: BORDER }} />
          <div className="grid grid-cols-2 gap-2">
            <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder={tr('Position', 'Vị trí')} className={input} style={{ border: BORDER }} />
            <select value={shift} onChange={(e) => setShift(e.target.value)} className={input} style={{ border: BORDER }}>
              <option value="7">{tr('Shift 7 (07–16h)', 'Ca 7 (07–16h)')}</option>
              <option value="8">{tr('Shift 8 (08–17h)', 'Ca 8 (08–17h)')}</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs min-h-[36px]">
            <input type="checkbox" checked={casual} onChange={(e) => setCasual(e.target.checked)} />
            {tr('Seasonal / paid by the hour (outside the day-off rules)', 'Thời vụ / tính theo giờ (ngoài quy định ngày nghỉ)')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setOpen(false)} className="min-h-[44px] rounded-xl text-[13px] font-bold bg-white" style={{ border: BORDER }}>{tr('Cancel', 'Hủy')}</button>
            <button onClick={add} disabled={busy || name.trim().length < 2} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-50" style={{ background: '#1A4731' }}>{tr('Add', 'Thêm')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function alertSoft(msg: string) {
  if (typeof window !== 'undefined') window.alert(msg);
}
