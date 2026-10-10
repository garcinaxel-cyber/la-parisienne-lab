'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventSale } from './actions';
import { useShopL } from './shop-lang';

// Daily sales target on the event's Sales screen (Axel, 2026-10-10: "un compte à rebours visuel
// pour la target des 50 M du jour ... une animation si ils sont dans les temps ou non" — validated
// on mockup v2: a ring next to the day's total + one pace line under the cash / transfer bar, the
// detailed bar when the ring is tapped, a short celebration when the target is reached).
// Purely additive: it only reads the ledger the Sales screen already loaded. The celebration is
// ephemeral and never blocks the till ("ça doit être éphémère, je veux pas leur bloquer la vente"):
// pointer-events none, gone by itself after ~3 s, once per day per phone.

const GREEN = '#1E7D55', AMBER = '#B7791F', RED = '#B4432B', TRACK = '#F3EBD3', INKC = '#1F2937', MUTEDC = '#6B7280';

const toMin = (hm: string) => { const [h, m] = (hm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const saleMin = (s: EventSale) => toMin(s.time.slice(0, 5)) + Number(s.time.slice(6, 8) || 0) / 60;
function vnNowMin(): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0);
  return (g('hour') % 24) * 60 + g('minute') + g('second') / 60;
}
function shortM(v: number): string {
  const m = v / 1e6;
  if (Math.abs(m) >= 1) return (Math.round(m * 10) / 10).toString().replace('.', ',') + 'M';
  return Math.round(v / 1e3) + 'k';
}
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

export type TargetStatus = 'early' | 'ahead' | 'slight' | 'behind' | 'reached' | 'missed';
export type TargetState = {
  target: number; done: number; pct: number; expected: number; status: TargetStatus; color: string; bg: string;
  isToday: boolean; minLeft: number; needPerHour: number | null; reachedAt: string | null;
  checkpoints: { label: string; amount: number }[]; curveFromHistory: boolean; closeTime: string;
};

// Share of a day's sales already made by minute m: the average curve of the event's previous days
// (evenings weigh a lot at a fair), or a straight line between opening and closing when there is no
// earlier day yet.
function makeCurve(sales: EventSale[], day: string, open: number, close: number) {
  const prev = new Map<string, EventSale[]>();
  for (const s of sales) if (s.day < day && s.amount > 0) { const a = prev.get(s.day) ?? []; a.push(s); prev.set(s.day, a); }
  const days = Array.from(prev.values()).map(list => {
    const tot = list.reduce((x, s) => x + s.amount, 0);
    const pts = list.map(s => ({ m: saleMin(s), a: s.amount })).sort((a, b) => a.m - b.m);
    return { tot, pts };
  }).filter(d => d.tot > 0);
  const linear = (m: number) => Math.max(0, Math.min(1, (m - open) / Math.max(1, close - open)));
  if (!days.length) return { share: linear, fromHistory: false };
  return {
    fromHistory: true,
    share: (m: number) => {
      if (m >= close) return 1;
      let acc = 0;
      for (const d of days) { let c = 0; for (const p of d.pts) { if (p.m <= m) c += p.a; else break; } acc += c / d.tot; }
      return Math.min(1, acc / days.length);
    },
  };
}

export function useDailyTarget(opts: { sales: EventSale[]; day: string | null; today: string; target?: number | null; openTime?: string; closeTime?: string }): TargetState | null {
  const { sales, day, today, target } = opts;
  const [tick, setTick] = useState(0);
  const isToday = !!day && day === today;
  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => setTick(x => x + 1), 30_000);
    return () => clearInterval(t);
  }, [isToday]);
  return useMemo(() => {
    if (!day || !target || target <= 0 || day > today) return null;
    const open = toMin(opts.openTime ?? '10:00'), close = toMin(opts.closeTime ?? '22:00');
    const daySales = sales.filter(s => s.day === day).slice().sort((a, b) => saleMin(a) - saleMin(b));
    const done = daySales.reduce((x, s) => x + s.amount, 0);
    let reachedAt: string | null = null, run = 0;
    for (const s of daySales) { run += s.amount; if (run >= target) { reachedAt = s.time.slice(0, 5); break; } }
    const { share, fromHistory } = makeCurve(sales, day, open, close);
    const now = isToday ? vnNowMin() : close;
    const expected = target * share(Math.min(now, close));
    const minLeft = isToday ? Math.max(0, close - now) : 0;
    let status: TargetStatus;
    if (done >= target) status = 'reached';
    else if (!isToday || now >= close) status = 'missed';
    else if (now < open || expected <= 0) status = 'early';
    else if (done >= expected) status = 'ahead';
    else if (done >= expected * 0.9) status = 'slight';
    else status = 'behind';
    const color = status === 'reached' || status === 'ahead' || status === 'early' ? GREEN : status === 'slight' ? AMBER : RED;
    const bg = color === GREEN ? '#EAF6EC' : color === AMBER ? '#FEF3C7' : '#FBEAE8';
    const needPerHour = status === 'behind' && minLeft > 0 ? (target - done) / (minLeft / 60) : null;
    const cps: { label: string; amount: number }[] = [];
    for (let h = Math.ceil(open / 60) + 4; h * 60 < close; h += 2) cps.push({ label: `${h}h`, amount: target * share(h * 60) });
    cps.push({ label: hm(close).replace(':00', 'h'), amount: target });
    return {
      target, done, pct: done / target, expected, status, color, bg, isToday, minLeft, needPerHour, reachedAt,
      checkpoints: cps, curveFromHistory: fromHistory, closeTime: hm(close),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sales, day, today, target, opts.openTime, opts.closeTime, tick, isToday]);
}

export function TargetRing({ st, onClick, open }: { st: TargetState; onClick: () => void; open: boolean }) {
  const L = useShopL();
  const r = 26, C = 2 * Math.PI * r, p = Math.min(1, st.pct);
  return (
    <button onClick={onClick} aria-expanded={open} aria-label={L('Mục tiêu hôm nay', "Today's target")}
      className="relative flex-shrink-0" style={{ width: 64, height: 64 }}>
      <svg width={64} height={64} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={32} cy={32} r={r} fill="none" stroke={TRACK} strokeWidth={7} />
        <circle cx={32} cy={32} r={r} fill="none" stroke={st.color} strokeWidth={7} strokeLinecap="round"
          strokeDasharray={`${C * p} ${C}`} style={{ transition: 'stroke-dasharray .8s ease' }} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-[14px] font-extrabold" style={{ color: st.color }}>{Math.floor(st.pct * 100)}%</span>
        <span className="text-[8.5px] font-semibold mt-0.5" style={{ color: MUTEDC }}>{L('của', 'of')} {shortM(st.target)}</span>
      </span>
    </button>
  );
}

export function TargetLine({ st }: { st: TargetState }) {
  const L = useShopL();
  const gap = st.done - st.expected;
  const left = `${Math.floor(st.minLeft / 60)}h${String(Math.floor(st.minLeft % 60)).padStart(2, '0')}`;
  const pill =
    st.status === 'reached' ? `✓ ${L('Đã đạt', 'Reached')} ${shortM(st.target)}${st.reachedAt ? ` ${L('lúc', 'at')} ${st.reachedAt}` : ''}`
    : st.status === 'missed' ? `${L('Kết thúc', 'Ended at')} ${Math.floor(st.pct * 100)}%`
    : st.status === 'early' ? L('Chưa mở cửa', 'Not open yet')
    : st.status === 'ahead' ? `▲ ${L('Vượt tiến độ', 'Ahead')} +${shortM(gap)}`
    : `${st.status === 'slight' ? '●' : '▼'} ${L('Chậm', 'Behind')} −${shortM(-gap)}`;
  const right =
    st.status === 'reached' ? (st.isToday ? L('Tuyệt vời! 🎉', 'Well done! 🎉') : '')
    : st.status === 'missed' ? `${L('thiếu', 'short by')} ${shortM(st.target - st.done)}`
    : L(`còn ${shortM(st.target - st.done)} · ⏱ ${left}`, `${shortM(st.target - st.done)} to go · ⏱ ${left}`);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-xl" style={{ padding: '7px 10px', backgroundColor: st.bg }}>
        <span className="text-[12.5px] font-extrabold whitespace-nowrap" style={{ color: st.color }}>{pill}</span>
        {right && <span className="text-[11.5px] text-right whitespace-nowrap" style={{ color: '#374151' }}>{right}</span>}
      </div>
      {st.needPerHour !== null && (
        <div className="text-[11px] mt-1 pl-0.5" style={{ color: '#7F1D1D' }}>
          {L(`Cần bán ~${shortM(st.needPerHour)}/giờ đến ${st.closeTime} để đạt ${shortM(st.target)}`,
             `Need ~${shortM(st.needPerHour)} per hour until ${st.closeTime} to reach ${shortM(st.target)}`)}
        </div>
      )}
    </div>
  );
}

export function TargetDetail({ st }: { st: TargetState }) {
  const L = useShopL();
  const fill = Math.min(100, st.pct * 100), mark = Math.min(100, (st.expected / st.target) * 100);
  return (
    <div className="mt-2.5 rounded-xl" style={{ padding: '10px 11px 9px', border: '1px solid #EFE9CF' }}>
      <div className="flex justify-between text-[10.5px] font-extrabold uppercase tracking-wide" style={{ color: '#8A6D14' }}>
        <span>{L('Mục tiêu hôm nay', "Today's target")}</span><span>{shortM(st.target)}</span>
      </div>
      <div className="relative mt-2.5" style={{ height: 12, borderRadius: 6, backgroundColor: TRACK }}>
        <div style={{ position: 'absolute', inset: 0, width: `${fill}%`, borderRadius: 6, backgroundColor: st.color, transition: 'width .8s ease' }} />
        {st.isToday && st.status !== 'reached' && st.status !== 'early' && (
          <div style={{ position: 'absolute', top: -4, bottom: -4, left: `calc(${mark}% - 1.5px)`, width: 3, borderRadius: 2, backgroundColor: INKC }} />
        )}
      </div>
      {st.isToday && st.status !== 'reached' && st.status !== 'early' && (
        <div className="relative text-[10.5px] mt-1" style={{ height: 14 }}>
          <span className="absolute whitespace-nowrap" style={{ left: `${Math.min(70, Math.max(0, mark - 12))}%`, color: INKC }}>
            ▲ {L('cần lúc này', 'needed by now')} {shortM(st.expected)}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] mt-1.5" style={{ color: MUTEDC }}>
        {st.checkpoints.map(c => <span key={c.label}>{c.label} <b style={{ color: INKC }}>{shortM(c.amount)}</b></span>)}
      </div>
      <div className="text-[10.5px] mt-1" style={{ color: '#9CA3AF' }}>
        {st.curveFromHistory
          ? L('Mốc tính theo nhịp bán các ngày trước của event.', "Checkpoints follow the event's earlier days.")
          : L('Mốc chia đều theo giờ mở cửa.', 'Checkpoints spread evenly over opening hours.')}
      </div>
    </div>
  );
}

// ── Effects: "+115k" float on new sales, small confetti at 50 % / 80 %, celebration at 100 %. ──
const CONF_COLORS = ['#E5C77A', '#1E7D55', '#FFFAEE', '#C08A12', '#B7DFC0'];
function seen(key: string): boolean { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function mark(key: string) { try { localStorage.setItem(key, '1'); } catch { /* private mode: may show again */ } }

export function TargetFx({ st, day }: { st: TargetState; day: string }) {
  const L = useShopL();
  const prev = useRef<number | null>(null);
  const [float, setFloat] = useState<{ id: number; text: string } | null>(null);
  const [burst, setBurst] = useState<number | null>(null);
  const [party, setParty] = useState<{ at: string } | null>(null);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!st.isToday) return;
    const before = prev.current;
    prev.current = st.done;
    if (before !== null && st.done > before) {
      setFloat({ id: Date.now(), text: `+${shortM(st.done - before)}` });
      setTimeout(() => setFloat(null), 1800);
    }
    const base = `lab_ev_target_${day}_${Math.round(st.target)}_`;
    if (st.pct >= 1) {
      if (!seen(base + '100')) { mark(base + '100'); mark(base + '50'); mark(base + '80'); setParty({ at: st.reachedAt ?? '' }); setTimeout(() => setParty(null), 3300); }
    } else {
      for (const lvl of [80, 50]) {
        if (st.pct * 100 >= lvl && !seen(base + lvl)) { mark(base + lvl); if (lvl === 80) mark(base + '50'); setBurst(Date.now()); setTimeout(() => setBurst(null), 1700); break; }
      }
    }
  }, [st.done, st.pct, st.isToday, st.target, st.reachedAt, day]);

  const pieces = (n: number, spread: number) => Array.from({ length: n }, (_, i) => ({
    left: (i * 37 + 11) % 100, delay: (i % 7) * 0.08, rot: (i * 47) % 360, c: CONF_COLORS[i % CONF_COLORS.length], dx: ((i * 29) % spread) - spread / 2,
  }));

  return (
    <>
      <style>{`
        @keyframes evtFloat { 0% { opacity: 0; transform: translateY(6px) } 15% { opacity: 1 } 100% { opacity: 0; transform: translateY(-26px) } }
        @keyframes evtFall { 0% { transform: translate(0,-20px) rotate(0) } 100% { transform: translate(var(--dx), 110vh) rotate(540deg) } }
        @keyframes evtBurst { 0% { opacity: 1; transform: translate(0,0) rotate(0) } 100% { opacity: 0; transform: translate(var(--dx), 70px) rotate(360deg) } }
        @keyframes evtParty { 0% { opacity: 0 } 10% { opacity: 1 } 80% { opacity: 1 } 100% { opacity: 0 } }
      `}</style>
      {float && !reduce && (
        <span key={float.id} className="absolute pointer-events-none text-[13px] font-extrabold" style={{ right: 78, top: 30, color: GREEN, animation: 'evtFloat 1.8s ease-out forwards' }}>
          {float.text}
        </span>
      )}
      {burst && !reduce && (
        <span className="absolute pointer-events-none" style={{ inset: 0, overflow: 'hidden', borderRadius: 16 }}>
          {pieces(18, 120).map((p, i) => (
            <i key={i} style={{ position: 'absolute', top: 20, left: `${p.left}%`, width: 7, height: 11, borderRadius: 2, backgroundColor: p.c,
              ['--dx' as any]: `${p.dx}px`, animation: `evtBurst 1.5s ${p.delay}s ease-out forwards`, transform: `rotate(${p.rot}deg)` }} />
          ))}
        </span>
      )}
      {party && (
        <div className="fixed inset-0 flex flex-col items-center justify-center text-center pointer-events-none"
          style={{ zIndex: 60, backgroundColor: 'rgba(26,71,49,0.88)', color: '#FFFAEE', animation: 'evtParty 3.2s ease forwards' }} aria-live="polite">
          {!reduce && pieces(40, 160).map((p, i) => (
            <i key={i} style={{ position: 'absolute', top: 0, left: `${p.left}%`, width: 9, height: 14, borderRadius: 2, backgroundColor: p.c,
              ['--dx' as any]: `${p.dx}px`, animation: `evtFall 3s ${p.delay}s linear forwards` }} />
          ))}
          <div style={{ fontSize: 40, fontWeight: 800, color: '#E5C77A', fontFamily: "'Playfair Display', Georgia, serif" }}>🎉 {shortM(st.target).replace('M', L(' triệu!', ' million!'))}</div>
          <div style={{ fontSize: 16, marginTop: 8 }}>
            {L('Đạt mục tiêu hôm nay', "Today's target reached")}{party.at ? ` ${L('lúc', 'at')} ${party.at}` : ''}<br />{L('Cảm ơn cả đội!', 'Thank you, team!')}
          </div>
        </div>
      )}
    </>
  );
}
