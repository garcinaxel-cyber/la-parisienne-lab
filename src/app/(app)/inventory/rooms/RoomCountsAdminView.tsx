'use client';
// Room counts — admin check list (Axel, 2026-10-20). One row per room (latest count), each count opens
// to: products left out and why, products counted several times, unit alerts, then the full list.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ClipboardCheck, ChevronDown, ChevronRight, ArrowLeft, AlertTriangle } from 'lucide-react';
import { TEAM_SHORT, TRANSFER_TEAMS, fmtQty, vnDayTime } from '@/lib/raw-materials';
import { LEFT_OUT_REASONS } from '@/lib/room-count';
import { getRoomCountsAdminAction, type AdminRoomSession, type AdminRoomLine } from '../room-actions';

const NAVY = '#1A4731', GOLD_TEXT = '#8A6D14', PALE = '#FFFAEE', LATE = '#B42318', OK = '#067647', OKBG = '#EAF6EC', HAIR = '#EFE9CF';

export default function RoomCountsAdminView() {
  const { lang } = useI18n();
  const vi = lang === 'vi';
  const T = (v: string, f: string) => (vi ? v : f);
  const [ss, setSs] = useState<AdminRoomSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState<string | null>(null);
  useEffect(() => { getRoomCountsAdminAction().then(r => { if (r.error) setErr(r.error); setSs(r.sessions ?? []); }); }, []);

  const name = (l: { name: string; nameVi: string | null }) => (vi && l.nameVi ? l.nameVi : l.name);
  const team = (t: string) => TEAM_SHORT[t]?.en ?? t;
  const status = (s: AdminRoomSession | undefined) => !s ? { t: T('Chưa bắt đầu', 'Pas commencé'), c: LATE, bg: '#FBEAE8' }
    : s.status === 'confirmed' ? { t: T('Đã xác nhận', 'Confirmé'), c: OK, bg: OKBG } : { t: T('Đang đếm', 'En cours'), c: GOLD_TEXT, bg: PALE };
  const latest = TRANSFER_TEAMS.map(t => [t, (ss ?? []).find(s => s.team === t)] as const);
  const qtyTxt = (l: AdminRoomLine) => l.total == null ? '—' : l.zero ? '= 0' : `${fmtQty(l.total)} ${l.uom}`;

  return (
    <div className="space-y-4">
      <Link href="/inventory" className="inline-flex items-center gap-1 text-sm font-semibold text-ink-light"><ArrowLeft size={15} /> {T('Kiểm kê', 'Inventaire')}</Link>
      <h1 className="font-serif text-xl sm:text-2xl font-bold text-navy flex items-center gap-2"><ClipboardCheck size={22} className="text-gold" />{T('Kiểm kê room các team', 'Inventaire des rooms des chefs')}</h1>
      <p className="text-sm text-ink-light">{T('Các team đếm room của mình trên điện thoại. Giai đoạn 1: chưa gửi Odoo.', 'Les équipes comptent leur room sur téléphone. Phase 1 : rien n\'est envoyé à Odoo.')}</p>
      {err && <div className="text-sm font-semibold" style={{ color: LATE }}>{err}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-light">
            <th className="px-3 py-2">Room</th><th className="px-3 py-2">{T('Trạng thái', 'État')}</th><th className="px-3 py-2">{T('Ngày', 'Date')}</th>
            <th className="px-3 py-2 text-right">{T('Đã đếm', 'Comptés')}</th><th className="px-3 py-2 text-right">= 0</th>
            <th className="px-3 py-2 text-right">{T('Không đếm', 'Hors inventaire')}</th><th className="px-3 py-2 text-right">{T('Nhiều lượt', 'Plusieurs saisies')}</th><th className="px-3 py-2 text-right">{T('Cảnh báo', 'Alertes')}</th>
          </tr></thead>
          <tbody>{latest.map(([t, s]) => { const st = status(s); return (
            <tr key={t} className="border-t" style={{ borderColor: HAIR }}>
              <td className="px-3 py-2 font-bold text-navy">{team(t)}</td>
              <td className="px-3 py-2"><span className="text-xs font-bold rounded-full px-2 py-0.5" style={{ color: st.c, backgroundColor: st.bg }}>{st.t}</span></td>
              <td className="px-3 py-2 tabular-nums">{s?.countDate ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s?.counted ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s?.zero ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums" style={{ color: s?.noReason ? LATE : undefined }}>{s ? `${s.leftOut}${s.noReason ? ` (${s.noReason} ${T('chưa lý do', 'sans raison')})` : ''}` : '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{s?.multi ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums" style={{ color: s?.alerts ? LATE : undefined }}>{s?.alerts ?? '—'}</td>
            </tr>); })}</tbody>
        </table>
      </div>

      <h2 className="text-sm font-bold text-navy uppercase tracking-wide">{T('Các lần kiểm kê', 'Comptages')}</h2>
      {!ss ? <div className="card p-6 text-center text-sm text-ink-light">…</div>
        : ss.length === 0 ? <div className="card p-6 text-center text-sm text-ink-light">{T('Chưa có kiểm kê room nào', 'Aucun inventaire de room pour le moment')}</div>
        : <div className="space-y-2">{ss.map(s => {
          const st = status(s); const isOpen = open === s.id;
          const left = s.lines.filter(l => l.total == null), multi = s.lines.filter(l => l.entries.length > 1), alerts = s.lines.filter(l => l.unitAlert);
          return (
            <div key={s.id} className="card overflow-hidden">
              <button onClick={() => setOpen(isOpen ? null : s.id)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-cream/60">
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <div className="flex-1 min-w-0"><div className="text-sm font-bold text-navy">{team(s.team)} · {s.countDate}</div>
                  <div className="text-xs text-ink-light truncate">{T('Chốt', 'Cut-off')} {vnDayTime(s.cutoffAt).time} · {T('mở bởi', 'ouvert par')} {s.openedBy ?? '—'}{s.confirmedBy ? ` · ${T('xác nhận bởi', 'confirmé par')} ${s.confirmedBy}` : ''}</div>
                  {s.odooState && <div className="text-xs font-semibold truncate" style={{ color: s.odooState === 'done' || s.odooState === 'sent' ? '#047857' : s.odooState === 'waiting' || s.odooState === 'pending' ? '#B45309' : '#B42318' }}>Odoo: {s.odooState === 'done' ? T('đã điều chỉnh', 'ajusté') : s.odooState === 'sent' ? T('đã gửi phiếu kiểm kê — chờ xác nhận trên Odoo', 'feuille de comptage envoyée — à valider dans Odoo') : s.odooState === 'waiting' || s.odooState === 'pending' ? T('đang chờ', 'en attente') : `${T('lỗi', 'erreur')} — ${s.odooError ?? ''}`}</div>}</div>
                <span className="text-xs font-bold rounded-full px-2 py-0.5 shrink-0" style={{ color: st.c, backgroundColor: st.bg }}>{st.t}</span>
              </button>
              {isOpen && <div className="px-4 pb-4 space-y-4 text-sm">
                <section className="space-y-1.5">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-navy">{T('Không đếm — cần kiểm tra', 'Hors inventaire — à vérifier')} · {left.length}</h3>
                  {left.length === 0 ? <div className="text-xs text-ink-light">{T('Không có.', 'Aucun.')}</div> : (
                    <div className="overflow-x-auto"><table className="w-full text-[13px]"><tbody>{left.map(l => (
                      <tr key={l.tmplId} className="border-t" style={{ borderColor: HAIR }}>
                        <td className="py-1.5 pr-3">{name(l)} <span className="text-[11px] text-ink-light">{l.sku ?? ''}</span></td>
                        <td className="py-1.5 pr-3" style={{ color: !l.reason || l.reason === 'no_time' ? LATE : undefined }}>{l.reason ? (vi ? LEFT_OUT_REASONS[l.reason].vi : LEFT_OUT_REASONS[l.reason].en) : T('Chưa có lý do', 'Pas de raison')}{l.note ? ` — ${l.note}` : ''}</td>
                        <td className="py-1.5 text-right text-ink-light text-xs whitespace-nowrap">{l.takenRecent ? `${T('lấy 14 ngày', 'pris 14 j')}: ${fmtQty(l.takenRecent)} ${l.uom}` : ''}</td>
                      </tr>))}</tbody></table></div>)}
                </section>
                <section className="space-y-1.5">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-navy">{T('Đếm nhiều lượt', 'Comptés plusieurs fois')} · {multi.length}</h3>
                  {multi.map(l => <div key={l.tmplId} className="text-[13px]"><b>{name(l)}</b> · {qtyTxt(l)}
                    <div className="text-xs text-ink-light">{l.entries.map(e => `${e.by ?? '—'} ${vnDayTime(e.at).time}: ${e.isZero ? '= 0' : e.pack ?? `${fmtQty(e.qty)} ${l.uom}`}`).join(' · ')}</div></div>)}
                </section>
                {alerts.length > 0 && <section className="space-y-1.5">
                  <h3 className="text-xs font-bold uppercase tracking-wide flex items-center gap-1" style={{ color: LATE }}><AlertTriangle size={13} /> {T('Kiểm tra đơn vị', 'Unités à vérifier')} · {alerts.length}</h3>
                  {alerts.map(l => <div key={l.tmplId} className="text-[13px] flex justify-between gap-3"><span>{name(l)}</span><span className="tabular-nums whitespace-nowrap">{qtyTxt(l)} vs {fmtQty(l.takenRecent ?? 0)} {l.uom} {T('lấy 14 ngày', 'pris 14 j')}</span></div>)}
                </section>}
                <section>
                  <button onClick={() => setAll(all === s.id ? null : s.id)} className="text-xs font-bold" style={{ color: GOLD_TEXT }}>{all === s.id ? T('Ẩn danh sách', 'Masquer la liste') : T(`Xem cả ${s.lines.length} nguyên liệu`, `Voir les ${s.lines.length} matières`)}</button>
                  {all === s.id && <div className="overflow-x-auto mt-2"><table className="w-full text-[13px]">
                    <thead><tr className="text-left text-[11px] uppercase tracking-wide text-ink-light"><th className="py-1 pr-3">{T('Nguyên liệu', 'Matière')}</th><th className="py-1 pr-3 text-right">{T('Đếm', 'Compté')}</th><th className="py-1 text-right">{T('Lấy 14 ngày', 'Pris 14 j')}</th></tr></thead>
                    <tbody>{s.lines.slice().sort((a, b) => name(a).localeCompare(name(b))).map(l => (
                      <tr key={l.tmplId} className="border-t" style={{ borderColor: HAIR }}><td className="py-1.5 pr-3">{name(l)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap" style={{ color: l.unitAlert ? LATE : l.total == null ? '#9CA3AF' : undefined }}>{qtyTxt(l)}</td>
                        <td className="py-1.5 text-right tabular-nums whitespace-nowrap text-ink-light">{l.takenRecent ? `${fmtQty(l.takenRecent)} ${l.uom}` : '—'}</td></tr>))}</tbody>
                  </table></div>}
                </section>
              </div>}
            </div>);
        })}</div>}
    </div>
  );
}
