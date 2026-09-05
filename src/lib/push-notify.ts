// Server-side push sender (phase 3, 2026-09-04; phase 4, 2026-09-05). Mirrors zalo.ts's
// posture: best-effort, never throws into the caller — a push failure must never break the
// sync/publish path that creates the actual production card. Skips silently
// (pushConfigured() === false) until Axel sets VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY in Vercel, so
// shipping this file is safe before those env vars exist — nothing sends, nothing breaks.
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) { configured = false; return false; }
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@laparisienne.vn';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return ensureConfigured();
}

export type PushPayload = { title: string; body: string; url?: string };

// Sends one payload to a batch of subscription rows (any table with endpoint/p256dh/auth/lang
// columns), returning the ids the push service reports as gone (404/410) so the caller can
// clean them up from its own table — a subscription merely failing temporarily (network blip,
// 5xx) is left alone.
async function sendToSubs(
  subs: { id: string; endpoint: string; p256dh: string; auth: string; lang?: string | null }[],
  payloadVi: PushPayload,
  payloadEn?: PushPayload,
): Promise<string[]> {
  const deadIds: string[] = [];
  await Promise.all(subs.map(async (s) => {
    const payload = s.lang === 'en' && payloadEn ? payloadEn : payloadVi;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) deadIds.push(s.id);
    }
  }));
  return deadIds;
}

// Sends to every subscription on file for one chef/admin team. payloadEn (Axel, 2026-09-05:
// "notifs admin en anglais, je suis le seul pas viet") is used only for subscribers whose
// lang='en' (in practice just Axel's own all_teams account) — everyone else always gets
// payloadVi, and omitting payloadEn entirely (existing call sites) sends payloadVi to everyone,
// unchanged from before this column existed.
export async function sendTeamPush(
  supabase: SupabaseClient,
  team: string,
  payloadVi: PushPayload,
  payloadEn?: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) return;
  try {
    // team match OR a subscriber flagged push_all_teams on their profile (Axel, 2026-09-04:
    // wants every order notification regardless of team on his own account only).
    const { data: subs } = await supabase
      .from('lab_push_subscriptions')
      .select('id, endpoint, p256dh, auth, lang')
      .or(`team.eq.${team},all_teams.eq.true`);
    if (!subs?.length) return;
    const deadIds = await sendToSubs(subs, payloadVi, payloadEn);
    if (deadIds.length) await supabase.from('lab_push_subscriptions').delete().in('id', deadIds);
  } catch { /* best-effort — never let a push failure break the caller */ }
}

// Shop-scoped push (phase 4, 2026-09-05) — a separate table/function from sendTeamPush because
// a shop subscription is keyed by shop_name and one device can hold several (a manager covering
// two shops, e.g. Quan on Bà Triệu + Time City, activates once per shop portal on the same
// phone) — see lab_v67_notification_phase4 for why that table allows multiple rows per endpoint.
export async function sendShopPush(
  supabase: SupabaseClient,
  shopName: string,
  payloadVi: PushPayload,
  payloadEn?: PushPayload,
): Promise<void> {
  if (!ensureConfigured()) return;
  try {
    const { data: subs } = await supabase
      .from('lab_shop_push_subscriptions')
      .select('id, endpoint, p256dh, auth, lang')
      .eq('shop_name', shopName);
    if (!subs?.length) return;
    const deadIds = await sendToSubs(subs, payloadVi, payloadEn);
    if (deadIds.length) await supabase.from('lab_shop_push_subscriptions').delete().in('id', deadIds);
  } catch { /* best-effort */ }
}

// Reaches ONLY Axel's admin account (all_teams=true), independent of any real chef team, by
// piggy-backing on sendTeamPush's existing "team match OR all_teams" query with a pseudo-team
// no real subscriber ever uses. Used for admin copies of shop-side events (inventaire/réception
// terminés — Axel, 2026-09-05: "toi (admin)" + "la boutique elle-même") without inventing a
// second admin-specific notification path.
const ADMIN_RELAY_PSEUDO_TEAM = 'admin_shop_relay';
export async function sendAdminPush(
  supabase: SupabaseClient,
  payloadVi: PushPayload,
  payloadEn?: PushPayload,
): Promise<void> {
  await sendTeamPush(supabase, ADMIN_RELAY_PSEUDO_TEAM, payloadVi, payloadEn);
}
