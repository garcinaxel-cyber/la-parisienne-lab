'use client';
import { useState } from 'react';
import { Loader2, Check, X, Inbox } from 'lucide-react';
import { ExprInput } from './ui';
import { fmt, dmy, evalQty, GREEN, MUTED, FAINT, type Client, type LFn, type ProdLog } from './model';
import { receiveProductionAction } from '@/lib/oem-actions';

// Reception (Axel, 2026-09-26): every batch Hung declares must be received by an assistant
// before it can be packed. Once received, it is the assistants' responsibility — not Hung's.
// "Confirm" = the declared kg; "Less" = the kg really found (never more) + a reason.
export default function Reception({ client, prod, reload, L }: { client: Client; prod: ProdLog[]; reload: () => Promise<void>; L: LFn }) {
  const groups = new Map(client.groups.map(g => [g.key, g]));
  const pending = prod.filter(p => p.status === 'pending' && groups.has(p.group_key)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const [busy, setBusy] = useState<string | null>(null);
  const [less, setLess] = useState<{ id: string; kg: string; note: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!pending.length) return null;

  async function receive(id: string, kg: number | null, note: string | null) {
    setBusy(id); setMsg(null);
    const r = await receiveProductionAction(id, kg, note);
    setBusy(null);
    if (r.error) {
      setMsg(r.error === 'reason-required' ? L('Cần ghi lý do khi nhận ít hơn.', 'A reason is required when receiving less.')
        : r.error === 'more-than-declared' ? L('Không thể nhận nhiều hơn số Hưng đã khai.', 'Cannot receive more than Hưng declared.')
        : r.error === 'already-received' ? L('Mẻ này đã được nhận.', 'This batch was already received.') : r.error);
    } else setLess(null);
    await reload();
  }

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '2px solid #DC2626', backgroundColor: '#FEF2F2' }}>
      <div className="px-3.5 py-2.5 flex items-center gap-2" style={{ backgroundColor: '#DC2626', color: '#fff' }}>
        <Inbox size={16} />
        <span className="text-sm font-bold flex-1">{L('Cần nhận hàng', 'To receive')} · {pending.length}</span>
        <span className="text-[11px] opacity-90">{L('Bắt buộc trước khi đóng gói', 'Required before packing')}</span>
      </div>
      {msg && <div className="px-3.5 py-2 text-xs font-semibold" style={{ color: '#B91C1C' }}>{msg}</div>}
      {pending.map(p => {
        const g = groups.get(p.group_key)!;
        const isLess = less?.id === p.id;
        const lv = isLess ? evalQty(less!.kg) : null;
        const lessOk = isLess && lv !== null && !Number.isNaN(lv) && lv >= 0 && lv < Number(p.weight_kg) && less!.note.trim().length > 0;
        return (
          <div key={p.id} className="px-3.5 py-3 space-y-2 bg-white" style={{ borderTop: '1px solid #FBD5D5' }}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold leading-tight" style={{ color: '#111827' }}>{g.title}</div>
                <div className="text-[11px] mt-0.5" style={{ color: FAINT }}>
                  {p.created_by_name || '—'} · {dmy(p.prod_date)} {new Date(p.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold tabular-nums" style={{ color: '#111827' }}>{fmt(Number(p.weight_kg), 2)} kg</div>
                <div className="text-[10px]" style={{ color: FAINT }}>{L('Hưng khai', 'declared')}</div>
              </div>
            </div>
            {!isLess ? (
              <div className="flex gap-2">
                <button disabled={busy === p.id} onClick={() => receive(p.id, null, null)}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold text-white disabled:opacity-50" style={{ backgroundColor: GREEN }}>
                  {busy === p.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{L('Xác nhận', 'Confirm')} {fmt(Number(p.weight_kg), 2)} kg
                </button>
                <button onClick={() => setLess({ id: p.id, kg: '', note: '' })} className="rounded-xl px-3 py-2.5 text-sm font-bold" style={{ backgroundColor: '#fff', color: '#B91C1C', border: '1px solid #FBD5D5' }}>
                  {L('Ít hơn…', 'Less…')}
                </button>
              </div>
            ) : (
              <div className="space-y-2 rounded-xl p-2.5" style={{ backgroundColor: '#FEF7F7' }}>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex-1" style={{ color: MUTED }}>{L('Số kg thực nhận', 'Kg actually received')}</span>
                  <ExprInput className="w-40" value={less!.kg} unit="kg" onChange={v => setLess({ ...less!, kg: v })} />
                </div>
                <input value={less!.note} onChange={e => setLess({ ...less!, note: e.target.value })} placeholder={L('Lý do (bắt buộc)', 'Reason (required)')}
                  className="w-full h-9 rounded-lg px-2.5 text-sm" style={{ border: '1px solid #D1D5DB' }} />
                {lv !== null && !Number.isNaN(lv) && lv >= Number(p.weight_kg) && <div className="text-[11px] font-semibold" style={{ color: '#B91C1C' }}>{L('Phải ít hơn số đã khai — nếu bằng, bấm Xác nhận.', 'Must be less than declared — if equal, use Confirm.')}</div>}
                <div className="flex gap-2">
                  <button disabled={!lessOk || busy === p.id} onClick={() => receive(p.id, lv, less!.note)}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-bold text-white disabled:opacity-40" style={{ backgroundColor: '#B91C1C' }}>
                    {busy === p.id ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}{L('Nhận', 'Receive')} {lv !== null && !Number.isNaN(lv) ? `${fmt(lv, 2)} kg` : ''}
                  </button>
                  <button onClick={() => setLess(null)} className="rounded-xl px-3" style={{ backgroundColor: '#F3F4F6' }}><X size={16} /></button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
