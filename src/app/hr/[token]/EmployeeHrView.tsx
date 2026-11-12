'use client';
// HR pilot — employee space (Axel, 2026-11-06). Shown in the station ("Của tôi" tab, embedded) or on the
// personal link /hr/<token>. VI by default, EN toggle on the link.
// Round 2 (Hưng's review): the team's week (read only, swipe between weeks), day off requested by
// tapping one's own cell — accepted at once while the day has room, cancel possible until the
// Saturday before the week —, requests with proof papers added later, overtime confirmation.
import { useCallback, useEffect, useState } from 'react';
import {
  HR_PROOF_TYPES, HR_REQUEST_TYPES, addDays, hanoiToday, hrNeedsGiang, hrTypeLabel, monthLabel, offAllowance,
  monthStart, addMonths, fmtDays, halfHours, scheduleCode, shortDay, weekStart, wishDeadline,
} from '@/lib/hr';
import MonthGrid, { BORDER, Legend, MonthHeader } from '@/components/hr/WeekGrid';
import {
  loadMeAction, submitRequestAction, cancelRequestAction, confirmOtAction, requestOffAction, cancelOffAction, uploadProofAction,
  type MeData,
} from './actions';

type Tab = 'schedule' | 'off' | 'requests' | 'month';
type TR = (en: string, vi: string) => string;

// embedded = shown inside the station ("Của tôi" tab): no page header, station language.
export default function EmployeeHrView({ token, embedded = false, stationLang }: { token: string; embedded?: boolean; stationLang?: 'vi' | 'en' }) {
  const [ownLang, setLangState] = useState<'vi' | 'en'>('vi');
  useEffect(() => { if (embedded) return; try { const l = localStorage.getItem('hr-lang'); if (l === 'en' || l === 'vi') setLangState(l); } catch {} }, [embedded]);
  const setLang = (l: 'vi' | 'en') => { setLangState(l); try { localStorage.setItem('hr-lang', l); } catch {} };
  const lang = embedded && stationLang ? stationLang : ownLang;
  const tr: TR = (en, vi) => (lang === 'vi' ? vi : en);
  const [tab, setTab] = useState<Tab>('schedule');
  const [month, setMonth] = useState(() => monthStart(hanoiToday()));
  const [data, setData] = useState<MeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const r = await loadMeAction(token, month);
    setBusy(false);
    if (r.error) setErr(r.error); else { setErr(null); setData(r.data!); }
  }, [token, month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  if (err === 'INVALID') {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-6" style={{ background: embedded ? undefined : '#F6F1EA' }}>
        <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" style={{ border: BORDER }}>
          <div className="text-3xl mb-2">🔒</div>
          <h1 className="font-bold text-lg" style={{ color: '#2A1810' }}>Liên kết không hợp lệ</h1>
          <p className="text-sm mt-1" style={{ color: '#6B7280' }}>Vui lòng liên hệ trưởng nhóm.</p>
          <p className="text-xs mt-3" style={{ color: '#9CA3AF' }}>Invalid link — ask your team leader.</p>
        </div>
      </div>
    );
  }

  const pendingOt = (data?.ots ?? []).filter((o) => o.confirm == null && o.status !== 'rejected' && o.day >= hanoiToday());
  const missingProof = (data?.requests ?? []).filter((r) => HR_PROOF_TYPES.includes(r.type) && !r.proof_path && !r.no_proof && r.status !== 'rejected' && r.status !== 'cancelled').length;
  const tabBtn = (id: Tab, label: string, dot = false) => (
    <button key={id} onClick={() => setTab(id)} className="flex-1 min-h-[42px] text-[12px] font-bold flex items-center justify-center gap-1"
      style={tab === id ? { color: '#C9A84C', borderBottom: '2px solid #C9A84C' } : { color: 'rgba(255,255,255,0.65)', borderBottom: '2px solid transparent' }}>
      {label}{dot && <span className="w-[7px] h-[7px] rounded-full" style={{ background: '#EF4444' }} />}
    </button>
  );
  const e = data?.employee;

  return (
    <div className={embedded ? '' : 'min-h-screen'} style={embedded ? undefined : { background: '#F6F1EA' }}>
      <header className={embedded ? 'rounded-2xl overflow-hidden' : 'sticky top-0 z-20'} style={{ background: '#2A1810', boxShadow: '0 2px 8px rgba(0,0,0,0.15)' }}>
        <div className="max-w-xl mx-auto px-3 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-[34px] h-[34px] rounded-xl flex items-center justify-center text-xs font-black text-white shrink-0" style={{ background: 'rgba(246,241,234,0.2)' }}>
              {e ? e.full_name.split(' ').slice(-2).map((w) => w[0]).join('') : '…'}
            </span>
            <div className="min-w-0">
              <div className="text-white font-bold text-sm truncate">{e?.full_name ?? 'La Paris'}</div>
              <div className="text-[11px] truncate" style={{ color: '#C9A84C' }}>{e ? `Team ${e.team === 'hung' ? 'Hưng' : e.team} · ${e.position ?? ''}` : ''}</div>
            </div>
          </div>
          {!embedded && <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.15)' }}>
            {(['vi', 'en'] as const).map((l) => (
              <button key={l} onClick={() => setLang(l)} className="px-2 min-h-[28px] rounded text-[11px] font-bold"
                style={lang === l ? { background: '#F6F1EA', color: '#2A1810' } : { color: 'rgba(255,255,255,0.7)' }}>{l.toUpperCase()}</button>
            ))}
          </div>}
        </div>
        <div className="max-w-xl mx-auto flex" style={{ background: '#1F120C' }}>
          {tabBtn('schedule', tr('Team week', 'Lịch nhóm'))}
          {tabBtn('off', tr('Days off', 'Xin nghỉ'))}
          {tabBtn('requests', tr('Requests', 'Yêu cầu'), missingProof > 0)}
          {tabBtn('month', tr('My month', 'Tháng này'))}
        </div>
      </header>

      <main className={embedded ? 'pt-2.5 space-y-2.5' : 'max-w-xl mx-auto px-3 py-3 space-y-2.5'}>
        {err && <div className="rounded-xl px-3 py-2 text-xs" style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>{err}</div>}
        {!data ? (
          <div className="bg-white rounded-2xl p-6 text-center text-sm" style={{ border: BORDER, color: '#6B7280' }}>{tr('Loading…', 'Đang tải…')}</div>
        ) : (
          <>
            {pendingOt.map((o) => <OtAsk key={o.id} o={o} token={token} lang={lang} tr={tr} reload={load} />)}
            {tab === 'schedule' && <ScheduleTab data={data} token={token} lang={lang} tr={tr} month={month} setMonth={setMonth} reload={load} busy={busy} />}
            {tab === 'off' && <OffTab data={data} token={token} lang={lang} tr={tr} reload={load} />}
            {tab === 'requests' && <RequestsTab data={data} token={token} lang={lang} tr={tr} reload={load} />}
            {tab === 'month' && <MonthTab data={data} lang={lang} tr={tr} />}
          </>
        )}
      </main>
    </div>
  );
}

const offErr = (e: string, tr: TR) => ({
  CLOSED: tr('Closed: day-off requests for a week close on the Saturday before. Ask your leader.', 'Đã đóng: xin nghỉ cho tuần sau phải gửi trước hết Thứ 7. Liên hệ trưởng nhóm.'),
  FULL: tr('This day is full — the team already has the maximum people off.', 'Ngày này đã đủ người nghỉ — chọn ngày khác.'),
  MAX_DAYS: tr('You have used all your days off for this month.', 'Em đã dùng hết số ngày nghỉ của tháng này.'),
  MAX_SAT: tr('Max Saturdays off reached for this month.', 'Đã đủ số Thứ 7 được nghỉ trong tháng.'),
  MAX_SUN: tr('Max Sundays off reached for this month.', 'Đã đủ số Chủ nhật được nghỉ trong tháng.'),
  ALREADY: tr('This day is already off or on leave.', 'Ngày này đã nghỉ rồi.'),
} as Record<string, string>)[e] ?? e;

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
        <button disabled={busy} onClick={() => answer('yes')} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-50" style={{ background: '#2A1810' }}>{tr('Confirm', 'Xác nhận')}</button>
      </div>
    </div>
  );
}

// ───────────── Team schedule (whole month, scroll right) ─────────────
function ScheduleTab({ data, token, lang, tr, month, setMonth, reload, busy }: { data: MeData; token: string; lang: string; tr: TR; month: string; setMonth: (m: string) => void; reload: () => void; busy: boolean }) {
  const week = data.week;
  const me = data.employee;
  const today = hanoiToday();
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const wishes = new Set(week.wishes);
  const pub = new Set(week.weeks.filter((w) => w.published).map((w) => w.start));
  const selWeek = sel ? weekStart(sel) : null;
  const open = !!selWeek && today <= wishDeadline(selWeek) && !pub.has(selWeek);
  const used = week.monthOff[me.id] ?? 0;
  const isWish = sel ? wishes.has(me.id + '|' + sel) : false;
  const code = sel ? scheduleCode(me, sel, week.stored, wishes, week.wishParts) : null;
  const doOff = async (part?: 'S' | 'C') => {
    if (!sel) return;
    setWorking(true);
    const r = isWish ? await cancelOffAction(token, sel) : await requestOffAction(token, sel, part);
    setWorking(false);
    if (r.error) { setMsg(offErr(r.error, tr)); return; }
    setSel(null); setMsg(null); reload();
  };
  return (
    <div className="space-y-2">
      <MonthHeader month={week.month} lang={lang} busy={busy} onPrev={() => setMonth(addMonths(month, -1))} onNext={() => setMonth(addMonths(month, 1))}
        sub={tr(`${fmtDays(used)}/${week.allowance} days off used`, `đã nghỉ ${fmtDays(used)}/${week.allowance} ngày`)} />
      <div className="text-[10px] text-center" style={{ color: '#8B5E34' }}>⟵ {tr('scroll sideways through the month', 'kéo ngang để xem cả tháng')} ⟶</div>
      <MonthGrid data={week} lang={lang} meId={me.id} hideUnpublished
        onCell={(e, d) => { if (e.id === me.id) { setSel(d); setMsg(null); } }} />
      <Legend lang={lang} />
      <div className="rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed" style={{ background: '#FBF7F0', border: BORDER, color: '#2A1810' }}>
        {tr('Your row is highlighted. Read only — tap one of YOUR days to take it off (accepted at once if the day has room) or to cancel. Draft weeks (not published yet) may still change.',
          'Dòng của em được tô vàng. Chỉ xem — chạm vào ngày của EM để xin nghỉ (được nhận ngay nếu còn chỗ) hoặc để hủy. Tuần bản nháp (chưa công bố) có thể còn thay đổi.')}
      </div>
      {sel && (
        <div className="bg-white rounded-2xl p-3.5 space-y-2" style={{ border: '2px solid #C9A84C' }}>
          <div className="text-sm font-bold">{shortDay(sel, lang)}</div>
          {isWish ? (
            <div className="text-xs" style={{ color: '#6B7280' }}>
              {code === 'S' ? tr(`Afternoon off — you work ${halfHours('S', me.base_shift)}.`, `Nghỉ buổi chiều — em làm ${halfHours('S', me.base_shift)}.`)
                : code === 'C' ? tr(`Morning off — you work ${halfHours('C', me.base_shift)}.`, `Nghỉ buổi sáng — em làm ${halfHours('C', me.base_shift)}.`)
                : tr('You have this day off.', 'Em đang nghỉ ngày này.')}
            </div>
          ) : code === '7' || code === '8' ? (
            <div className="text-xs" style={{ color: '#6B7280' }}>{tr('Working day.', 'Ngày làm.')}</div>
          ) : (
            <div className="text-xs" style={{ color: '#6B7280' }}>{tr('Set by your leader — ask him to change it.', 'Do trưởng nhóm xếp — liên hệ trưởng nhóm để đổi.')}</div>
          )}
          {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
          {!isWish && (code === '7' || code === '8') && sel > today && (
            <div className="space-y-1.5">
              <button disabled={working || !open} onClick={() => doOff()} className="w-full min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-40" style={{ background: '#2A1810' }}>
                {tr('Full day off', 'Nghỉ cả ngày')}
              </button>
              <div className="grid grid-cols-2 gap-1.5">
                <button disabled={working || !open} onClick={() => doOff('C')} className="min-h-[44px] rounded-xl text-[12px] font-bold disabled:opacity-40 leading-tight" style={{ border: '1.5px solid #C9A84C', color: '#8B5E34', background: '#FBF7F0' }}>
                  {tr('Morning off', 'Nghỉ buổi sáng')}<br /><span className="font-normal text-[10px]">{tr('work ', 'làm ')}{halfHours('C', me.base_shift)}</span>
                </button>
                <button disabled={working || !open} onClick={() => doOff('S')} className="min-h-[44px] rounded-xl text-[12px] font-bold disabled:opacity-40 leading-tight" style={{ border: '1.5px solid #C9A84C', color: '#8B5E34', background: '#FBF7F0' }}>
                  {tr('Afternoon off', 'Nghỉ buổi chiều')}<br /><span className="font-normal text-[10px]">{tr('work ', 'làm ')}{halfHours('S', me.base_shift)}</span>
                </button>
              </div>
              <div className="text-[10px]" style={{ color: '#6B7280' }}>{tr('A half day off = 0.5 day off, always accepted.', 'Nghỉ nửa ngày = 0,5 ngày nghỉ, luôn được nhận.')}</div>
            </div>
          )}
          <div className="grid grid-cols-[1fr_1.6fr] gap-2">
            <button onClick={() => setSel(null)} className="min-h-[44px] rounded-xl text-[13px] font-bold bg-white" style={{ border: BORDER }}>{tr('Close', 'Đóng')}</button>
            {isWish && sel > today && (
              <button disabled={working || !open} onClick={() => doOff()} className="min-h-[44px] rounded-xl text-[13px] font-bold text-white disabled:opacity-40" style={{ background: '#8B5E34' }}>
                {tr('Cancel my day off', 'Hủy nghỉ')}
              </button>
            )}
          </div>
          {!open && <div className="text-[11px]" style={{ color: '#b45309' }}>{tr('Closed for this week — for sickness or an emergency use Requests.', 'Tuần này đã đóng — ốm hoặc việc gấp: dùng mục Yêu cầu.')}</div>}
        </div>
      )}
    </div>
  );
}

// ───────────── Days off (any date, months ahead too) ─────────────
function OffTab({ data, token, lang, tr, reload }: { data: MeData; token: string; lang: string; tr: TR; reload: () => void }) {
  const today = hanoiToday();
  const [day, setDay] = useState(addDays(weekStart(today), today <= wishDeadline(addDays(weekStart(today), 7)) ? 7 : 14));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState<'' | 'S' | 'C'>('');
  const ask = async () => {
    setBusy(true);
    const r = await requestOffAction(token, day, part || undefined);
    setBusy(false);
    setMsg(r.error ? { ok: false, text: offErr(r.error, tr) } : { ok: true, text: tr(`✓ ${shortDay(day, 'en')} off — it is in the schedule.`, `✓ Đã nghỉ ${shortDay(day, 'vi')} — đã vào lịch.`) });
    reload();
  };
  const cancel = async (d: string) => {
    const r = await cancelOffAction(token, d);
    setMsg(r.error ? { ok: false, text: offErr(r.error, tr) } : null);
    reload();
  };
  const byMonth: Record<string, string[]> = {};
  for (const d of data.myOffDays) (byMonth[monthStart(d)] ??= []).push(d);
  const weightOf = (d: string) => (data.myOffParts[d] ? 0.5 : 1);
  return (
    <div className="space-y-2.5">
      <div className="bg-white rounded-2xl p-3.5 space-y-2.5" style={{ border: BORDER }}>
        <div className="text-sm font-bold">{tr('Take a day off', 'Xin nghỉ một ngày')}</div>
        <input type="date" value={day} min={addDays(today, 1)} onChange={(e) => setDay(e.target.value)} className="w-full min-h-[44px] rounded-xl px-2.5 text-sm bg-white" style={{ border: BORDER }} />
        <div className="grid grid-cols-3 gap-1.5">
          {([['', tr('Full day', 'Cả ngày')], ['C', tr('Morning off', 'Nghỉ sáng')], ['S', tr('Afternoon off', 'Nghỉ chiều')]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setPart(v)} className="min-h-[40px] rounded-xl text-[12px] font-bold"
              style={part === v ? { background: '#2A1810', color: '#F6F1EA', border: '1px solid #2A1810' } : { background: '#fff', color: '#2A1810', border: BORDER }}>{l}</button>
          ))}
        </div>
        <button disabled={busy || !day} onClick={ask} className="w-full min-h-[48px] rounded-2xl font-bold text-sm text-white disabled:opacity-50" style={{ background: '#2A1810' }}>{tr('Take this day off', 'Xin nghỉ ngày này')}</button>
        {msg && <div className="text-xs font-semibold" style={{ color: msg.ok ? '#047857' : '#DC2626' }}>{msg.text}</div>}
        <div className="text-[11px] leading-relaxed" style={{ color: '#6B7280' }}>
          {tr('Accepted at once if the day has room (first come, first served). For next week: before the end of Saturday. You can book weeks or months ahead. Days off per month = number of Sundays. A half day off = 0.5, always accepted.',
            'Được nhận ngay nếu ngày đó còn chỗ (ai đăng ký trước được trước). Cho tuần sau: trước hết Thứ 7. Có thể đăng ký trước nhiều tuần, nhiều tháng. Số ngày nghỉ mỗi tháng = số Chủ nhật. Nghỉ nửa ngày = 0,5, luôn được nhận.')}
        </div>
      </div>
      <div className="text-xs font-bold px-1" style={{ color: '#2A1810' }}>{tr('My coming days off', 'Ngày nghỉ sắp tới của em')}</div>
      {data.myOffDays.length === 0 && <div className="bg-white rounded-2xl p-4 text-center text-xs" style={{ border: BORDER, color: '#6B7280' }}>{tr('None yet', 'Chưa có')}</div>}
      {Object.keys(byMonth).sort().map((m) => (
        <div key={m} className="bg-white rounded-2xl overflow-hidden" style={{ border: BORDER }}>
          <div className="px-3.5 py-2 text-xs font-bold flex justify-between" style={{ background: '#FBF7F0', color: '#2A1810' }}>
            <span>{monthLabel(m, lang)}</span><span style={{ color: '#8B5E34' }}>{fmtDays(byMonth[m].reduce((a, d) => a + weightOf(d), 0))}/{offAllowance(m)}</span>
          </div>
          {byMonth[m].map((d) => {
            const canCancel = today <= wishDeadline(weekStart(d));
            return (
              <div key={d} className="px-3.5 py-2 flex justify-between items-center text-sm" style={{ borderTop: '1px solid #F3EED9' }}>
                <span className="font-semibold">{shortDay(d, lang)}{data.myOffParts[d] === 'S' ? tr(' · afternoon off', ' · nghỉ chiều') : data.myOffParts[d] === 'C' ? tr(' · morning off', ' · nghỉ sáng') : ''}</span>
                {canCancel ? <button onClick={() => cancel(d)} className="text-xs underline min-h-[32px]" style={{ color: '#6B7280' }}>{tr('Cancel', 'Hủy')}</button>
                  : <span className="text-[11px]" style={{ color: '#9CA3AF' }}>{tr('locked', 'đã chốt')}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ───────────── Requests ─────────────
async function compress(file: File): Promise<Blob> {
  const img = document.createElement('img');
  const url = URL.createObjectURL(file);
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const s = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.75));
}

function ProofButton({ token, id, tr, reload }: { token: string; id: string; tr: TR; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const blob = await compress(f);
      const fd = new FormData();
      fd.append('file', new File([blob], 'proof.jpg', { type: 'image/jpeg' }));
      const r = await uploadProofAction(token, id, fd);
      if (r.error) setErr(r.error); else reload();
    } catch (e: any) { setErr(e?.message ?? 'Upload failed'); }
    setBusy(false);
  };
  return (
    <div>
      <label className="w-full min-h-[44px] rounded-xl text-[13px] font-bold flex items-center justify-center gap-1.5 cursor-pointer" style={{ border: '1px dashed #8B5E34', color: '#8B5E34', background: '#FBF7F0' }}>
        📎 {busy ? tr('Sending…', 'Đang gửi…') : tr('Add the proof paper (photo)', 'Gửi giấy tờ (chụp ảnh)')}
        <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
      </label>
      {err && <div className="text-xs mt-1" style={{ color: '#DC2626' }}>{err}</div>}
    </div>
  );
}

function RequestsTab({ data, token, lang, tr, reload }: { data: MeData; token: string; lang: string; tr: TR; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('sick');
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
  const colleagues = data.week.employees.filter((c) => c.id !== data.employee.id);
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
        <button onClick={() => setOpen(true)} className="w-full min-h-[50px] rounded-2xl font-bold text-sm bg-white" style={{ border: '1px dashed #2A1810', color: '#2A1810' }}>+ {tr('New request (sick, leave, late…)', 'Tạo yêu cầu (ốm, phép, đi muộn…)')}</button>
      ) : (
        <div className="bg-white rounded-2xl p-3.5 space-y-2.5" style={{ border: BORDER }}>
          <div className="flex justify-between items-center">
            <span className="text-sm font-bold">{tr('New request', 'Tạo yêu cầu')}</span>
            <button onClick={() => setOpen(false)} aria-label="Close" className="w-8 h-8 text-lg" style={{ color: '#6B7280' }}>×</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {HR_REQUEST_TYPES.map((t) => (
              <button key={t.id} onClick={() => setType(t.id)} className="min-h-[34px] px-2.5 rounded-full text-xs font-semibold"
                style={type === t.id ? { background: '#2A1810', color: '#fff', border: '1px solid #2A1810' } : { background: '#fff', border: BORDER }}>{lang === 'vi' ? t.vi : t.en}</button>
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
                {colleagues.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </select></label>
          )}
          <label className="block space-y-1"><span className={lbl} style={{ color: '#6B7280' }}>{tr('Reason', 'Lý do')}</span>
            <textarea value={reason} onChange={(ev) => setReason(ev.target.value)} className="w-full min-h-[56px] rounded-xl px-2.5 py-2 text-sm" style={{ border: BORDER }} /></label>
          <div className="text-[11px]" style={{ color: '#6B7280' }}>
            {hrNeedsGiang(type) ? tr('You → Team leader → Mr Giang → HR', 'Bạn → Trưởng nhóm → Anh Giang → Nhân sự') : tr('You → Team leader', 'Bạn → Trưởng nhóm')}
            {type === 'missed_punch' ? tr(' · without approval −50,000 đ', ' · không được duyệt −50.000đ') : ''}
            {HR_PROOF_TYPES.includes(type) ? tr(' · add the proof paper after (doctor…), otherwise it counts as a day off', ' · gửi giấy tờ sau (bác sĩ…), nếu không sẽ tính là ngày nghỉ') : ''}
          </div>
          {msg && <div className="text-xs font-semibold" style={{ color: '#DC2626' }}>{msg}</div>}
          <button disabled={busy} onClick={send} className="w-full min-h-[48px] rounded-2xl font-bold text-sm text-white disabled:opacity-50" style={{ background: '#2A1810' }}>{tr('Send to my leader', 'Gửi trưởng nhóm')}</button>
        </div>
      )}

      <div className="text-xs font-bold px-1" style={{ color: '#2A1810' }}>{tr('My requests', 'Yêu cầu của tôi')}</div>
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
        const proofType = HR_PROOF_TYPES.includes(r.type) && r.status !== 'rejected' && r.status !== 'cancelled';
        return (
          <div key={r.id} className="bg-white rounded-2xl px-3.5 py-3 space-y-2" style={{ border: BORDER }}>
            <div className="flex justify-between gap-2">
              <span className="text-sm font-bold">{hrTypeLabel(r.type, lang)}</span>
              <span className="text-xs" style={{ color: '#6B7280' }}>{shortDay(r.day_from, lang)}{r.day_to && r.day_to !== r.day_from ? ` → ${shortDay(r.day_to, lang)}` : ''}</span>
            </div>
            <div className="flex flex-wrap gap-1 items-center">{steps}</div>
            {proofType && (r.proof_path ? <div className="text-xs font-semibold" style={{ color: '#047857' }}>{tr('📎 Proof sent ✓', '📎 Đã gửi giấy tờ ✓')}</div>
              : r.no_proof ? <div className="text-xs font-semibold" style={{ color: '#8B5E34' }}>{tr('No proof → counted as day off', 'Không giấy tờ → tính ngày nghỉ')}</div>
              : <ProofButton token={token} id={r.id} tr={tr} reload={reload} />)}
            {r.status === 'pending_leader' && <button onClick={() => cancel(r.id)} className="text-xs underline min-h-[30px]" style={{ color: '#6B7280' }}>{tr('Cancel my request', 'Hủy yêu cầu')}</button>}
          </div>
        );
      })}
    </div>
  );
}

// ───────────── My month ─────────────
function MonthTab({ data, lang, tr }: { data: MeData; lang: string; tr: TR }) {
  const w = data.week;
  const used = w.monthOff[data.employee.id] ?? 0;
  const pendingReq = data.requests.filter((r) => r.status === 'pending_leader' || r.status === 'pending_giang').length;
  const box = (label: string, value: string) => (
    <div className="bg-white rounded-2xl p-3" style={{ border: BORDER }}>
      <div className="text-[10px]" style={{ color: '#6B7280' }}>{label}</div>
      <div className="text-xl font-black" style={{ color: '#2A1810' }}>{value}</div>
    </div>
  );
  return (
    <div className="space-y-2.5">
      <div className="font-bold text-[16px] px-1" style={{ color: '#2A1810' }}>{monthLabel(w.month, lang)}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {box(tr('Days off used', 'Ngày nghỉ đã dùng'), `${fmtDays(used)} / ${w.allowance}`)}
        {box(tr('Days off left', 'Ngày nghỉ còn lại'), fmtDays(Math.max(0, w.allowance - used)))}
        {box(tr('Overtime this month', 'Tăng ca tháng này'), `${data.otMonthHours} ${tr('h', 'giờ')}`)}
        {box(tr('Requests in progress', 'Yêu cầu đang chờ'), String(pendingReq))}
      </div>
      <div className="rounded-2xl px-3.5 py-3 text-xs leading-relaxed" style={{ background: '#FBF7F0', border: BORDER, color: '#2A1810' }}>
        {tr(`Days off per month = number of Sundays (${w.allowance} in ${monthLabel(w.month, 'en')}).`, `Số ngày nghỉ mỗi tháng = số Chủ nhật (${w.allowance} trong ${monthLabel(w.month, 'vi')}).`)}
        <br />
        {tr('Time clock hours and payslip will appear here when HR imports the time clock data.', 'Giờ chấm công và phiếu lương sẽ hiện ở đây khi Nhân sự nhập dữ liệu chấm công.')}
      </div>
    </div>
  );
}

