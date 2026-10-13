'use client';
// Notification bell for the purchasing role (Axel, 2026-10-09; shared + always visible 2026-10-12).
// Subscribes this device as pseudo-team 'purchasing' (pushes go by user id, see purchasingUserIds).
// Never hidden any more: when the browser can't do push (in-app browser such as Zalo, iPhone not
// added to the home screen) or notifications are blocked, the bell stays and a tap explains why.
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { pushSupport, getExistingPushSubscription, requestPushSubscription, unsubscribeCurrentPush } from '@/lib/push-client';

type LFn = (vi: string, en: string) => string;
type St = 'checking' | 'off' | 'on' | 'unsupported' | 'not-configured' | 'denied';

export default function PushBell({ L, compact = false }: { L: LFn; compact?: boolean }) {
  const [st, setSt] = useState<St>('checking');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    (async () => {
      const sup = pushSupport();
      if (sup !== 'ready') { if (!c) setSt(sup); return; }
      const sub = await getExistingPushSubscription();
      if (c) return;
      if (sub) setSt('on');
      else setSt(typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'denied' : 'off');
    })();
    return () => { c = true; };
  }, []);

  const why = (s: St) => s === 'unsupported'
    ? L('Trình duyệt này không nhận được thông báo (ví dụ mở từ Zalo). Hãy mở app bằng Chrome hoặc Samsung Internet rồi bấm lại.', 'This browser cannot receive notifications (e.g. opened from Zalo). Open the app in Chrome or Samsung Internet and tap again.')
    : s === 'denied'
      ? L('Thông báo đang bị chặn. Vào cài đặt trình duyệt > Trang web > Thông báo, cho phép trang này rồi bấm lại.', 'Notifications are blocked. Browser settings > Sites > Notifications: allow this site, then tap again.')
      : s === 'not-configured' ? L('Thông báo chưa được cấu hình trên máy chủ.', 'Notifications are not configured on the server.') : null;

  async function toggle() {
    setHint(null);
    if (st === 'unsupported' || st === 'not-configured') { setHint(why(st)); return; }
    if (busy || st === 'checking') return;
    setBusy(true);
    try {
      const { subscribePushAction, unsubscribePushAction } = await import('@/app/station/[team]/actions');
      if (st === 'on') {
        const ep = await unsubscribeCurrentPush();
        if (ep) await unsubscribePushAction(ep);
        setSt('off'); return;
      }
      const r = await requestPushSubscription();
      if (!r.ok) {
        const next: St = r.reason === 'denied' ? 'denied' : r.reason === 'not-configured' ? 'not-configured' : r.reason === 'unsupported' ? 'unsupported' : 'off';
        setSt(next);
        setHint(why(next) ?? L('Không bật được thông báo, thử lại.', 'Could not turn notifications on, try again.'));
        return;
      }
      const res = await subscribePushAction('purchasing', r.subscription);
      if (res.error) { setSt('off'); setHint(L('Không lưu được, thử lại.', 'Could not save, try again.')); return; }
      setSt('on');
    } finally { setBusy(false); }
  }

  const on = st === 'on';
  const dead = st === 'unsupported' || st === 'not-configured' || st === 'denied';
  const style = on ? { backgroundColor: '#ECFDF3', border: '1px solid #ABEFC6', color: '#067647' }
    : dead ? { backgroundColor: '#F3F4F6', border: '1px solid #E5E7EB', color: '#6B7280' }
    : { backgroundColor: '#FFF6E0', border: '1px solid #C9A227', color: '#8A5A00' };
  const label = on ? L('Thông báo: bật', 'Notifications on') : dead ? L('Thông báo: tắt', 'Notifications off') : L('Bật thông báo', 'Turn on notifications');
  const Icon = Bell;
  return (
    <span className="relative inline-flex">
      <button onClick={toggle} disabled={busy} aria-label={label} title={label}
        className={compact ? 'w-10 h-10 shrink-0 rounded-xl flex items-center justify-center' : 'inline-flex items-center gap-1.5 text-sm font-bold rounded-xl px-3 py-2'} style={style}>
        <Icon size={15} />{!compact && <> {label}</>}
      </button>
      {hint && (
        <span onClick={() => setHint(null)} className="absolute right-0 top-full mt-1.5 z-30 w-64 rounded-xl px-3 py-2 text-[12px] font-semibold leading-snug shadow-lg"
          style={{ backgroundColor: '#fff', border: '1px solid #E5E7EB', color: '#374151' }}>{hint}</span>
      )}
    </span>
  );
}
