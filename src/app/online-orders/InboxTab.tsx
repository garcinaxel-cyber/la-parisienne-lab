'use client';
// Tin nhắn tab (Messenger inbox) — Axel, 2026-10-27. Three columns on a computer (conversations /
// thread / customer), list -> thread on a phone. Data refreshes by light polling only while this
// tab is open (list every 20 s, open thread every 10 s), so the rest of the app is untouched.
// Sending is disabled until Meta approves pages_messaging (advanced access); replies sent from
// Pancake / Business Suite still appear here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, ChevronLeft, FileText, Clock, ShoppingBag, Phone, Send, ImageIcon, Bell as AdIcon } from 'lucide-react';
import * as inbox from './inbox-actions';
import type { InboxConversation, InboxMessage, InboxPage, InboxCustomerHint } from './inbox-actions';
import { NAVY, GOLD, CREAM, INK, INK_LIGHT, BORDER, useL } from './shared';

const HAIR = '#EFE9CF';
const PALE = '#FBF8EF';

export type InboxOrderPrefill = { customerName: string; customerPhone: string; deliveryAddress: string; district: string; channel: string };

function initials(name: string | null) {
  const parts = (name ?? '?').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
function timeLabel(iso: string | null, tr: (k: any) => string, lang: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'vi-VN', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return tr('inboxYesterday');
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { day: '2-digit', month: '2-digit' });
}
function dayKey(iso: string) { return new Date(iso).toDateString(); }

function Avatar({ name, pic, size = 40 }: { name: string | null; pic: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (pic && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={pic} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
  }
  return <div style={{ width: size, height: size, borderRadius: '50%', backgroundColor: HAIR, color: NAVY, fontWeight: 700, fontSize: size * 0.34, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initials(name)}</div>;
}

export default function InboxTab({ readOnly, onCreateOrder, onUnreadChange }: { readOnly: boolean; onCreateOrder: (p: InboxOrderPrefill) => void; onUnreadChange?: (n: number) => void }) {
  const { tr, lang } = useL();
  const [pages, setPages] = useState<InboxPage[]>([]);
  const [pageFilter, setPageFilter] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [convs, setConvs] = useState<InboxConversation[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [hasMoreConvs, setHasMoreConvs] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = useMemo(() => convs.find(c => c.id === activeId) ?? null, [convs, activeId]);

  useEffect(() => { inbox.listInboxPagesAction().then(r => r.pages && setPages(r.pages)); }, []);

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoadingList(true);
    const r = await inbox.listInboxConversationsAction({ pageId: pageFilter, unreadOnly, search });
    if (r.conversations) {
      setConvs(prev => {
        // keep older pages already loaded below the refreshed first page
        if (!silent) return r.conversations!;
        const fresh = new Map(r.conversations!.map(c => [c.id, c]));
        const tail = prev.filter(c => !fresh.has(c.id) && r.conversations!.length && c.lastAt && c.lastAt < (r.conversations![r.conversations!.length - 1].lastAt ?? ''));
        return [...r.conversations!, ...tail];
      });
      if (!silent) setHasMoreConvs(r.conversations.length === 30);
    }
    setLoadingList(false);
    const u = await inbox.getInboxUnreadCountAction();
    if (typeof u.count === 'number') onUnreadChange?.(u.count);
  }, [pageFilter, unreadOnly, search, onUnreadChange]);

  useEffect(() => {
    const t = setTimeout(() => loadList(false), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [loadList, search]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadList(true); }, 20_000);
    return () => clearInterval(t);
  }, [loadList]);

  async function loadMoreConvs() {
    const last = convs[convs.length - 1]?.lastAt;
    if (!last) return;
    const r = await inbox.listInboxConversationsAction({ pageId: pageFilter, unreadOnly, search, before: last });
    if (r.conversations) { setConvs(prev => [...prev, ...r.conversations!]); setHasMoreConvs(r.conversations.length === 30); }
  }

  function openConv(c: InboxConversation) {
    setActiveId(c.id);
    if (c.unread > 0 && !readOnly) {
      setConvs(prev => prev.map(x => x.id === c.id ? { ...x, unread: 0 } : x));
      inbox.markInboxReadAction(c.id).then(() => inbox.getInboxUnreadCountAction().then(u => typeof u.count === 'number' && onUnreadChange?.(u.count)));
    }
  }

  const chipStyle = (on: boolean): React.CSSProperties => ({
    height: 30, padding: '0 11px', borderRadius: 999, fontSize: 12, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap',
    backgroundColor: on ? NAVY : '#fff', color: on ? '#FFFAEE' : INK, border: `1px solid ${on ? NAVY : BORDER}`,
  });

  const list = (
    <div className="flex flex-col h-full" style={{ backgroundColor: PALE }}>
      <div className="px-3 pt-3 pb-2 flex flex-col gap-2">
        <label className="flex items-center gap-2 px-3" style={{ height: 38, background: '#fff', border: '1px solid #E8E1CC', borderRadius: 10 }}>
          <Search size={15} color={INK_LIGHT} aria-hidden />
          <span className="sr-only">{tr('inboxSearchPh')}</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('inboxSearchPh')} className="flex-1 bg-transparent outline-none" style={{ fontSize: 13, color: INK }} />
        </label>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          <button style={chipStyle(!pageFilter)} onClick={() => setPageFilter(null)}>{tr('inboxAll')}</button>
          {pages.map(p => <button key={p.pageId} style={chipStyle(pageFilter === p.pageId)} onClick={() => setPageFilter(p.pageId)}>{p.name}</button>)}
          <button style={chipStyle(unreadOnly)} onClick={() => setUnreadOnly(v => !v)}>{tr('inboxUnreadOnly')}</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loadingList && <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={20} color={NAVY} /></div>}
        {!loadingList && convs.length === 0 && <div className="text-center py-10" style={{ fontSize: 13, color: INK_LIGHT }}>{tr('inboxEmpty')}</div>}
        {!loadingList && convs.map(c => {
          const on = c.id === activeId;
          return (
            <button key={c.id} onClick={() => openConv(c)} className="w-full text-left flex gap-2.5 px-3 py-2.5"
              style={{ borderBottom: `1px solid ${HAIR}`, backgroundColor: on ? CREAM : c.unread ? '#fff' : 'transparent' }}>
              <Avatar name={c.customerName} pic={c.customerPic} />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="flex items-baseline gap-1.5">
                  <span className="flex-1 min-w-0 truncate" style={{ fontSize: 13.5, fontWeight: c.unread ? 700 : 500, color: INK }}>{c.customerName ?? '—'}</span>
                  <span style={{ fontSize: 11, color: INK_LIGHT }}>{timeLabel(c.lastAt, tr, lang)}</span>
                </span>
                <span className="truncate" style={{ fontSize: 12.5, color: c.unread ? INK : INK_LIGHT }}>
                  {c.lastDirection === 'out' ? tr('inboxYou') : ''}{c.lastPreview ?? ''}
                </span>
                <span className="flex gap-1 flex-wrap mt-0.5">
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: NAVY, border: '1px solid #C9D9CF', borderRadius: 4, padding: '0 6px' }}>{c.pageName}</span>
                  {c.fromAd && <span style={{ fontSize: 10.5, fontWeight: 600, color: '#8A6D14', backgroundColor: CREAM, borderRadius: 4, padding: '0 6px' }}>{tr('inboxFromAd')}</span>}
                </span>
              </span>
              {c.unread > 0 && (
                <span className="self-center flex items-center justify-center" style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: NAVY, color: '#FFFAEE', fontSize: 10.5, fontWeight: 700, padding: '0 5px' }}>{c.unread}</span>
              )}
            </button>
          );
        })}
        {!loadingList && hasMoreConvs && (
          <button onClick={loadMoreConvs} className="w-full py-3" style={{ fontSize: 12.5, fontWeight: 600, color: '#8A6D14' }}>{tr('inboxLoadMore')}</button>
        )}
      </div>
      <div className="px-3 py-1.5 flex items-center gap-1.5" style={{ fontSize: 10.5, color: INK_LIGHT, borderTop: `1px solid ${HAIR}` }}>
        <Clock size={11} aria-hidden /> {tr('inboxSyncNote')}
      </div>
    </div>
  );

  return (
    <div className="flex" style={{ height: 'calc(100vh - 62px - 58px)', minHeight: 420 }}>
      {/* Column 1 — on a phone it is hidden while a thread is open */}
      <div className={`${active ? 'hidden lg:flex' : 'flex'} flex-col w-full lg:w-[330px] lg:flex-none`} style={{ borderRight: `1px solid ${HAIR}` }}>
        {list}
      </div>
      {/* Column 2 + 3 */}
      <div className={`${active ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0`}>
        {active
          ? <Thread key={active.id} conv={active} readOnly={readOnly} onBack={() => setActiveId(null)} onCreateOrder={onCreateOrder} />
          : <div className="flex-1 flex items-center justify-center" style={{ fontSize: 13.5, color: INK_LIGHT, backgroundColor: PALE }}>{tr('inboxPick')}</div>}
      </div>
    </div>
  );
}

function ReplyWindow({ lastInboundAt }: { lastInboundAt: string | null }) {
  const { tr } = useL();
  if (!lastInboundAt) return null;
  const hours = (Date.now() - new Date(lastInboundAt).getTime()) / 3600_000;
  let text: string; let color = NAVY; let bg = '#EAF2EC';
  if (hours < 24) text = tr('inboxWindowLeft').replace('{h}', String(Math.max(1, Math.floor(24 - hours))));
  else if (hours < 24 * 7) { text = tr('inboxWindowHumanAgent'); color = '#8A6D14'; bg = CREAM; }
  else { text = tr('inboxWindowClosed'); color = '#B42318'; bg = '#FDECEA'; }
  return <span className="inline-flex items-center gap-1.5" style={{ fontSize: 11, color, backgroundColor: bg, borderRadius: 999, padding: '3px 10px' }}><Clock size={12} aria-hidden />{text}</span>;
}

function Thread({ conv, readOnly, onBack, onCreateOrder }: { conv: InboxConversation; readOnly: boolean; onBack: () => void; onCreateOrder: (p: InboxOrderPrefill) => void }) {
  const { tr, lang } = useL();
  const [msgs, setMsgs] = useState<InboxMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hint, setHint] = useState<InboxCustomerHint | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const r = await inbox.getInboxMessagesAction(conv.id);
      if (!alive) return;
      setMsgs(r.messages ?? []); setHasMore(!!r.hasMore); setLoading(false);
      requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
      const h = await inbox.getInboxCustomerHintAction(conv.id);
      if (alive && h.hint) setHint(h.hint);
    })();
    return () => { alive = false; };
  }, [conv.id]);

  // Poll for newer messages only (cheap: index on conversation_id, sent_at).
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const last = msgs[msgs.length - 1]?.sentAt;
      const r = await inbox.getInboxMessagesAction(conv.id, last ? { after: last } : undefined);
      if (r.messages?.length) {
        setMsgs(prev => {
          const seen = new Set(prev.map(m => m.id));
          return [...prev, ...r.messages!.filter(m => !seen.has(m.id))];
        });
        if (stickToBottom.current) requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [conv.id, msgs]);

  async function loadOlder() {
    const first = msgs[0]?.sentAt; if (!first) return;
    const el = scroller.current; const prevH = el?.scrollHeight ?? 0;
    const r = await inbox.getInboxMessagesAction(conv.id, { before: first });
    if (r.messages) {
      setMsgs(prev => [...r.messages!, ...prev]); setHasMore(!!r.hasMore);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevH; });
    }
  }

  function createOrder() {
    const k = hint?.known;
    onCreateOrder({
      customerName: k?.name || conv.customerName || '',
      customerPhone: k?.phone || hint?.phones[0] || '',
      deliveryAddress: k?.address || '',
      district: k?.district || '',
      channel: conv.channelLabel || '',
    });
  }

  const dayLabel = (iso: string) => {
    const d = new Date(iso); const now = new Date();
    if (d.toDateString() === now.toDateString()) return tr('inboxToday');
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return tr('inboxYesterday');
    return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };

  return (
    <>
      <div className="flex-1 min-w-0 flex flex-col" style={{ backgroundColor: PALE }}>
        <div className="flex items-center gap-2.5 px-3 lg:px-4 flex-wrap" style={{ minHeight: 58, backgroundColor: '#fff', borderBottom: `1px solid ${HAIR}` }}>
          <button onClick={onBack} className="lg:hidden flex items-center justify-center" style={{ width: 40, height: 40, color: NAVY }} aria-label={tr('inboxBack')}><ChevronLeft size={20} /></button>
          <Avatar name={conv.customerName} pic={conv.customerPic} size={36} />
          <div className="flex-1 min-w-0">
            <div className="truncate" style={{ fontWeight: 700, fontSize: 14.5, color: INK }}>{conv.customerName ?? '—'}</div>
            <div style={{ fontSize: 11.5, color: INK_LIGHT }}>{tr('inboxViaPage')} {conv.pageName}</div>
          </div>
          <div className="hidden sm:block"><ReplyWindow lastInboundAt={conv.lastInboundAt} /></div>
        </div>

        <div ref={scroller} onScroll={e => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
          className="flex-1 overflow-y-auto px-3 lg:px-5 py-4 flex flex-col gap-1.5">
          {loading && <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={20} color={NAVY} /></div>}
          {!loading && hasMore && <button onClick={loadOlder} className="self-center mb-2" style={{ fontSize: 12, fontWeight: 600, color: '#8A6D14' }}>{tr('inboxOlder')}</button>}
          {!loading && msgs.map((m, i) => {
            const newDay = i === 0 || dayKey(msgs[i - 1].sentAt) !== dayKey(m.sentAt);
            const out = m.direction === 'out';
            return (
              <div key={m.id} className="flex flex-col">
                {newDay && <div className="self-center my-2" style={{ fontSize: 11, color: INK_LIGHT }}>{dayLabel(m.sentAt)}</div>}
                <div className={`flex flex-col gap-1 ${out ? 'items-end' : 'items-start'}`}>
                  {(m.attachments ?? []).map((a, j) => (
                    a.expired ? <div key={j} style={{ fontSize: 12, color: INK_LIGHT, fontStyle: 'italic' }}>{tr('inboxImageExpired')}</div>
                    : a.type === 'image' && a.url ? (
                      <a key={j} href={a.url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.preview_url || a.url} alt="" loading="lazy" referrerPolicy="no-referrer"
                          style={{ maxWidth: 220, maxHeight: 220, borderRadius: 12, border: `1px solid ${HAIR}`, objectFit: 'cover', backgroundColor: HAIR }} />
                      </a>
                    ) : (
                      <a key={j} href={a.url ?? '#'} target="_blank" rel="noreferrer" className="flex items-center gap-2"
                        style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '8px 10px', fontSize: 12.5, color: INK, maxWidth: 260 }}>
                        <FileText size={16} color="#8A6D14" aria-hidden /><span className="truncate">{a.name ?? tr('inboxAttachment')}</span>
                      </a>
                    )
                  ))}
                  {m.text && (
                    <div style={{
                      maxWidth: '78%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13.5, lineHeight: 1.45, padding: '8px 12px',
                      backgroundColor: out ? NAVY : '#fff', color: out ? '#FFFAEE' : INK, border: out ? 'none' : `1px solid ${HAIR}`,
                      borderRadius: out ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                    }}>{m.text}</div>
                  )}
                  <div style={{ fontSize: 10.5, color: INK_LIGHT }}>{new Date(m.sentAt).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'vi-VN', { hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-3 lg:px-4 py-2.5 flex flex-col gap-2" style={{ backgroundColor: '#fff', borderTop: `1px solid ${HAIR}` }}>
          <div className="sm:hidden"><ReplyWindow lastInboundAt={conv.lastInboundAt} /></div>
          <div style={{ fontSize: 11.5, color: '#8A6D14', backgroundColor: CREAM, borderRadius: 8, padding: '6px 10px' }}>{tr('inboxReplySoon')}</div>
          <div className="flex items-center gap-2 opacity-50" aria-disabled>
            <span className="flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, color: NAVY }}><ImageIcon size={17} aria-hidden /></span>
            <span className="flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, color: NAVY }}><FileText size={17} aria-hidden /></span>
            <span className="flex-1 flex items-center px-3" style={{ height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 13, color: INK_LIGHT }}>…</span>
            <span className="flex items-center justify-center" style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: NAVY, color: '#FFFAEE' }}><Send size={16} aria-hidden /></span>
          </div>
          {!readOnly && (
            <button onClick={createOrder} className="lg:hidden flex items-center justify-center gap-2"
              style={{ height: 46, borderRadius: 12, backgroundColor: GOLD, color: NAVY, fontWeight: 700, fontSize: 14 }}>
              <ShoppingBag size={17} aria-hidden /> {tr('inboxCreateOrder')}
            </button>
          )}
        </div>
      </div>

      {/* Column 3 — customer (computer only) */}
      <div className="hidden lg:flex flex-col w-[320px] flex-none" style={{ backgroundColor: '#fff', borderLeft: `1px solid ${HAIR}` }}>
        <div className="px-4 py-4 flex flex-col gap-4 flex-1 overflow-y-auto">
          <div style={{ fontSize: 11, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em' }}>{tr('inboxCustomer')}</div>
          <div className="flex items-center gap-3">
            <Avatar name={conv.customerName} pic={conv.customerPic} size={48} />
            <div className="min-w-0">
              <div style={{ fontWeight: 700, fontSize: 15, color: INK }}>{conv.customerName ?? '—'}</div>
              <div style={{ fontSize: 12, color: INK_LIGHT }}>{conv.pageName}</div>
            </div>
          </div>
          {conv.fromAd && <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: '#8A6D14' }}><AdIcon size={14} aria-hidden /> {tr('inboxFromAd')}</div>}
          <div className="flex flex-col gap-1.5">
            <div style={{ fontSize: 11, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em' }}>{tr('inboxPhonesFound')}</div>
            {!hint && <Loader2 className="animate-spin" size={16} color={NAVY} />}
            {hint && hint.phones.length === 0 && <div style={{ fontSize: 12.5, color: INK_LIGHT }}>{tr('inboxNoPhone')}</div>}
            {hint && hint.phones.map(p => <div key={p} className="flex items-center gap-1.5" style={{ fontSize: 13, color: INK }}><Phone size={13} aria-hidden /> {p}</div>)}
          </div>
          {hint?.known && (
            <div style={{ border: `1px solid ${HAIR}`, borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: INK }}>
              <div className="flex items-center gap-1.5 mb-1"><span style={{ fontSize: 10.5, fontWeight: 600, color: '#8A6D14', backgroundColor: CREAM, borderRadius: 4, padding: '1px 6px' }}>{tr('inboxKnownCustomer')}</span>
                <span style={{ color: INK_LIGHT }}>{hint.known.orders} {tr('inboxOrdersCount')}</span></div>
              {hint.known.name && <div style={{ fontWeight: 600 }}>{hint.known.name}</div>}
              {hint.known.address && <div style={{ color: INK_LIGHT }}>{hint.known.address}{hint.known.district ? ` · ${hint.known.district}` : ''}</div>}
            </div>
          )}
        </div>
        {!readOnly && (
          <div className="p-4" style={{ borderTop: `1px solid ${HAIR}` }}>
            <button onClick={createOrder} className="w-full flex items-center justify-center gap-2"
              style={{ height: 46, borderRadius: 12, backgroundColor: GOLD, color: NAVY, fontWeight: 700, fontSize: 14 }}>
              <ShoppingBag size={17} aria-hidden /> {tr('inboxCreateOrder')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
