'use client';
// Progress of one purchase request line: Sent -> Ordered (or Sent -> Cancelled). Shared by the chef
// station tab and the purchasing history. 'Received' is left out on purpose for now (Axel,
// 2026-10-08: deliveries are confirmed long after the real delivery — to be solved later).
import type { PurchaseLine } from '@/lib/raw-materials';
import { vnDayTime } from '@/lib/raw-materials';

const NAVY = '#1A4731', GOLD = '#C9A84C', GOLD_TEXT = '#8A6D14', HAIR = '#EFE9CF', LATE = '#B42318';
type LFn = (vi: string, en: string) => string;

export function Track({ l, L }: { l: PurchaseLine; L: LFn }) {
  const ageDays = l.status === 'pending' ? Math.floor((Date.now() - new Date(l.createdAt).getTime()) / 86400000) : 0;
  const late = l.status === 'pending' && ageDays >= 2;
  if (l.status === 'cancelled') {
    return (
      <div className="flex items-start">
        <Step state="done" label={L('Gửi', 'Sent')} date={vnDayTime(l.createdAt).day} first />
        <Step state="x" label={L('Đã huỷ', 'Cancelled')} date={vnDayTime(l.cancelledAt).day} />
      </div>
    );
  }
  const idx = l.status === 'pending' ? 0 : 1;
  const st = (i: number): 'done' | 'cur' | 'late' | 'todo' => (i <= idx ? 'done' : i === idx + 1 ? (late ? 'late' : 'cur') : 'todo');
  return (
    <div className="flex items-start">
      <Step state={st(0)} label={L('Gửi', 'Sent')} date={vnDayTime(l.createdAt).day} first />
      <Step state={st(1)} label={L('Đã đặt', 'Ordered')} date={l.orderedAt ? vnDayTime(l.orderedAt).day : late ? `${ageDays} ${L('ngày', 'days')}` : '—'} />
    </div>
  );
}
function Step({ state, label, date, first }: { state: 'done' | 'cur' | 'late' | 'todo' | 'x'; label: string; date: string; first?: boolean }) {
  const dot = state === 'done' ? { background: NAVY, borderColor: NAVY } : state === 'cur' ? { background: '#FFF4CC', borderColor: GOLD }
    : state === 'late' ? { background: '#FEF3F2', borderColor: LATE } : state === 'x' ? { background: '#F2F4F7', borderColor: '#98A2B3' } : { background: '#fff', borderColor: '#D0D5DD' };
  const line = state === 'done' ? NAVY : state === 'cur' ? `repeating-linear-gradient(90deg, ${GOLD} 0 5px, transparent 5px 9px)` : state === 'late' ? `repeating-linear-gradient(90deg, ${LATE} 0 5px, transparent 5px 9px)` : HAIR;
  const col = state === 'done' ? NAVY : state === 'cur' ? GOLD_TEXT : state === 'late' ? LATE : '#6B7280';
  return (
    <div className="flex-1 min-w-[58px] flex flex-col items-center relative">
      {!first && <span className="absolute h-[2px]" style={{ top: 6, left: '-50%', width: '100%', background: line }} />}
      <span className="w-3.5 h-3.5 rounded-full border-2 relative z-10" style={dot} />
      <span className="text-[10.5px] font-bold mt-1 whitespace-nowrap" style={{ color: col }}>{label}</span>
      <span className="text-[10.5px] tabular-nums whitespace-nowrap" style={{ color: '#9CA3AF' }}>{date}</span>
    </div>
  );
}

