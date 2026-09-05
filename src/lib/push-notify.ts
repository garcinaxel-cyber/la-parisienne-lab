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

// BUG FIX 2026-09-05 (Axel: aucune visibilite quand un envoi echoue — decouvert en diagnostiquant
// pourquoi son propre abonnement expire n'avait rien remonte nulle part avant qu'on aille
// fouiller directement Supabase). Toute erreur d'envoi finissait auparavant dans un `catch` vide
// — pas de log, pas de trace, rien. sendToSubs renvoie maintenant aussi le detail de chaque echec
// (pas seulement les 404/410 "morts") pour que l'appelant les journalise via logPushFailures.
type PushFailure = { endpoint: string; statusCode?: number; message: string };

// Sends one payload to a batch of subscription rows (any table with endpoint/p256dh/auth/lang
// columns), returning the ids the push service reports as gone (404/410) so the caller can
// clean them up from its own table — a subscription merely failing temporarily (network blip,
// 5xx) is left alone — plus every failure (dead or not) for logging.
async function sendToSubs(
  subs: { id: string; endpoint: string; p256dh: string; auth: string; lang?: string | null }[],
  payloadVi: PushPayload,
  payloadEn?: PushPayload,
): Promise<{ deadIds: string[]; failures: PushFailure[] }> {
  const deadIds: string[] = [];
  const failures: PushFailure[] = [];
  await Promise.all(subs.map(async (s) => {
    const payload = s.lang === 'en' && payloadEn ? payloadEn : payloadVi;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
    } catch (e: any) {
      const statusCode = e?.statusCode as number | undefined;
      if (statusCode === 404 || statusCode === 410) deadIds.push(s.id);
      // Endpoint kept short (last 24 chars) — enough to recognize which device without storing
      // the full push-service URL in a log table.
      failures.push({ endpoint: s.endpoint.slice(-24), statusCode, message: (e?.body || e?.message || String(e)).toString().slice(0, 300) });
    }
  }));
  return { deadIds, failures };
}

// Best-effort log of send failures — console.error for immediate visibility in Vercel logs, plus
// a row in lab_push_send_log so failures are queryable later instead of scrolling logs. Never
// throws: a logging hiccup must not turn into a push-path failure on top of the original one.
async function logPushFailures(
  supabase: SupabaseClient,
  scope: 'team' | 'shop' | 'admin',
  target: string,
  failures: PushFailure[],
): Promise<void> {
  if (!failures.length) return;
  console.error(`[push] ${failures.length} failure(s) sending to ${scope}:${target}`, JSON.stringify(failures));
  try {
    await supabase.from('lab_push_send_log').insert(
      failures.map(f => ({ scope, target, endpoint: f.endpoint, status_code: f.statusCode ?? null, error_message: f.message })),
    );
  } catch { /* logging itself must never break the send path */ }
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
    const { deadIds, failures } = await sendToSubs(subs, payloadVi, payloadEn);
    if (deadIds.length) await supabase.from('lab_push_subscriptions').delete().in('id', deadIds);
    await logPushFailures(supabase, 'team', team, failures);
  } catch (e: any) {
    await logPushFailures(supabase, 'team', team, [{ endpoint: '', message: (e?.message ?? String(e)).toString().slice(0, 300) }]);
  }
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
    const { deadIds, failures } = await sendToSubs(subs, payloadVi, payloadEn);
    if (deadIds.length) await supabase.from('lab_shop_push_subscriptions').delete().in('id', deadIds);
    await logPushFailures(supabase, 'shop', shopName, failures);
  } catch (e: any) {
    await logPushFailures(supabase, 'shop', shopName, [{ endpoint: '', message: (e?.message ?? String(e)).toString().slice(0, 300) }]);
  }
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
