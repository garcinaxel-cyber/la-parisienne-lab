'use server';
// Messenger inbox (Tin nhắn tab) — server actions. Axel, 2026-10-27: centralise the La Paris
// Facebook pages' conversations inside the online-sales screen instead of Pancake.
//
// Data comes from the inbox_* tables, filled OUTSIDE this app by Supabase Edge Functions
// (meta-webhook + meta-sync). Nothing here touches production/Odoo/lab tables: reads only, plus
// the unread counter on inbox_conversations. lab_customers is read (never written) to recognise a
// returning customer from a phone number found in the chat.
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient, getSafeSession } from '@/lib/supabase-server';

function service() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

async function requireInboxSession(write = false): Promise<{ userId: string; role: string } | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not signed in' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!profile || !['online_sales', 'admin', 'shop_manager'].includes(profile.role)) return { error: 'Not authorized' };
  if (write && profile.role === 'shop_manager') return { error: 'Read-only access' };
  return { userId: session.user.id, role: profile.role };
}

export type InboxPage = { pageId: string; name: string; channelLabel: string | null };
export type InboxConversation = {
  id: string; pageId: string; pageName: string; channelLabel: string | null;
  customerName: string | null; customerPic: string | null;
  lastAt: string | null; lastPreview: string | null; lastDirection: 'in' | 'out' | null;
  lastInboundAt: string | null; unread: number; fromAd: boolean; tagIds: string[];
};
export type InboxAttachment = { type: string; url: string | null; preview_url?: string | null; name?: string | null; mime_type?: string | null; expired?: boolean };
export type InboxMessage = { id: string; direction: 'in' | 'out'; text: string | null; attachments: InboxAttachment[] | null; sentAt: string; senderAppId: string | null };
export type InboxCustomerHint = { phones: string[]; known: { phone: string; name: string | null; address: string | null; district: string | null; orders: number; lastOrderAt: string | null } | null };

const CONV_FIELDS = 'id, page_id, customer_name, customer_pic, last_message_at, last_message_preview, last_direction, last_inbound_at, unread_count, ad_id';

export async function listInboxPagesAction(): Promise<{ pages?: InboxPage[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { data, error } = await db.from('inbox_pages').select('page_id, name, channel_label').eq('active', true).order('name');
  if (error) return { error: error.message };
  return { pages: (data ?? []).map((p: any) => ({ pageId: p.page_id, name: p.name, channelLabel: p.channel_label })) };
}

// Newest first, 30 at a time (index inbox_conv_last_idx / inbox_conv_page_last_idx).
export async function listInboxConversationsAction(opts: { pageId?: string | null; before?: string | null; unreadOnly?: boolean; search?: string | null; tagId?: string | null; waiting?: boolean }): Promise<{ conversations?: InboxConversation[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  // Tag filter: the conversations carrying that tag (bounded), newest tagged first.
  let tagConvIds: string[] | null = null;
  if (opts.tagId) {
    const { data: tc } = await db.from('inbox_conversation_tags').select('conversation_id').eq('tag_id', opts.tagId).order('created_at', { ascending: false }).limit(500);
    tagConvIds = (tc ?? []).map((r: any) => r.conversation_id);
    if (!tagConvIds.length) return { conversations: [] };
  }
  const [{ data: pages }, convRes] = await Promise.all([
    db.from('inbox_pages').select('page_id, name, channel_label'),
    (() => {
      let q = db.from('inbox_conversations').select(CONV_FIELDS).not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(30);
      if (opts.pageId) q = q.eq('page_id', opts.pageId);
      if (opts.before) q = q.lt('last_message_at', opts.before);
      if (opts.unreadOnly) q = q.gt('unread_count', 0);
      if (opts.waiting) q = q.eq('last_direction', 'in');
      if (tagConvIds) q = q.in('id', tagConvIds);
      const s = (opts.search ?? '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if (s) q = q.ilike('customer_name', `%${s}%`);
      return q;
    })(),
  ]);
  if (convRes.error) return { error: convRes.error.message };
  const ids = (convRes.data ?? []).map((c: any) => c.id);
  const tagsBy = new Map<string, string[]>();
  if (ids.length) {
    const { data: ct } = await db.from('inbox_conversation_tags').select('conversation_id, tag_id').in('conversation_id', ids);
    for (const r of ct ?? []) tagsBy.set(r.conversation_id, [...(tagsBy.get(r.conversation_id) ?? []), r.tag_id]);
  }
  const pageById = new Map((pages ?? []).map((p: any) => [p.page_id, p]));
  return {
    conversations: (convRes.data ?? []).map((c: any) => ({
      id: c.id, pageId: c.page_id, pageName: pageById.get(c.page_id)?.name ?? '', channelLabel: pageById.get(c.page_id)?.channel_label ?? null,
      customerName: c.customer_name, customerPic: c.customer_pic, lastAt: c.last_message_at, lastPreview: c.last_message_preview,
      lastDirection: c.last_direction, lastInboundAt: c.last_inbound_at, unread: c.unread_count ?? 0, fromAd: !!c.ad_id, tagIds: tagsBy.get(c.id) ?? [],
    })),
  };
}

export async function getInboxUnreadCountAction(): Promise<{ count?: number; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { count, error } = await db.from('inbox_conversations').select('id', { count: 'exact', head: true }).gt('unread_count', 0);
  if (error) return { error: error.message };
  return { count: count ?? 0 };
}

// Last 50 messages (or 50 before `before`), returned oldest -> newest for display.
export async function getInboxMessagesAction(conversationId: string, opts?: { before?: string | null; after?: string | null }): Promise<{ messages?: InboxMessage[]; hasMore?: boolean; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  let q = db.from('inbox_messages').select('id, direction, text, attachments, sent_at, sender_app_id').eq('conversation_id', conversationId);
  if (opts?.after) q = q.gt('sent_at', opts.after).order('sent_at', { ascending: true }).limit(100);
  else {
    q = q.order('sent_at', { ascending: false }).limit(51);
    if (opts?.before) q = q.lt('sent_at', opts.before);
  }
  const { data, error } = await q;
  if (error) return { error: error.message };
  let rows = data ?? [];
  let hasMore = false;
  if (!opts?.after) { hasMore = rows.length > 50; rows = rows.slice(0, 50).reverse(); }
  return {
    hasMore,
    messages: rows.map((m: any) => ({ id: m.id, direction: m.direction, text: m.text, attachments: m.attachments, sentAt: m.sent_at, senderAppId: m.sender_app_id })),
  };
}

export async function markInboxReadAction(conversationId: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { ok: true }; // read-only viewers simply don't clear the badge
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { error } = await db.from('inbox_conversations').update({ unread_count: 0 }).eq('id', conversationId).gt('unread_count', 0);
  if (error) return { error: error.message };
  return { ok: true };
}

// Phone numbers the customer typed in the chat (VN shapes), and whether one of them is already
// in the customer base (lab_customers, keyed on the last 9 digits like the rest of the app).
export async function getInboxCustomerHintAction(conversationId: string): Promise<{ hint?: InboxCustomerHint; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { data: msgs } = await db.from('inbox_messages').select('text').eq('conversation_id', conversationId).eq('direction', 'in').not('text', 'is', null).order('sent_at', { ascending: false }).limit(200);
  const found = new Set<string>();
  for (const m of msgs ?? []) {
    const matches = String(m.text).match(/(?:\+?84|0)[\s.\-]?\d(?:[\s.\-]?\d){8}/g) ?? [];
    for (const raw of matches) {
      let d = raw.replace(/\D/g, '');
      if (d.startsWith('84') && d.length === 11) d = '0' + d.slice(2);
      if (/^0[35789]\d{8}$/.test(d)) found.add(d);
    }
  }
  const phones = Array.from(found).slice(0, 3);
  let known: InboxCustomerHint['known'] = null;
  if (phones.length) {
    const keys = phones.map(p => p.slice(-9));
    const { data: cust } = await db.from('lab_customers').select('phone_key, customer_phone, customer_name, delivery_address, district, last_seen_at').in('phone_key', keys).order('last_seen_at', { ascending: false }).limit(1);
    const c = cust?.[0];
    if (c) {
      const { count } = await db.from('lab_online_orders').select('order_batch_id', { count: 'exact', head: true }).ilike('customer_phone', `%${c.phone_key}`).not('source', 'in', '(event_stock,event_void)');
      known = { phone: c.customer_phone ?? phones[0], name: c.customer_name, address: c.delivery_address, district: c.district, orders: count ?? 0, lastOrderAt: c.last_seen_at };
    }
  }
  return { hint: { phones, known } };
}

// ── Quick replies ("/" shortcuts, like Pancake) ── Axel, 2026-10-27. Shared by the whole team;
// online_sales + admin can edit, shop_manager reads. Images live in the public `inbox-media`
// bucket (menus to send with the text once sending from the app is open).
export type InboxQuickReply = { id: string; shortcut: string; body: string; images: string[]; needsImages: string | null; sort: number };

export async function listQuickRepliesAction(): Promise<{ replies?: InboxQuickReply[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { data, error } = await db.from('inbox_quick_replies').select('id, shortcut, body, images, needs_images, sort').eq('active', true).order('sort').order('shortcut');
  if (error) return { error: error.message };
  return { replies: (data ?? []).map((r: any) => ({ id: r.id, shortcut: r.shortcut, body: r.body, images: Array.isArray(r.images) ? r.images : [], needsImages: r.needs_images, sort: r.sort })) };
}

export async function saveQuickReplyAction(input: { id?: string | null; shortcut: string; body: string; images: string[] }): Promise<{ reply?: InboxQuickReply; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const shortcut = input.shortcut.trim().replace(/^\/+/, '').replace(/\s+/g, '').slice(0, 20);
  const body = input.body.trim().slice(0, 2000);
  if (!shortcut || /[^0-9A-Za-z\u00C0-\u1EF9_-]/.test(shortcut)) return { error: 'shortcut' };
  if (!body) return { error: 'body' };
  const images = (input.images ?? []).filter(u => typeof u === 'string' && u.startsWith('https://')).slice(0, 10);
  const { data: clash } = await db.from('inbox_quick_replies').select('id').eq('active', true).ilike('shortcut', shortcut.replace(/[%_]/g, '\\$&'));
  if ((clash ?? []).some((c: any) => c.id !== input.id)) return { error: 'duplicate' };
  const row: any = { shortcut, body, images, updated_at: new Date().toISOString(), updated_by: auth.userId };
  if (images.length) row.needs_images = null;
  const q = input.id
    ? db.from('inbox_quick_replies').update(row).eq('id', input.id)
    : db.from('inbox_quick_replies').insert({ ...row, sort: 500 });
  const { data, error } = await q.select('id, shortcut, body, images, needs_images, sort').single();
  if (error) return { error: error.message };
  return { reply: { id: data.id, shortcut: data.shortcut, body: data.body, images: data.images ?? [], needsImages: data.needs_images, sort: data.sort } };
}

export async function deleteQuickReplyAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  // soft delete: frees the shortcut, keeps history
  const { error } = await db.from('inbox_quick_replies').update({ active: false, updated_at: new Date().toISOString(), updated_by: auth.userId }).eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

// The browser shrinks photos to ≤1600 px JPEG before calling this (keeps under the 1 MB action limit).
export async function uploadQuickReplyImageAction(formData: FormData): Promise<{ url?: string; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: 'No file' };
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return { error: 'Only images' };
  if (file.size > 5 * 1024 * 1024) return { error: 'Too large' };
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `quick-replies/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error } = await db.storage.from('inbox-media').upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
  if (error) return { error: error.message };
  return { url: db.storage.from('inbox-media').getPublicUrl(path).data.publicUrl };
}

// ── Sending (text + photos/files) ── through the Supabase Edge Function meta-send, which holds the
// Meta tokens. Only online_sales + admin (shop_manager is read-only). Files go straight from the
// browser to Storage with a one-time signed upload URL (no size limit from server actions).
export type InboxOutAttachment = { type: 'image' | 'file' | 'video'; url: string; name?: string | null; mime_type?: string | null };

export async function sendInboxMessageAction(conversationId: string, text: string, attachments: InboxOutAttachment[]): Promise<{ ok?: boolean; error?: string; sent?: number }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const secret = process.env.INBOX_SEND_SECRET;
  if (!secret) return { error: 'Server not configured' };
  const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/meta-send`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ conversationId, text, attachments, userId: auth.userId }),
      cache: 'no-store',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error ?? 'meta', sent: j.sent ?? 0 };
    return { ok: true, sent: j.sent };
  } catch {
    return { error: 'network' };
  }
}

const OUT_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.ms-excel|text\/plain|video\/mp4)$/;

export async function createInboxUploadAction(fileName: string, mime: string, size: number): Promise<{ path?: string; token?: string; publicUrl?: string; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  if (!OUT_MIME.test(mime)) return { error: 'type' };
  if (size > 25 * 1024 * 1024) return { error: 'size' };
  const ext = (fileName.split('.').pop() ?? 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
  const path = `outbound/${new Date().toISOString().slice(0, 7)}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { data, error } = await db.storage.from('inbox-media').createSignedUploadUrl(path);
  if (error || !data) return { error: error?.message ?? 'upload' };
  return { path, token: data.token, publicUrl: db.storage.from('inbox-media').getPublicUrl(path).data.publicUrl };
}

// ── Tags (like Pancake) + conversation ↔ order link ── Axel, 2026-10-28.
// Manual tags are shared by the team. The auto tag "Đã tạo đơn" (kind auto_order) is added when an
// order is created from a conversation; each such order is also sent to Meta (dataset Laparis) as a
// "chat" purchase through the website (laparis.com.vn/api/meta/capi-chat) — never B2B/shop orders.
export type InboxTag = { id: string; name: string; color: string; kind: 'manual' | 'auto_order' };
export type InboxConvOrder = { orderBatchId: string; source: 'lab' | 'shop_stock'; value: number; createdAt: string };

export async function listInboxTagsAction(): Promise<{ tags?: InboxTag[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { data, error } = await db.from('inbox_tags').select('id, name, color, kind').eq('active', true).order('sort').order('name');
  if (error) return { error: error.message };
  return { tags: (data ?? []) as InboxTag[] };
}

const TAG_COLORS = ['#1F6B45', '#D9A21B', '#6B3FA0', '#2F6FB5', '#3E9B6A', '#4C7FD1', '#B5487A', '#8C5A3C', '#3AA6A0', '#C2410C', '#64748B'];

export async function createInboxTagAction(name: string, color?: string): Promise<{ tag?: InboxTag; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!n) return { error: 'name' };
  const c = color && TAG_COLORS.includes(color) ? color : TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)];
  const { data, error } = await db.from('inbox_tags').insert({ name: n, color: c, kind: 'manual', sort: 500 }).select('id, name, color, kind').single();
  if (error) return { error: error.code === '23505' ? 'duplicate' : error.message };
  return { tag: data as InboxTag };
}

export async function deleteInboxTagAction(id: string): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { error } = await db.from('inbox_tags').update({ active: false }).eq('id', id).eq('kind', 'manual');
  if (error) return { error: error.message };
  await db.from('inbox_conversation_tags').delete().eq('tag_id', id);
  return { ok: true };
}

export async function setConversationTagAction(conversationId: string, tagId: string, on: boolean): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { error } = on
    ? await db.from('inbox_conversation_tags').upsert({ conversation_id: conversationId, tag_id: tagId, created_by: auth.userId }, { onConflict: 'conversation_id,tag_id', ignoreDuplicates: true })
    : await db.from('inbox_conversation_tags').delete().eq('conversation_id', conversationId).eq('tag_id', tagId);
  if (error) return { error: error.message };
  return { ok: true };
}

export async function getConversationOrdersAction(conversationId: string): Promise<{ orders?: InboxConvOrder[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const { data, error } = await db.from('inbox_conversation_orders').select('order_batch_id, source, value, created_at').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(20);
  if (error) return { error: error.message };
  return { orders: (data ?? []).map((o: any) => ({ orderBatchId: o.order_batch_id, source: o.source, value: Number(o.value) || 0, createdAt: o.created_at })) };
}

export async function linkInboxOrderAction(input: { conversationId: string; orderBatchId: string; source: 'lab' | 'shop_stock'; value: number; phone: string | null; name: string | null }): Promise<{ ok?: boolean; error?: string }> {
  const auth = await requireInboxSession(true);
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const value = Math.max(0, Math.round(Number(input.value) || 0));
  const { data: conv } = await db.from('inbox_conversations').select('id, page_id').eq('id', input.conversationId).maybeSingle();
  if (!conv) return { error: 'conversation' };
  const { error } = await db.from('inbox_conversation_orders').insert({
    conversation_id: conv.id, order_batch_id: input.orderBatchId, source: input.source, value, created_by: auth.userId,
  });
  if (error) return { error: error.code === '23505' ? 'already' : error.message };
  const { data: autoTag } = await db.from('inbox_tags').select('id').eq('kind', 'auto_order').eq('active', true).limit(1).maybeSingle();
  if (autoTag) await db.from('inbox_conversation_tags').upsert({ conversation_id: conv.id, tag_id: autoTag.id, created_by: auth.userId }, { onConflict: 'conversation_id,tag_id', ignoreDuplicates: true });

  // Meta purchase (chat) — best effort, 5 s max, never blocks the order.
  let capi = 'skipped';
  const secret = process.env.CAPI_CHAT_SECRET;
  if (secret && value > 0) {
    const { data: page } = await db.from('inbox_pages').select('name').eq('page_id', conv.page_id).maybeSingle();
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch('https://www.laparis.com.vn/api/meta/capi-chat', {
        method: 'POST', signal: ctl.signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ eventId: input.orderBatchId, value, currency: 'VND', phone: input.phone, name: input.name, pageName: page?.name ?? null, eventTime: Math.floor(Date.now() / 1000) }),
      });
      const j = await r.json().catch(() => ({}));
      capi = j.ok ? 'sent' : `error: ${String(j.error ?? r.status).slice(0, 120)}`;
    } catch { capi = 'error: network'; } finally { clearTimeout(t); }
  }
  await db.from('inbox_conversation_orders').update({ capi_status: capi }).eq('order_batch_id', input.orderBatchId);
  return { ok: true };
}
