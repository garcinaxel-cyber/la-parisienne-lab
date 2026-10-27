'use client';
// Tin nhắn tab (Messenger inbox) — Axel, 2026-10-27. Three columns on a computer (conversations /
// thread / customer), list -> thread on a phone. Data refreshes by light polling only while this
// tab is open (list every 20 s, open thread every 10 s), so the rest of the app is untouched.
// Replies are sent through the Edge Function meta-send (until Meta approves pages_messaging, only
// to people with a role on the Meta app). Replies sent from Pancake / Business Suite still appear here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2, ChevronLeft, FileText, Clock, ShoppingBag, Phone, Send, ImageIcon, Bell as AdIcon, Zap, X } from 'lucide-react';
import { createClient as createBrowserSupabase } from '@/lib/supabase-browser';
import * as inbox from './inbox-actions';
import type { InboxConversation, InboxMessage, InboxPage, InboxCustomerHint } from './inbox-actions';
import { NAVY, GOLD, CREAM, INK, INK_LIGHT, BORDER, useL } from './shared';
import type { InboxQuickReply } from './inbox-actions';
import { useQuickReplies, filterReplies, QuickReplyPopup, QuickReplyManager } from './QuickReplies';

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
    <div className="flex h-full" style={{ minHeight: 360 }}>
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

  // Poll for newer messages only (cheap: index on conversation_id, sent_at). Also called right
  // after a reply is sent from here.
  const msgsRef = useRef<InboxMessage[]>([]);
  msgsRef.current = msgs;
  const fetchNewer = useCallback(async (forceScroll = false) => {
    const cur = msgsRef.current;
    const last = cur[cur.length - 1]?.sentAt;
    const r = await inbox.getInboxMessagesAction(conv.id, last ? { after: last } : undefined);
    if (r.messages?.length) {
      setMsgs(prev => {
        const seen = new Set(prev.map(m => m.id));
        return [...prev, ...r.messages!.filter(m => !seen.has(m.id))];
      });
      if (forceScroll || stickToBottom.current) requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    }
  }, [conv.id]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') fetchNewer(); }, 10_000);
    return () => clearInterval(t);
  }, [fetchNewer]);

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
          <Composer readOnly={readOnly} conv={conv} onSent={() => fetchNewer(true)} />
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


// Reply box. "/" opens the team's quick replies (↑ ↓ Enter, or tap). Photos and files go straight
// to Storage (signed upload), then the Edge Function meta-send delivers text + attachments.
// Enter sends on a computer (Shift+Enter = new line); on a phone the Send button sends.
type PendingAtt = { id: string; kind: 'image' | 'file'; name: string; mime: string; status: 'uploading' | 'ready' | 'error'; url?: string; preview?: string };

async function shrinkForSend(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_500_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.88));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

function Composer({ readOnly, conv, onSent }: { readOnly: boolean; conv: InboxConversation; onSent: () => void }) {
  const { tr } = useL();
  const { replies } = useQuickReplies();
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<PendingAtt[]>([]);
  const [slash, setSlash] = useState<{ start: number; q: string } | null>(null);
  const [idx, setIdx] = useState(0);
  const [manage, setManage] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => (slash ? filterReplies(replies, slash.q).slice(0, 30) : []), [replies, slash]);

  const hours = conv.lastInboundAt ? (Date.now() - new Date(conv.lastInboundAt).getTime()) / 3600_000 : Infinity;
  const closed = hours >= 24 * 7;
  const uploading = atts.some(a => a.status === 'uploading');
  const ready = atts.filter(a => a.status === 'ready');
  const canSend = !readOnly && !closed && !sending && !uploading && (text.trim().length > 0 || ready.length > 0);

  function autosize() {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }
  useEffect(autosize, [text]);

  function detect(value: string, caret: number) {
    const m = value.slice(0, caret).match(/(^|\s)\/([^\s/]*)$/);
    if (m) { setSlash({ start: caret - m[2].length - 1, q: m[2] }); setIdx(0); } else setSlash(null);
  }

  function pick(r: InboxQuickReply) {
    if (!slash) return;
    const el = ta.current;
    const caret = el?.selectionStart ?? text.length;
    const first = (conv.customerName ?? '').trim().split(/\s+/).pop() ?? '';
    const body = r.body.replace(/\{ten\}/gi, first);
    setText(text.slice(0, slash.start) + body + text.slice(caret));
    setAtts(prev => [...prev, ...r.images.filter(u => !prev.some(a => a.url === u)).map(u => ({ id: u, kind: 'image' as const, name: 'menu.jpg', mime: 'image/jpeg', status: 'ready' as const, url: u, preview: u }))].slice(0, 10));
    const start = slash.start;
    setSlash(null);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const ph = body.indexOf('...');
      const pos = ph >= 0 ? start + ph : start + body.length;
      el.setSelectionRange(pos, ph >= 0 ? pos + 3 : pos);
    });
  }

  async function addFiles(files: FileList | null, kind: 'image' | 'file') {
    if (!files) return;
    setErr(null);
    const list = Array.from(files).slice(0, Math.max(0, 10 - atts.length));
    const sb = createBrowserSupabase();
    for (const raw of list) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const isImg = raw.type.startsWith('image/');
      const preview = isImg ? URL.createObjectURL(raw) : undefined;
      setAtts(prev => [...prev, { id, kind: isImg ? 'image' : kind === 'image' ? 'image' : 'file', name: raw.name, mime: raw.type, status: 'uploading', preview }]);
      (async () => {
        const file = await shrinkForSend(raw);
        const up = await inbox.createInboxUploadAction(file.name, file.type, file.size);
        if (!up.path || !up.token) {
          setAtts(prev => prev.map(a => a.id === id ? { ...a, status: 'error' } : a));
          setErr(up.error === 'size' ? tr('sendErrSize') : up.error === 'type' ? tr('sendErrType') : tr('sendErrUpload'));
          return;
        }
        const { error } = await sb.storage.from('inbox-media').uploadToSignedUrl(up.path, up.token, file, { contentType: file.type });
        setAtts(prev => prev.map(a => a.id === id ? (error ? { ...a, status: 'error' } : { ...a, status: 'ready', url: up.publicUrl, mime: file.type }) : a));
        if (error) setErr(tr('sendErrUpload'));
      })();
    }
    if (photoRef.current) photoRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
  }

  async function send() {
    if (!canSend) return;
    setSending(true); setErr(null);
    const payload = ready.map(a => ({ type: a.kind === 'image' ? 'image' as const : (a.mime === 'video/mp4' ? 'video' as const : 'file' as const), url: a.url!, name: a.name, mime_type: a.mime }));
    const r = await inbox.sendInboxMessageAction(conv.id, text, payload);
    setSending(false);
    if (r.ok) {
      atts.forEach(a => a.preview?.startsWith('blob:') && URL.revokeObjectURL(a.preview));
      setText(''); setAtts([]); onSent();
      requestAnimationFrame(() => ta.current?.focus());
      return;
    }
    if ((r.sent ?? 0) > 0) onSent();
    const map: Record<string, string> = {
      window: tr('sendErrWindow'), unavailable: tr('sendErrUnavailable'), permission: tr('sendErrPermission'),
      token: tr('sendErrToken'), disabled: tr('sendErrDisabled'),
    };
    setErr(map[r.error ?? ''] ?? tr('sendErrGeneric'));
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slash && items.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => (i + 1) % items.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => (i - 1 + items.length) % items.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(items[idx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
    }
    if (e.key === 'Escape') setSlash(null);
    const desktop = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
    if (e.key === 'Enter' && !e.shiftKey && desktop && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  }

  if (readOnly) return null;
  const iconBtn: React.CSSProperties = { width: 38, height: 38, borderRadius: 10, border: `1px solid ${BORDER}`, color: NAVY, flexShrink: 0 };

  return (
    <div className="flex flex-col gap-2">
      {closed && <div style={{ fontSize: 11.5, color: '#B42318', backgroundColor: '#FDECEA', borderRadius: 8, padding: '6px 10px' }}>{tr('sendWindowClosed')}</div>}
      {!closed && hours >= 24 && <div style={{ fontSize: 11.5, color: '#8A6D14', backgroundColor: CREAM, borderRadius: 8, padding: '6px 10px' }}>{tr('sendHumanAgent')}</div>}
      {atts.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pt-1">
          {atts.map(a => (
            <span key={a.id} className="relative flex-none">
              {a.kind === 'image' && a.preview
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={a.preview} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: `1px solid ${a.status === 'error' ? '#F2C6C2' : HAIR}`, opacity: a.status === 'uploading' ? 0.5 : 1 }} />
                : <span className="flex flex-col items-center justify-center gap-0.5 px-1" style={{ width: 96, height: 56, borderRadius: 8, border: `1px solid ${a.status === 'error' ? '#F2C6C2' : BORDER}`, fontSize: 10, color: INK, opacity: a.status === 'uploading' ? 0.5 : 1 }}>
                    <FileText size={15} color="#8A6D14" aria-hidden /><span className="truncate w-full text-center">{a.name}</span>
                  </span>}
              {a.status === 'uploading' && <span className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin" size={16} color={NAVY} /></span>}
              <button onClick={() => setAtts(atts.filter(x => x.id !== a.id))} aria-label={tr('qrRemoveImage')} className="absolute flex items-center justify-center"
                style={{ top: -5, right: -5, width: 20, height: 20, borderRadius: 10, backgroundColor: INK, color: '#fff' }}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      {err && <div role="alert" style={{ fontSize: 12, color: '#B42318' }}>{err}</div>}
      <div className="relative flex items-end gap-1.5">
        {slash && <QuickReplyPopup items={items} activeIndex={idx} onPick={pick} onHover={setIdx} />}
        <button onClick={() => setManage(true)} className="flex items-center justify-center" style={iconBtn} title={tr('qrTitle')} aria-label={tr('qrTitle')}><Zap size={17} aria-hidden /></button>
        <button onClick={() => photoRef.current?.click()} disabled={closed} className="flex items-center justify-center" style={iconBtn} title={tr('sendPhoto')} aria-label={tr('sendPhoto')}><ImageIcon size={17} aria-hidden /></button>
        <button onClick={() => fileRef.current?.click()} disabled={closed} className="hidden sm:flex items-center justify-center" style={iconBtn} title={tr('sendFile')} aria-label={tr('sendFile')}><FileText size={17} aria-hidden /></button>
        <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden onChange={e => addFiles(e.target.files, 'image')} />
        <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.mp4,image/*" multiple hidden onChange={e => addFiles(e.target.files, 'file')} />
        <label className="flex-1 min-w-0">
          <span className="sr-only">{tr('qrComposerPh')}</span>
          <textarea ref={ta} value={text} rows={1} placeholder={tr('qrComposerPh')} disabled={closed}
            onChange={e => { setText(e.target.value); detect(e.target.value, e.target.selectionStart); }}
            onKeyDown={onKey} onBlur={() => setTimeout(() => setSlash(null), 150)}
            onClick={e => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
            className="w-full outline-none block" style={{ minHeight: 38, maxHeight: 140, resize: 'none', borderRadius: 10, border: `1px solid ${BORDER}`, padding: '8px 10px', fontSize: 13.5, lineHeight: 1.4, color: INK, backgroundColor: closed ? PALE : '#fff' }} />
        </label>
        <button onClick={send} disabled={!canSend} title={tr('sendBtn')} aria-label={tr('sendBtn')} className="flex items-center justify-center"
          style={{ width: 42, height: 38, borderRadius: 10, backgroundColor: NAVY, color: '#FFFAEE', flexShrink: 0, opacity: canSend ? 1 : 0.4 }}>
          {sending ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} aria-hidden />}
        </button>
      </div>
      {manage && <QuickReplyManager readOnly={readOnly} onClose={() => setManage(false)} />}
    </div>
  );
}
