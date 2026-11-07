'use client';
import Link from 'next/link';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

export type TodayRow = { id: string; count: number; urgent: boolean; href: string; vi: string; en: string; hintVi: string; hintEn: string };

export default function TodayView({ rows, name }: { rows: TodayRow[]; name: string }) {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const open = rows.filter(r => r.count > 0).sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.count - a.count);
  const done = rows.filter(r => r.count === 0);
  const today = new Intl.DateTimeFormat(vi ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const raw = (name.split(/[\s.]+/).filter(Boolean).pop() ?? '');
  const first = raw ? raw[0].toUpperCase() + raw.slice(1) : '';

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] capitalize" style={{ color: '#8A6D14' }}>{today}</p>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold text-navy mt-1">
            {open.length === 0
              ? (vi ? 'Mọi thứ đã xong 👏' : 'All clear for today')
              : vi ? `Còn ${open.length} việc cần làm` : `${open.length} thing${open.length > 1 ? 's' : ''} to do`}
          </h1>
          <p className="text-sm text-ink-light mt-1">
            {vi ? `Xin chào${first ? ' ' + first : ''}. Cuối ngày, mọi dòng phải xanh.` : `Hello${first ? ' ' + first : ''}. By end of day, every line should be green.`}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold">
          <span className="rounded-full px-2.5 py-1 bg-white border border-border-soft text-navy tabular-nums">{done.length}/{rows.length} {vi ? 'xong' : 'done'}</span>
        </div>
      </header>

      <div className="h-2 rounded-full bg-white border border-border-soft overflow-hidden" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${rows.length ? (done.length / rows.length) * 100 : 100}%`, backgroundColor: '#1A4731' }} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start">
        <section className="space-y-2 min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-light">{vi ? 'Cần làm' : 'To do'}</h2>
          {open.length === 0 && (
            <div className="rounded-2xl bg-white border border-border-soft px-4 py-6 text-center text-sm text-ink-light">
              {vi ? 'Không còn việc nào. Tốt lắm!' : 'Nothing left to do.'}
            </div>
          )}
          {open.map(r => (
            <Link key={r.id} href={r.href} prefetch={false}
              className="group flex items-center gap-3 rounded-2xl bg-white border border-border-soft pl-0 pr-3 py-3 hover:border-gold transition-colors overflow-hidden">
              <span className="self-stretch w-1.5 rounded-r" style={{ backgroundColor: r.urgent ? '#DC2626' : '#C9A84C' }} />
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-semibold text-ink">{vi ? r.vi : r.en}</span>
                <span className="block text-xs text-ink-light truncate">{vi ? r.hintVi : r.hintEn}</span>
              </span>
              <span className="text-lg font-bold tabular-nums min-w-[2.5rem] text-right" style={{ color: r.urgent ? '#B42318' : '#8A6D14' }}>{r.count}</span>
              <ChevronRight size={18} className="text-ink-light group-hover:text-navy" />
            </Link>
          ))}
        </section>

        <section className="space-y-2 min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-light">{vi ? 'Đã xong' : 'Done'}</h2>
          <div className="rounded-2xl bg-white border border-border-soft divide-y divide-border-soft/60">
            {done.length === 0 && <p className="px-4 py-3 text-sm text-ink-light">—</p>}
            {done.map(r => (
              <Link key={r.id} href={r.href} prefetch={false} className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink hover:bg-gold-pale">
                <CheckCircle2 size={17} style={{ color: '#067647' }} className="shrink-0" />
                <span className="flex-1 min-w-0 truncate">{vi ? r.vi : r.en}</span>
              </Link>
            ))}
          </div>
          <p className="text-[11px] text-ink-light px-1">{vi ? 'Cập nhật mỗi 20 giây.' : 'Updated every 20 seconds.'}</p>
        </section>
      </div>
    </div>
  );
}
