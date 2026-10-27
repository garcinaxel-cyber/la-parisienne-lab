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
  lastInboundAt: string | null; unread: number; fromAd: boolean;
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
export async function listInboxConversationsAction(opts: { pageId?: string | null; before?: string | null; unreadOnly?: boolean; search?: string | null }): Promise<{ conversations?: InboxConversation[]; error?: string }> {
  const auth = await requireInboxSession();
  if ('error' in auth) return { error: auth.error };
  const db = service(); if (!db) return { error: 'Server not configured' };
  const [{ data: pages }, convRes] = await Promise.all([
    db.from('inbox_pages').select('page_id, name, channel_label'),
    (() => {
      let q = db.from('inbox_conversations').select(CONV_FIELDS).not('last_message_at', 'is', null).order('last_message_at', { ascending: false }).limit(30);
      if (opts.pageId) q = q.eq('page_id', opts.pageId);
      if (opts.before) q = q.lt('last_message_at', opts.before);
      if (opts.unreadOnly) q = q.gt('unread_count', 0);
      const s = (opts.search ?? '').trim().replace(/[%,()]/g, ' ').slice(0, 60);
      if (s) q = q.ilike('customer_name', `%${s}%`);
      return q;
    })(),
  ]);
  if (convRes.error) return { error: convRes.error.message };
  const pageById = new Map((pages ?? []).map((p: any) => [p.page_id, p]));
  return {
    conversations: (convRes.data ?? []).map((c: any) => ({
      id: c.id, pageId: c.page_id, pageName: pageById.get(c.page_id)?.name ?? '', channelLabel: pageById.get(c.page_id)?.channel_label ?? null,
      customerName: c.customer_name, customerPic: c.customer_pic, lastAt: c.last_message_at, lastPreview: c.last_message_preview,
      lastDirection: c.last_direction, lastInboundAt: c.last_inbound_at, unread: c.unread_count ?? 0, fromAd: !!c.ad_id,
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
